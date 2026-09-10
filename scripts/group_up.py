#!/usr/bin/env python3
"""Stand up a group of agents, one gateway each.

    scripts/group_up.py Anna Jordan Pepe

Creates a Hermes home per agent, starts a gateway per agent, and writes
`group.json` so the chat client knows where they live. Idempotent: an agent that
already has a home keeps it, and one whose port is already answering is left
alone.

Each gets its own home because that is what makes them separate agents. Sharing
one would give them the same memory and the same history — three names on one
mind, which is not the thing being demonstrated.
"""

from __future__ import annotations

import json
import os
import pathlib
import secrets
import shutil
import socket
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import defaults  # noqa: E402
from src.defaults import FIRST_GROUP_PORT, gateway_binary  # noqa: E402
from src.group import Agent, env_for  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[1]

# Where the agents keep what they are, as opposed to where the code lives.
#
# Locally the two are the same directory and nothing has to say so. In a
# container they are not: the code is baked into the image and replaced on every
# deploy, while the homes hold the memory, the drawn personas and the session
# databases, and have to survive one. So the homes and the `group.json` that
# describes them move to a mounted volume, and `context/` stays with the code
# because it is read-only and belongs to the version that shipped.
STATE = pathlib.Path(os.environ.get("HERMES_GROUP_STATE") or REPO)

# What an agent needs to speak, taken from the project's own home. Both, or
# neither: the switch without a key is a setting that silently does nothing.
VOICE_SETTINGS = ("ELEVENLABS_API_KEY", "SPEAK_REPLIES")

DIM, BOLD, OK, WARN, OFF = "\033[2m", "\033[1m", "\033[38;5;107m", "\033[38;5;173m", "\033[0m"

