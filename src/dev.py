"""One entry point for everything in this repo.

Run it bare for a menu, or pass an action to skip straight to it:

    groups              # menu
    groups scenarios    # run the battery
    groups up           # start the gateway

The header is the useful part: it checks the four things that actually go
wrong — the plugin not loading, the gateway not running, the agents' context
missing, and a missing key — before you waste a run finding out.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys
import time

from rich.console import Console
from rich.table import Table
from rich.text import Text

from src import defaults
from src.context import SOUL
from src.group import ROOM
from src.defaults import GATEWAY_PORT

REPO = pathlib.Path(__file__).resolve().parents[1]
VENV = REPO / ".venv" / "bin"
# This project keeps its own Hermes home. Sharing ~/.hermes means our config,
# our keys and our session database land in the middle of whatever else the
# machine already uses Hermes for — and "delete everything" stops being a safe
# thing to say.
HOME = pathlib.Path(
    os.environ.get("HERMES_HOME") or (pathlib.Path(__file__).resolve().parents[1] / ".hermes")
)
os.environ["HERMES_HOME"] = str(HOME)
def _env_value(name: str) -> str:
    """Read one setting from the project's .env, so a local path can live there
    instead of being exported into every shell that runs a command."""
    env = HOME / ".env"
    if not env.exists():
        return ""
    for line in env.read_text().splitlines():
        if line.lstrip().startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() == name:
            return value.strip()
    return ""


OK, WARN, BAD, DIM = "#9aa878", "#c09a4e", "#a5453a", "#8a8078"
ACCENT = "#c4813f"

console = Console()


# ── checks ───────────────────────────────────────────────────────────────────

def _port_open(port: int = GATEWAY_PORT) -> bool:
    import socket

    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _port_bindable(port: int = GATEWAY_PORT) -> bool:
    """Can the port actually be taken right now?

    `_port_open` only says whether something is accepting connections, and a
    socket on its way down accepts nothing while still refusing to be rebound —
    which is how a restart raced into "address already in use" with the port
    apparently free. Binding it is the only honest test.
    """
    import socket

    # Deliberately WITHOUT SO_REUSEADDR: the gateway binds without it, so a
    # probe that sets it answers an easier question than the one that matters
    # and reports the port free while the gateway still cannot take it.
    #
    # Probed sparingly rather than in a tight loop — repeated bind-and-close on
    # the same address is what made an earlier version of this check keep the
    # gateway out of its own port.
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _gateway_pid() -> int | None:
    """The single-agent gateway, found by the port it holds.

    NOT by process name. Every agent in a group runs this same `hermes-groups`
    binary, so `pgrep -f hermes-groups` returned whichever one happened to come
    first — usually a group agent on 8700. That is the whole restart bug: down
    signalled a group agent, then waited ten seconds for a process it had never
    touched, and up then refused to start because "something" was still running.

    `group_down` already matched on the port for exactly this reason; this is
    the other half of that fix.
    """
    pids = _holders(GATEWAY_PORT)
    if pids:
        return pids[0]
    # Started but not listening yet. Anything holding a group port is one of the
    # group's agents, not this.
    group_pids = {p for a in _group() for p in _holders(a.port)}
    try:
        out = subprocess.run(
            ["pgrep", "-f", "hermes-groups"], capture_output=True, text=True
        ).stdout.split()
    except Exception:  # noqa: BLE001
        return None
    for pid in out:
        if pid.isdigit() and int(pid) not in group_pids:
            return int(pid)
    return None


def _env_names() -> set[str]:
    """Keys that are actually set.

    A name with nothing after the `=` is not a key. Counting it as one turned
    the status green while the gateway had nothing to authenticate with, which
    is the kind of check that costs somebody an afternoon.
    """
    env = HOME / ".env"
    if not env.exists():
        return set()
    names = set()
    for line in env.read_text().splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        name, _, value = line.partition("=")
        if value.strip():
            names.add(name.strip())
    return names


def _context_state() -> tuple[str, str]:
    """Is the agents' standing context there, and how big?

    It used to be checked for staleness against templates in another repository:
    a checkout somebody had to have, on a path recorded in a local .env, which
    is the kind of dependency that works until the day the folder moves. The
    files are this repo's now — ordinary Markdown, edited in place — so there is
    nothing to be stale against.
    """
    context = REPO / "context"
    if not context.is_dir():
        return BAD, "missing — there is no context/"
    files = [f for f in sorted(context.glob("*.md")) if f.name != SOUL]
    if not files:
        return BAD, "missing — context/ is empty"
    size = sum(f.stat().st_size for f in files)
    return OK, f"{size:,} chars across {len(files)} files"


def _config_state() -> tuple[str, str]:
    cfg = HOME / "config.yaml"
    if not cfg.exists():
        return BAD, "missing — run `pnpm setup`"
    text = cfg.read_text()
    missing = [
        need
        for need, present in (
            ("model", defaults.model_in(HOME) is not None),
            ("plugin enabled", "group-layer" in text),
            ("api_server", "api_server" in text),
        )
        if not present
    ]
    return (BAD, "missing " + ", ".join(missing)) if missing else (OK, "complete")


def _voice_on() -> bool:
    from src.policy import voice

    return voice.enabled()


def _voice_why() -> str:
    from src.policy import voice

    return voice.why_not()


def _group() -> list:
    from src.group import load_agents

    return load_agents(REPO)


def _group_up() -> bool:
    """Whether every agent in the group is answering."""
    agents = _group()
    return bool(agents) and all(_port_open(a.port) for a in agents)


def _holders(port: int) -> list[int]:
    out = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        capture_output=True,
        text=True,
    ).stdout.split()
    return [int(p) for p in out if p.isdigit()]


def group_down() -> None:
    """Stop every gateway in the group.

    Matched on the port rather than the process name: they are all the same
    binary, so killing by name would take the single-agent gateway with them.

    Every agent is signalled before any is waited on. Doing it one at a time
    meant a gateway that ignored SIGTERM blocked the ones behind it, which left
    a group half-up — and a half-up group opens a chat where one agent is
    silent for reasons that have nothing to do with the layer.
    """
    import signal

    agents = _group()
    pending = {a.name: _holders(a.port) for a in agents}
    for name, pids in pending.items():
        for pid in pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    for _ in range(20):
        time.sleep(0.5)
        pending = {
            a.name: _holders(a.port) for a in agents if _holders(a.port)
        }
        if not pending:
            break

    # A gateway that will not take a hint. Better a hard stop than a group that
    # cannot restart.
    for name, pids in pending.items():
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
                console.print(f"[{WARN}]{name} needed SIGKILL[/]")
            except ProcessLookupError:
                pass

    console.print(f"[{DIM}]stopped {len(agents)} agents[/]")


def _modes() -> dict[str, str]:
    """Every chat that is off the default, across every home.

    A group's mode is written into each agent's own home, so reading only the
    launcher's would report "every chat on the default" while three agents sat
    paused.
    """
    try:
        from src.policy import participation
    except Exception:  # noqa: BLE001
        return {}
    out = dict(participation.all_modes())
    for agent in _group():
        try:
            out.update(participation.all_modes(agent.home(REPO)))
        except Exception:  # noqa: BLE001
            pass
    return out


def _models_row() -> str:
    """What every home is actually configured with.

    One line, because the answer should never need four files opened by hand —
    and because when they disagree, that IS the thing worth seeing. The group
    silently ran a TTS model nobody had chosen for exactly as long as nothing
    printed it.
    """
    homes = [("runtime", HOME)] + [(a.name, a.home(REPO)) for a in _group()]
    chat = {defaults.model_in(h) for _, h in homes if defaults.model_in(h)}
    tts = {defaults.tts_model_in(h) for _, h in homes if defaults.tts_model_in(h)}
    if not chat:
        return ""
    parts = [" / ".join(sorted(chat)) if len(chat) > 1 else next(iter(chat))]
    if tts:
        parts.append(" / ".join(sorted(tts)) if len(tts) > 1 else next(iter(tts)))
    line = " · ".join(parts)
    return line + ("  — homes disagree" if len(chat) > 1 or len(tts) > 1 else "")


def status() -> None:
    pid = _gateway_pid()
    names = _env_names()
    ctx_style, ctx_note = _context_state()
    cfg_style, cfg_note = _config_state()
    trace = HOME / "group-trace.jsonl"

    rows = [
        (
            "model",
            (OK, _models_row()) if _models_row() else (BAD, "nothing configured"),
        ),
        (
            "gateway",
            (OK, f"up · pid {pid}") if pid and _port_open()
            else (WARN, "process up, port closed") if pid
            else (DIM, "down"),
        ),
        ("config", (cfg_style, cfg_note)),
        ("context", (ctx_style, ctx_note)),
        (
            "keys",
            (OK, "openrouter · api_server")
            if {"OPENROUTER_API_KEY", "API_SERVER_KEY"} <= names
            else (BAD, "missing " + ", ".join(
                sorted({"OPENROUTER_API_KEY", "API_SERVER_KEY"} - names)
            )),
        ),
        (
            "group",
            (OK, ", ".join(a.name for a in _group()) + " · up")
            if _group_up()
            else (DIM, f"{len(_group())} configured, not running")
            if _group()
            else (DIM, "none — `groups group` starts one"),
        ),
        (
            "voice",
            (OK, "replies are spoken")
            if _voice_on()
            else (DIM, f"text only — {_voice_why()}"),
        ),
        (
            "modes",
            (WARN, ", ".join(f"{k}={v}" for k, v in _modes().items()))
            if _modes()
            else (DIM, "every chat on the default (mentions-only)"),
        ),
        (
            "trace",
            (OK, f"{sum(1 for _ in trace.open()):,} events")
            if trace.exists()
            else (DIM, "nothing recorded yet"),
        ),
    ]

    t = Table(box=None, pad_edge=False, show_header=False)
    t.add_column(width=11, style=DIM)
    t.add_column()
    for label, (style, note) in rows:
        t.add_row(label, Text(note, style=style))
    console.print(t)


# ── the room ─────────────────────────────────────────────────────────────────────────


def _api_key() -> str | None:
    key = os.environ.get("API_SERVER_KEY")
    if key:
        return key
    env = HOME / ".env"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        if line.startswith("API_SERVER_KEY="):
            return line.split("=", 1)[1].strip()
    return None


def new_dm() -> str | None:
    """Open a chat and hand it back, so `debug` can go straight into it."""
    import json
    import urllib.request

    key = _api_key()
    if not key:
        return None
    name = f"chat-{int(time.time())}"
    req = urllib.request.Request(
        f"http://127.0.0.1:{GATEWAY_PORT}/api/sessions",
        data=json.dumps({"session_id": name}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=10).read()
        return name
    except Exception:  # noqa: BLE001
        return None


# ── actions ──────────────────────────────────────────────────────────────────

def _clear() -> None:
    """Clear the screen AND the scrollback.

    Rich's `console.clear()` only wipes what is visible: every screen this menu
    ever drew stays above the top of the window, so opening a log four times
    leaves four logs stacked in the buffer, and copying the terminal hands you
    all of them. `3J` is the code that drops the saved lines: the difference
    between a cleared screen and a cleared terminal.
    """
    print("\033[H\033[2J\033[3J", end="", flush=True)


def _pause() -> None:
    """Wait for the reader before redrawing. Ctrl-C here means "go back", not
    "crash"."""
    try:
        console.input(f"\n[{DIM}]enter to go back[/]")
    except (EOFError, KeyboardInterrupt):
        console.print()


def _py(*args: str) -> list[str]:
    """A command run through this venv's interpreter."""
    return [str(VENV / "python"), *args]


