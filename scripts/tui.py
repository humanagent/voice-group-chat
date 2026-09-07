#!/usr/bin/env python3
"""Tail the runtime the way the runtime it came from tails: one line per event.

Not a dashboard. A log — timestamped, prefixed, greppable, scrollable, and
copy-pasteable into a bug report. Two sources are merged as they arrive:

    the plugin's decision trace   ~/.hermes/group-trace.jsonl
    the gateway's own stdout      /tmp/hermes-groups.log

    groups watch                      # follow from now
    groups replay                     # start from the top instead
    scripts/tui.py --session <chat>   # one chat only
    scripts/tui.py --agent Anna=.hermes-anna --agent Pepe=.hermes-pepe

A group traces into each agent's own home, so reading one means tailing several
files at once: `--agent NAME=HOME`, repeatable, merges them by timestamp and
puts the name in its own column.

Line shapes, so they can be grepped:

    [turn]     a turn opened, with the message that opened it
    [llm]      one API round: model, tokens, latency, why it stopped
    [tool]     one tool call and how long it took
    [policy]   the decision — spoke or quiet, and what it cost
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import sys
import time
from datetime import datetime

DIM = "\033[2m"
OFF = "\033[0m"
WARM = "\033[38;5;173m"
QUIET = "\033[38;5;244m"
BAD = "\033[38;5;131m"
GOOD = "\033[38;5;107m"

GATEWAY_LOG = pathlib.Path(os.environ.get("GATEWAY_LOG", "/tmp/hermes-groups.log"))
HOST = os.environ.get("HOST", "127.0.0.1:8642")
BOLD = "\033[1m"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src.members import agent_name, members  # noqa: E402


def _api_key() -> str | None:
    key = os.environ.get("API_SERVER_KEY")
    if key:
        return key
    home = os.environ.get("HERMES_HOME") or str(pathlib.Path.home() / ".hermes")
    env = pathlib.Path(home) / ".env"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        if line.startswith("API_SERVER_KEY="):
            return line.split("=", 1)[1].strip()
    return None


def trace_file() -> pathlib.Path:
    raw = os.environ.get("HERMES_GROUP_TRACE", "").strip()
    if raw and raw.lower() not in {"1", "true", "on", "yes"}:
        return pathlib.Path(raw).expanduser()
    home = os.environ.get("HERMES_HOME") or str(pathlib.Path.home() / ".hermes")
    return pathlib.Path(home) / "group-trace.jsonl"


def stamp(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or time.time()).strftime("%H:%M:%S")


def num(n: object) -> str:
    return f"{int(n):,}" if isinstance(n, (int, float)) else str(n)


def tokens(u: dict) -> str:
    """The token line, in the shape the runtime it came from prints it.

    ``in`` is the whole prompt — fresh plus what the cache served — because that
    is what the context actually cost to assemble. ``fresh`` is the part that
    was billed at full rate, and the gap between them is the cache doing its
    job. Reasoning is shown apart from output: on a reasoning model most of a
    turn's output tokens are never seen by anyone.
    """
    fresh = int(u.get("input_tokens") or 0)
    cr = int(u.get("cache_read_tokens") or u.get("cached_tokens") or 0)
    cw = int(u.get("cache_write_tokens") or 0)
    out = int(u.get("output_tokens") or u.get("completion_tokens") or 0)
    reasoning = int(u.get("reasoning_tokens") or 0)
    prompt = fresh + cr + cw
    hit = f" hit={cr / prompt:.0%}" if prompt else ""
    return (
        f"in={num(prompt)} (fresh={num(fresh)} cache_r={num(cr)} cache_w={num(cw)}{hit})"
        f" out={num(out)}"
        + (f" reasoning={num(reasoning)}" if reasoning else "")
    )


class TurnTotals:
    """Rounds add up here so the turn can be summarised when it closes.

    One turn is usually several API rounds, and the per-round numbers say
    nothing about what the turn cost. This is the roll-up the runtime it came from
    prints as `[tokens] turn`.
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.rounds = 0
        self.secs = 0.0
        self.u: dict[str, int] = {}

    def add(self, usage: dict, secs: float) -> None:
        self.rounds += 1
        self.secs += secs
        for k, v in (usage or {}).items():
            if isinstance(v, (int, float)):
                self.u[k] = self.u.get(k, 0) + int(v)

    def summary(self, at: str) -> str:
        if self.rounds < 1:
            return ""
        total = sum(
            int(self.u.get(k) or 0)
            for k in ("input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens")
        )
        return (
            f"{at} {QUIET}[tokens]{OFF}  turn {tokens(self.u)} total={num(total)}"
            f" rounds={self.rounds} {self.secs:.1f}s model\n"
        )