def answering(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def bindable(port: int) -> bool:
    """Can the port actually be taken right now?

    `answering` only says whether something accepts connections, and a gateway
    on its way down accepts nothing while still holding the socket. Starting
    into that gap is a NON-RETRYABLE conflict — the new gateway logs "address
    already in use" and exits — so a restart quietly came back with one agent
    missing.

    Deliberately without SO_REUSEADDR: the gateway binds without it, so a probe
    that sets it answers an easier question than the one that matters.
    """
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def wait_for_port(port: int, seconds: float = 10.0) -> bool:
    for _ in range(int(seconds * 2)):
        if bindable(port):
            return True
        time.sleep(0.5)
    return False


def base_settings() -> dict[str, str]:
    """The provider key and model from the project's own home, so a group does
    not need its credentials configured three more times.

    The environment wins over the file. Locally there is a `.hermes/.env` and no
    exported keys; in a container there is no such file and the platform hands
    them in as environment variables. Reading both, in that order, is what lets
    one function serve both without a flag saying which world it is in.
    """
    env = REPO / ".hermes" / ".env"
    out: dict[str, str] = {}
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                out[key.strip()] = value.strip()
    for name in ("OPENROUTER_API_KEY", *VOICE_SETTINGS):
        value = os.environ.get(name, "").strip()
        if value:
            out[name] = value
    return out


def provision(agent: Agent, settings: dict[str, str]) -> None:
    home = agent.home(STATE)
    home.mkdir(parents=True, exist_ok=True)

    config = home / "config.yaml"
    if not config.exists():
        config.write_text(
            defaults.config_for(
                agent.port,
                headline=f"{agent.name}, one agent of a group. Its name, memory "
                "and port are its own.",
                model=defaults.DEFAULT_MODEL,
            )
        )

    # One place names the model, and every home is pointed at it here rather
    # than keeping whatever it was created with. A config.yaml is generated
    # state in a gitignored directory, not somewhere anybody keeps notes, and
    # leaving four of them free to disagree is how changing the model became
    # editing four files and forgetting one.
    moved = defaults.align(home)
    if moved:
        print(f"  {DIM}{agent.name}: {moved}{OFF}")

    env = home / ".env"
    if not env.exists():
        lines = [
            f"OPENROUTER_API_KEY={settings.get('OPENROUTER_API_KEY', '')}",
            f"API_SERVER_KEY={agent.key}",
            f"HERMES_AGENT_NAME={agent.name}",
            f"HERMES_GROUP_CONTEXT={REPO / 'context'}",
        ]
        env.write_text("\n".join(lines) + "\n")

    # The standing context used to live in context/agent/ and now lives in
    # context/ itself. A home written before the move points at a folder that
    # is no longer there, and a missing context folder reads as an empty one —
    # the agent boots, answers, and simply knows none of the contract, with
    # nothing on screen to say so. Repointed in place; everything else in the
    # file is left exactly as the home had it.
    current = env.read_text().splitlines()
    want = f"HERMES_GROUP_CONTEXT={REPO / 'context'}"
    if any(line.startswith("HERMES_GROUP_CONTEXT=") and line != want for line in current):
        env.write_text(
            "\n".join(
                want if line.startswith("HERMES_GROUP_CONTEXT=") else line
                for line in current
            )
            + "\n"
        )
        print(f"  {DIM}{agent.name}: repointed its context at {REPO / 'context'}{OFF}")

    # An agent reads its voice settings from its OWN home, like everything else
    # it needs. These used to reach it only by being exported into whatever
    # shell happened to launch the group, so starting it from anywhere else
    # took the voice away silently — the replies simply came back as text and
    # nothing said why. Copied in, never overwritten: a home that has its own
    # answer keeps it.
    present = {
        line.partition("=")[0].strip()
        for line in env.read_text().splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    }
    missing = [k for k in VOICE_SETTINGS if k not in present and settings.get(k)]
    if missing:
        with env.open("a") as fh:
            for key in missing:
                fh.write(f"{key}={settings[key]}\n")
        print(f"  {DIM}{agent.name}: copied {', '.join(missing)} into its home{OFF}")

    soul = home / "SOUL.md"
    if not soul.exists():
        shutil.copy(REPO / "context" / "SOUL.md", soul)


def gateway() -> str:
    """The gateway executable. One definition, in `src/defaults.py`, so the
    boot test launches exactly what this launches."""
    return gateway_binary()


def start(agent: Agent, settings: dict[str, str]) -> bool:
    if answering(agent.port):
        print(f"  {DIM}{agent.name} already up on {agent.port}{OFF}")
        return True

    if not wait_for_port(agent.port):
        print(f"  {WARN}{agent.name}: {agent.port} is still held — not starting{OFF}")
        return False

    log = pathlib.Path(f"/tmp/group-{agent.name.lower()}.log")
    with log.open("a") as fh:
        subprocess.Popen(
            [gateway(), "-v"],
            stdout=fh,
            stderr=fh,
            cwd=REPO,
            env=env_for(agent, STATE, {**os.environ, "HERMES_GROUP_TRACE": "1"}),
        )

    for _ in range(60):
        time.sleep(0.5)
        if answering(agent.port):
            print(f"  {OK}{agent.name}{OFF} {DIM}on {agent.port} · {log}{OFF}")
            return True
    print(f"  {WARN}{agent.name} did not come up — see {log}{OFF}")
    return False


def main() -> None:
    names = sys.argv[1:] or ["Anna", "Jordan", "Pepe"]
    settings = base_settings()
    if not settings.get("OPENROUTER_API_KEY"):
        sys.exit(
            "no OPENROUTER_API_KEY, in the environment or in .hermes/.env "
            "— run `pnpm setup` first"
        )

    existing = {a.name: a for a in _existing()}
    agents = [
        existing.get(
            name, Agent(name=name, port=FIRST_GROUP_PORT + i, key=secrets.token_hex(32))
        )
        for i, name in enumerate(names)
    ]

    print(f"{BOLD}starting {len(agents)} agents{OFF}")
    up = []
    for agent in agents:
        provision(agent, settings)
        if start(agent, settings):
            up.append(agent.name)

    # Written whichever way it went: the file is how every client finds the
    # agents, and a room with two of three still needs it.
    (STATE / "group.json").write_text(
        json.dumps(
            {"agents": [{"name": a.name, "port": a.port, "key": a.key} for a in agents]},
            indent=2,
        )
        + "\n"
    )
    print(f"\n{DIM}wrote group.json · talk to them with scripts/group.py{OFF}")

    # Nothing came up, so say so in the exit code.
    #
    # This used to return 0 regardless, and the entrypoint runs under `set -eu`,
    # so a boot where every gateway failed carried straight on to `exec next
    # start`. The result served a healthy-looking web app in front of three
    # agents that were not listening on anything — which is how a dependency
    # that only the gateway needed went missing for a whole deploy without
    # anything going red. A container that cannot answer should fail to start,
    # not come up wrong.
    #
    # A partial room is loud but not fatal: crash-looping the container because
    # one home is corrupt would turn a two-agent room into no room at all.
    if not up:
        sys.exit(
            f"{WARN}no agent came up — the room has nothing to talk to. "
            f"See /tmp/group-*.log{OFF}"
        )
    if len(up) < len(agents):
        missing = ", ".join(a.name for a in agents if a.name not in up)
        print(f"{WARN}running short: {missing} did not come up{OFF}")


def _existing() -> list[Agent]:
    from src.group import load_agents

    return load_agents(STATE)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