def _run(*cmd_parts: str, background: bool = False, env_extra: dict | None = None) -> None:
    """Run a fully-formed command.

    Takes the command as given rather than guessing whether to prepend the
    interpreter — guessing by "does the first argument end in .py" silently
    broke `groups test`, whose first argument is `-m`.
    """
    cmd = list(cmd_parts)
    env = {**os.environ, **(env_extra or {})}
    if background:
        log = pathlib.Path("/tmp/hermes-groups.log")
        with log.open("a") as fh:
            subprocess.Popen(
                cmd, stdout=fh, stderr=fh, cwd=REPO,
                env={**os.environ, "HERMES_GROUP_TRACE": "1", "HERMES_HOME": str(HOME)},
            )
        console.print(f"[{DIM}]started · logging to {log}[/]")
        return
    try:
        subprocess.run(cmd, cwd=REPO, env=env)
    except KeyboardInterrupt:
        # Ctrl-C reaches the whole process group, so the child is already gone
        # by the time this lands. Leaving it to propagate turned "quit the chat"
        # into a stack trace and took the menu down with it.
        console.print()


ENV_TEMPLATE = """# Put your provider key here. Any OpenAI-compatible provider
# Hermes supports works; this is the one the default model needs.
OPENROUTER_API_KEY=

# Generated. This endpoint dispatches terminal-capable agent work, so a
# guessable key is remote code execution — the gateway refuses anything short.
API_SERVER_KEY={key}

# The folder of Markdown the agents read as their standing context, per turn.
HERMES_GROUP_CONTEXT={context}

# What the agent answers to.
HERMES_AGENT_NAME=agent

# Speak every reply. Needs both: the switch alone does nothing, and the status
# line says which half is missing.
# ELEVENLABS_API_KEY=
# SPEAK_REPLIES=1

"""