_turn = TurnTotals()

# One per source. A group is three gateways tracing at once, and a single
# running total would add Anna's rounds to Pepe's turn and report a cost neither
# of them paid.
_totals: dict[str, TurnTotals] = {}


def totals_for(label: str) -> TurnTotals:
    return _totals.setdefault(label, TurnTotals())


def tag(label: str, text: str) -> str:
    """Put the source in its own column, on every line of the block.

    Only when there is more than one source: a single runtime needs no column,
    and adding one would push every existing line right for no reason.
    """
    if not label:
        return text
    return "\n".join(f"{DIM}{label:<8}{OFF}{line}" for line in text.split("\n"))


def render(rec: dict, label: str = "") -> str | None:
    """One trace record as one log line."""
    global _turn
    _turn = totals_for(label)
    kind = rec.get("kind")
    at = f"{DIM}{stamp(rec.get('ts'))}{OFF}"
    chat = rec.get("session") or "-"

    if kind == "inbound":
        msg = (rec.get("message") or "").replace("\n", " ⏎ ")[:120]
        return (
            f"{at} {WARM}[turn]{OFF}    chat={chat} history={rec.get('history', 0)}"
            f" first={str(rec.get('first', False)).lower()}\n"
            f"{at} {DIM}         in  {msg}{OFF}"
        )

    if kind == "context":
        if not rec.get("injected"):
            return f"{at} {QUIET}[ctx]{OFF}     nothing injected"
        return (
            f"{at} {QUIET}[ctx]{OFF}     {num(rec.get('chars'))} chars"
            f" via {rec.get('carrier')}"
        )

    if kind == "round":
        u = rec.get("usage") or {}
        _turn.add(u, rec.get("secs") or 0)
        return (
            f"{at} {QUIET}[llm]{OFF}     round={rec.get('n')} model={rec.get('model')}"
            f" {tokens(u)}"
            f" finish={rec.get('finish')}"
            + (f" tools={rec['tools']}" if rec.get("tools") else "")
            + f" {rec.get('secs', 0):.1f}s"
        )

    if kind == "tool":
        return f"{at} {QUIET}[tool]{OFF}    {rec.get('name')} {rec.get('secs')}s"

    if kind == "turn":
        summary = _turn.summary(at)
        _turn.reset()
        if not rec.get("spoke"):
            return (
                summary
                + f"{at} {QUIET}[policy]{OFF}  quiet   reason={rec.get('reason')!r}"
                f" raw={num(rec.get('raw_chars'))} → 0"
            )
        flags = []
        if rec.get("clamped"):
            flags.append(f"{WARM}clamped{OFF}")
        if rec.get("exempt"):
            flags.append("exempt")
        if rec.get("media"):
            flags.append(f"media={rec['media']}")
        if rec.get("dropped"):
            flags.append(f"{BAD}dropped={','.join(rec['dropped'])}{OFF}")
        tail = ("  " + " ".join(flags)) if flags else ""
        text = (rec.get("text") or "").replace("\n", " ⏎ ")[:110]
        return (
            summary
            + f"{at} {GOOD}[policy]{OFF}  spoke   raw={num(rec.get('raw_chars'))}"
            f" → {num(rec.get('final_chars'))}{tail}\n"
            f"{at} {DIM}         out {text}{OFF}"
        )
    return None


# Gateway lines worth surfacing. The rest is boot chatter and plugin discovery
# that would bury the turns.
KEEP = re.compile(
    r"(ERROR|CRITICAL|Traceback|WARNING gateway|listening|failed|refus|"
    r"group-layer|api_server)",
    re.IGNORECASE,
)