def init() -> None:
    """Create this project's Hermes home, without overwriting anything.

    Everything it writes is gitignored, which is why a fresh clone has none of
    it. The agents' context is not generated: `context/` is committed and
    edited by hand, so a clone has it already.
    """
    HOME.mkdir(parents=True, exist_ok=True)

    config = HOME / "config.yaml"
    if config.exists():
        # Left alone except for the models, which live in one place and are
        # pointed at it from there. Everything else in this file is the user's.
        moved = defaults.align(HOME)
        console.print(
            f"[{DIM}]config.yaml already there, {moved or 'left alone'}[/]"
        )
    else:
        config.write_text(
            defaults.config_for(
                GATEWAY_PORT, headline="The group layer on upstream Hermes."
            )
        )
        console.print(f"[{OK}]wrote {config}[/]")

    env = HOME / ".env"
    if env.exists():
        console.print(f"[{DIM}].env already there, left alone[/]")
    else:
        import secrets

        env.write_text(
            ENV_TEMPLATE.format(
                key=secrets.token_hex(32),
                context=REPO / "context",
            )
        )
        console.print(f"[{OK}]wrote {env}[/] [{DIM}](with a generated API_SERVER_KEY)[/]")

    soul = HOME / "SOUL.md"
    if not soul.exists():
        soul.write_text((REPO / "context" / "SOUL.md").read_text())
        console.print(f"[{OK}]wrote {soul}[/]")

    names = _env_names()
    if "OPENROUTER_API_KEY" not in names or not (
        (HOME / ".env").read_text().partition("OPENROUTER_API_KEY=")[2].split("\n")[0].strip()
    ):
        console.print(
            f"\n[{WARN}]one thing left:[/] put a provider key in "
            f"[{DIM}]{env}[/] and run [{DIM}]pnpm start[/]"
        )


def _wait(note: str, ready, seconds: float = 10.0) -> bool:
    """Poll for something, with the waiting on screen.

    Stopping and starting takes seconds, and the menu clears the terminal
    before it runs — so a silent wait is a black screen that looks crashed.
    Anything here that can take longer than a blink says what it is waiting for
    while it waits.
    """
    with console.status(f"[{DIM}]{note}…[/]", spinner="dots"):
        for _ in range(int(seconds * 2)):
            time.sleep(0.5)
            if ready():
                return True
    return False


def _free() -> bool:
    """Nothing listening on the gateway port, and the port can be taken again."""
    return not _holders(GATEWAY_PORT) and _port_bindable(GATEWAY_PORT)


def up() -> bool:
    if _port_open(GATEWAY_PORT):
        console.print(f"[{WARN}]already running[/] [{DIM}]· pid {_gateway_pid()}[/]")
        return True

    # The models live in one place; this is where a home that has drifted from
    # it is pointed back, because a process that is about to start is the last
    # moment its config can still be read.
    moved = defaults.align(HOME)
    if moved:
        console.print(f"[{DIM}]{moved}[/]")
    # The previous gateway can be gone as a process and still hold the socket
    # for a moment while it drains. Starting into that is a non-retryable
    # conflict for the gateway, so wait for the port rather than hand it one.
    if not _port_bindable(GATEWAY_PORT) and not _wait(
        f"waiting for {GATEWAY_PORT} to come free", _free
    ):
        console.print(f"[{WARN}]port {GATEWAY_PORT} is still held — not starting[/]")
        return False

    _run(str(VENV / "hermes-groups"), "-v", background=True)
    if _wait("waiting for it to listen", lambda: _port_open(GATEWAY_PORT), 20):
        console.print(f"[{OK}]listening on 127.0.0.1:{GATEWAY_PORT}[/]")
        return True
    console.print(f"[{BAD}]did not come up — check /tmp/hermes-groups.log[/]")
    return False