def follow(path: pathlib.Path, replay: bool, parse_json: bool):
    """Yield (source, payload) as lines land, surviving the file not existing."""
    handle = None
    while True:
        if handle is None:
            if not path.exists():
                yield None
                time.sleep(0.4)
                continue
            handle = path.open()
            if not replay:
                handle.seek(0, os.SEEK_END)
        line = handle.readline()
        if not line:
            yield None
            time.sleep(0.15)
            continue
        if parse_json:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue
        else:
            yield line.rstrip("\n")


def sources(argv: list[str]) -> list[tuple[str, pathlib.Path, pathlib.Path]]:
    """What to tail: (label, trace, gateway log) per runtime.

    `--agent Name=/path/to/home`, repeatable, is how a group is read. Each agent
    is its own gateway with its own home, so a group chat leaves no trace at all
    in the single runtime's file — which is why reading one there showed an
    empty screen.

    With no `--agent` this is the single runtime, unlabelled, exactly as before.
    """
    found: list[tuple[str, pathlib.Path, pathlib.Path]] = []
    for i, arg in enumerate(argv):
        if arg != "--agent" or i + 1 >= len(argv):
            continue
        name, _, home = argv[i + 1].partition("=")
        found.append(
            (
                name,
                pathlib.Path(home) / "group-trace.jsonl",
                pathlib.Path(f"/tmp/group-{name.lower()}.log"),
            )
        )
    return found or [("", trace_file(), GATEWAY_LOG)]


def main() -> None:
    replay = "--replay" in sys.argv
    session = None
    if "--session" in sys.argv:
        session = sys.argv[sys.argv.index("--session") + 1]

    watching = sources(sys.argv)
    labelled = len(watching) > 1
    for label, path, log in watching:
        who = f"{label:<8}" if labelled else ""
        print(f"{DIM}{who}tailing {path}{OFF}")
        if log.exists():
            print(f"{DIM}{' ' * len(who)}     and {log}{OFF}")
    if session:
        print(f"{BOLD}{session}{OFF}")
        if labelled:
            print(f"{DIM}{', '.join(label for label, _, _ in watching)}{OFF}")
        else:
            key = _api_key()
            people = members(HOST, session, key) if key else []
            print(f"{DIM}{', '.join(people + [agent_name()])}{OFF}")
    # Said plainly, because an empty screen has two meanings and only one of
    # them is a problem. Live is the default: waiting for a turn looks exactly
    # like a broken tail until something says which it is.
    print(
        f"{DIM}"
        + ("backlog first, then live" if replay else "live — only what happens from now")
        + f"{OFF}"
    )
    print(f"{DIM}nothing appears unless the runtime runs with HERMES_GROUP_TRACE=1{OFF}\n")

    def wanted(rec: dict) -> bool:
        return not (session and rec.get("session") not in (None, session))

    # In replay the trace backlog is printed first and in full, and across
    # several agents it is merged by timestamp — a group turn is three gateways
    # deciding at the same moment, and reading Anna's whole history before
    # Jordan's first line would hide exactly that.
    if replay:
        backlog: list[tuple[float, str, dict]] = []
        for label, path, _ in watching:
            if not path.exists():
                continue
            for line in path.read_text().splitlines():
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not wanted(rec):
                    continue
                backlog.append((float(rec.get("ts") or 0), label, rec))
        for _, label, rec in sorted(backlog, key=lambda x: x[0]):
            out = render(rec, label)
            if out:
                print(tag(label if labelled else "", out), flush=True)
        print(f"{DIM}{'─' * 40} live{OFF}", flush=True)

    live = [
        (label, follow(path, replay=False, parse_json=True),
         follow(log, replay=False, parse_json=False))
        for label, path, log in watching
    ]

    try:
        while True:
            idle = True
            for label, trace, gateway in live:
                shown = label if labelled else ""
                rec = next(trace)
                if rec is not None:
                    idle = False
                    if wanted(rec):
                        line = render(rec, label)
                        if line:
                            print(tag(shown, line), flush=True)
                raw = next(gateway)
                if raw is not None:
                    idle = False
                    if KEEP.search(raw):
                        print(
                            tag(shown, f"{DIM}{stamp()} [gw]      {raw[:160]}{OFF}"),
                            flush=True,
                        )
            if idle:
                time.sleep(0.1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