def down() -> bool:
    """Stop the single-agent gateway. True when the port is free afterwards.

    SIGTERM first, then SIGKILL if it will not take the hint — the same
    escalation `group_down` does. Stopping at SIGTERM is what left the old
    process holding the port and turned the next `up` into "already running"
    forever.
    """
    import signal

    pids = _holders(GATEWAY_PORT)
    if not pids:
        if _free():
            console.print(f"[{DIM}]not running[/]")
            return True
        return _wait(f"waiting for {GATEWAY_PORT} to come free", _free)

    listed = ", ".join(str(p) for p in pids)
    console.print(f"[{DIM}]sigterm → {listed}[/]")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if _wait("draining", _free):
        console.print(f"[{DIM}]stopped {listed}[/]")
        return True

    console.print(f"[{WARN}]still up after 10s — sigkill[/]")
    for pid in _holders(GATEWAY_PORT):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if _wait("waiting for the port", _free):
        console.print(f"[{DIM}]killed {listed}[/]")
        return True

    still = ", ".join(str(p) for p in _holders(GATEWAY_PORT)) or "something"
    console.print(f"[{BAD}]{GATEWAY_PORT} is still held by {still}[/]")
    return False


# Named commands. The picker offers categories, not this list.
def restart() -> None:
    """Stop and start. The gateway is a long-running process, so nothing under
    `src/` reaches it until it comes back up — which is most of what you
    edit."""
    if not down():
        console.print(f"[{DIM}]not starting a second one on a held port[/]")
        return
    up()


ACTIONS: dict[str, tuple[str, object]] = {
    "up": ("start the runtime", up),
    "down": ("stop it", down),
    "restart": ("stop and start — what picks up a code change", restart),
    "status": ("the checks", status),
    "init": ("create this project's Hermes home", init),
    "group": ("a chat with several agents in it",
              lambda: _run(*_py("scripts/group.py"))),
    "group:up": ("start one gateway per agent",
                 lambda: _run(*_py("scripts/group_up.py"))),
    "group:down": ("stop them", lambda: group_down()),
    "test": ("the unit tests", lambda: _run(*_py("-m", "pytest", "-q"))),
}
ALL = ACTIONS


def _status_text() -> str:
    """The status block as a plain string, for the picker header."""
    with console.capture() as cap:
        status()
    return cap.get().rstrip()


def pick(prompt: str, header: str, entries: list[tuple[str, str]]) -> str | None:
    """The picker: fzf when it is there, a numbered list when it is not.

    Entries are ``key\tdisplay`` so the visible column can be padded and
    described while the returned value stays a stable key.
    """
    lines = [f"{key}\t{display}" for key, display in entries]

    if shutil.which("fzf"):
        proc = subprocess.run(
            [
                "fzf",
                "--delimiter=\t",
                "--with-nth=2..",
                "--no-multi",
                "--no-info",
                "--height=60%",
                "--reverse",
                "--ansi",
                f"--prompt={prompt}",
                f"--header={header}",
            ],
            input="\n".join(lines),
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return None
        return proc.stdout.split("\t", 1)[0].strip()

    # No fzf — numbered fallback.
    console.print(header)
    console.print()
    for i, (_, display) in enumerate(entries, 1):
        console.print(f"[{DIM}]{i:>3}[/]  {display}")
    try:
        choice = console.input(f"\n[{DIM}]{prompt}[/]").strip()
    except (EOFError, KeyboardInterrupt):
        return None
    if choice.isdigit() and 1 <= int(choice) <= len(entries):
        return entries[int(choice) - 1][0]
    return choice or None


def group_menu() -> None:
    """Start the group if it is not up, then open the room.

    There is one room, so there is nothing to pick. This used to offer a list
    of chats and a way to make another, which meant every visit to the menu
    could mint one and pay an introduction round for it — and then leave you
    wondering which of six rooms the log you were reading belonged to.
    """
    _clear()
    if not (REPO / "group.json").exists() or not _group_up():
        ACTIONS["group:up"][1]()
    # Opening the room regardless is how a half-up group turned into a blank
    # screen: the missing agent is simply silent, and nothing says why.
    if not _group_up():
        missing = [a.name for a in _group() if not _port_open(a.port)]
        console.print(
            f"\n[{BAD}]not starting: {', '.join(missing)} did not come up[/]"
            f" [{DIM}]— see /tmp/group-<name>.log[/]"
        )
        _pause()
        return

    _clear()
    _run(*_py("scripts/group.py"))
    _pause()


def debug_menu(replay: bool = False) -> None:
    """The room's log, from all three agents at once, live from now.

    There is nothing to pick: one room means opening the log IS the request.
    What you almost always want is what happens NEXT — you open it to watch a
    turn you are about to provoke, and a screen that starts on hours of backlog
    buries it. `--replay` starts from the top instead.

    Read from all three homes together, because each traces into its own and
    the interesting thing about a group turn is which of them spoke and which
    stayed quiet, which is only visible side by side.
    """
    args = ["scripts/tui.py", "--session", ROOM]
    if replay:
        args.insert(1, "--replay")
    for agent in _group():
        args += ["--agent", f"{agent.name}={agent.home(REPO)}"]
    _clear()
    _run(*_py(*args))
    _pause()


CATEGORIES: list[tuple[str, str]] = [
    ("group", "group     talk to the room"),
    ("debug", "debug     watch the room's log, live"),
    ("replay", "replay    the room's log from the top"),
    ("runtime", "runtime   start, stop, restart"),
    ("quit", "quit"),
]

# Everything that acts on the gateway process, in one place. The top level is
# about conversations; this is about the thing they run on, and three near-
# identical verbs sitting among them made the menu read as a list of unrelated
# commands rather than two kinds of thing.
RUNTIME: list[tuple[str, str]] = [
    ("up", "up        start it"),
    ("down", "down      stop it"),
    ("restart", "restart   stop and start, to pick up a code change"),
    ("\0back", "back"),
]


def runtime_menu() -> None:
    while True:
        _clear()
        choice = pick("runtime> ", _status_text(), RUNTIME)
        if choice in (None, "\0back"):
            return
        if choice not in ACTIONS:
            continue
        _clear()
        ACTIONS[choice][1]()
        _pause()


def menu() -> None:
    while True:
        _clear()
        choice = pick("groups> ", _status_text(), CATEGORIES)
        if choice in (None, "quit"):
            return
        if choice == "debug":
            debug_menu()
            continue
        if choice == "replay":
            debug_menu(replay=True)
            continue
        if choice == "group":
            group_menu()
            continue
        if choice == "runtime":
            runtime_menu()
            continue
        if choice not in ACTIONS:
            continue
        _clear()
        ACTIONS[choice][1]()
        _pause()


def main() -> None:
    if not shutil.which("pgrep"):
        console.print(f"[{WARN}]pgrep not found — gateway status will read as down[/]")
    try:
        _main()
    except KeyboardInterrupt:
        # A clean quit, not a failure: exiting non-zero here made every wrapper
        # around it report a broken command.
        console.print()


def _main() -> None:
    if len(sys.argv) > 1:
        name = sys.argv[1]
        if name in {"status", "-s"}:
            status()
            return
        if name not in ALL:
            console.print(f"unknown action {name!r} — one of: {', '.join(ALL)}")
            raise SystemExit(2)
        ALL[name][1]()
        return
    menu()


if __name__ == "__main__":
    main()
