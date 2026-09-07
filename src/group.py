"""Several agents in one chat.

Everything else in this repo is one agent deciding whether a turn is its
business. A group is the same decision made independently, several times, over
the same transcript — which is the only arrangement where that decision means
anything. One agent alone can be told to answer everything and nobody notices;
three agents told to answer everything is a room nobody can use.

Each agent is its own gateway process: its own `HERMES_HOME`, its own memory,
its own name, its own port. That is not incidental. A shared process would make
them one agent wearing three names — the same memory, the same history, the same
judgement — and the interesting failure (three replies to one question, or none)
could not happen, so proving it does not happen would prove nothing.

The chat itself lives here, not in any of them. A line is appended to the
transcript, then handed to every agent as the same input, and whatever comes
back is appended too. So an agent sees what the others said the same way it sees
what a person said: as a line in the room, attributed by name.
"""

from __future__ import annotations

import json
import os
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Agent:
    """One gateway, addressable by name."""

    name: str
    port: int
    key: str

    @property
    def host(self) -> str:
        return f"127.0.0.1:{self.port}"

    def home(self, root: Path) -> Path:
        return root / f".hermes-{self.name.lower()}"


@dataclass
class Line:
    """One thing somebody said."""

    speaker: str
    text: str
    at: float = field(default_factory=time.time)

    def rendered(self) -> str:
        return f"{self.speaker}: {self.text}"


def _post(url: str, key: str, payload: dict, timeout: int = 240) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return json.loads(body) if body else {}


SILENT = {"NO_REPLY", "SILENT", "HEARTBEAT_OK", "(empty)"}


def is_silence(reply: str) -> bool:
    return reply.strip() in SILENT or not reply.strip()


def open_chat(agent: Agent, chat: str) -> None:
    """Give one agent its own session for this chat.

    Each agent keeps a separate session under the same chat name, because the
    session is where its history lives and history is per-agent: what Anna
    remembers of this room is not what Jordan remembers.
    """
    try:
        _post(f"http://{agent.host}/api/sessions", agent.key, {"session_id": chat}, 30)
    except urllib.error.HTTPError:
        pass  # already there


def holds(agent: Agent, chat: str) -> bool:
    """Whether this agent has already been in this room.

    Asked before introducing, so opening a room that exists costs nothing. An
    empty session does not count: a session can be created and never used, and
    an agent that was never told who is here cannot tell a question aimed at
    Jordan from one aimed at itself.
    """
    try:
        req = urllib.request.Request(
            f"http://{agent.host}/api/sessions/{chat}/messages",
            headers={"Authorization": f"Bearer {agent.key}"},
        )
        with urllib.request.urlopen(req, timeout=5) as res:
            data = json.loads(res.read() or b"{}")
    except (urllib.error.URLError, OSError, ValueError):
        return False
    return bool(data.get("messages") or data.get("data"))


@dataclass(frozen=True)
class Reply:
    """What came back from one agent, and whether a turn happened at all.

    Silence and failure are different things and must never look the same. An
    agent deciding a line was not its business IS the behaviour this repo
    exists to show; a request that never reached it is a broken group wearing
    that behaviour as a costume. They were indistinguishable while both came
    back as ``None``, and a chat whose sessions had gone printed three calm
    "stayed quiet" lines in 0.0s instead of saying the turn never ran.
    """

    text: str | None = None
    error: str | None = None

    @property
    def failed(self) -> bool:
        return self.error is not None

    @property
    def spoke(self) -> bool:
        return self.text is not None


def deliver(agent: Agent, chat: str, line: Line) -> Reply:
    """Hand one line to one agent.

    The line arrives attributed, exactly as a person's would. An agent has no
    way to tell — and no reason to care — whether the speaker was human.
    """
    try:
        response = _post(
            f"http://{agent.host}/api/sessions/{chat}/chat",
            agent.key,
            {"message": line.rendered()},
        )
    except urllib.error.HTTPError as e:
        # Caught before URLError, which it subclasses — that inheritance is why
        # a 404 for a session that no longer exists was read as silence.
        detail = ""
        try:
            body = json.loads(e.read())
            detail = (body.get("error") or {}).get("message") or ""
        except Exception:  # noqa: BLE001
            pass
        return Reply(error=f"HTTP {e.code}" + (f": {detail}" if detail else ""))
    except (urllib.error.URLError, TimeoutError) as e:
        return Reply(error=f"unreachable on {agent.host} ({e})")

    reply = (response.get("message") or {}).get("content", "")
    return Reply() if is_silence(reply) else Reply(text=reply.strip())


def roster(agents: list[Agent], people: list[str]) -> str:
    """Who is in the room, for the agents to be told.

    Without this an agent knows its own name and nothing else, so it cannot tell
    a question aimed at Jordan from one aimed at itself — the exact mistake the
    addressing rules exist to prevent, made unfixable by missing information.
    """
    names = [a.name for a in agents]
    return (
        "In this chat: "
        + ", ".join(people + names)
        + ". You are {you}. The others are members like you — when one of them "
        "answers, that is another agent speaking, not you. Reply only when the "
        "message is for you.\n\n"
        # Every line arrives as "Name: text", and a model reads that as the
        # format it should write in too — one has already answered with a bare
        # colon and the question quoted back before its reply. The transcript is
        # how messages are labelled on the way IN; on the way out there is only
        # the reply.
        "Messages reach you prefixed with who said them. Do not write that "
        "prefix yourself and never repeat the question: say only your reply, "
        "with no name and no colon in front of it."
    )


#: The room. There is one, and this is its name.
#:
#: It used to be `group-<now>`, minted per launch, so "which one was I in" was
#: a question anybody could ask and nobody could answer from the screen. A
#: fixed id is what makes the room a place rather than a thing you open: the
#: browser, this client and the log all mean the same conversation without
#: being told which.
ROOM = "room"


def personas(root: Path) -> list[str]:
    """The backstories a room can deal out, from ``personas/`` at the repo root.

    Deliberately NOT in ``context/``. Everything in that folder reaches every
    agent on every turn — that is the shared contract, the thing they all agree
    on. A persona is the opposite: one agent's alone, and the room is only
    interesting because the others cannot read it.
    """
    folder = root / "personas"
    if not folder.is_dir():
        # Not an error. The room works as it did before, with agents who are
        # nobody in particular.
        return []
    found = [f.read_text(encoding="utf-8").strip() for f in sorted(folder.glob("*.md"))]
    return [p for p in found if p]


def _cast_file(root: Path) -> Path:
    """Beside the group's own state: not source, not configuration, and not
    something a fresh clone should inherit."""
    return root / ".hermes" / "cast.json"


def cast(root: Path, names: list[str]) -> list[str | None]:
    """One persona each, drawn at random the first time and stable after it.

    The deal used to happen every time a room was opened, which was fine when
    opening a room meant making a new one. There is one room now and a button
    that empties it, and an agent who was in support before you pressed it and
    runs security after is not a cleared context — it is a different person
    wearing the same name. So the first deal is written down and read back
    forever after.

    Fewer personas than agents is survivable: whoever draws nothing is simply
    itself, and the room opens either way.
    """
    folder = root / "personas"
    deck = sorted(f.name for f in folder.glob("*.md")) if folder.is_dir() else []
    if not deck:
        return [None] * len(names)

    written = _cast_file(root)
    try:
        held = {
            k: v
            for k, v in json.loads(written.read_text(encoding="utf-8")).items()
            if v in deck
        }
    except (OSError, ValueError):
        held = {}

    free = [f for f in deck if f not in set(held.values())]
    random.shuffle(free)
    changed = False
    for name in names:
        if name in held or not free:
            continue
        held[name] = free.pop()
        changed = True

    if changed and written.parent.is_dir():
        try:
            written.write_text(json.dumps(held, indent=2) + "\n", encoding="utf-8")
        except OSError:
            # An unwritable home costs the group its memory of who is who, not
            # its ability to open the room.
            pass

    out: list[str | None] = []
    for name in names:
        f = held.get(name)
        try:
            out.append((folder / f).read_text(encoding="utf-8").strip() or None if f else None)
        except OSError:
            out.append(None)
    return out


def briefing(persona: str) -> str:
    """A persona, framed so it reads as an identity rather than as a document."""
    return (
        "This is who you are. It is yours alone — the others in this room have "
        "been given their own and cannot see this one, so never quote it, never "
        "describe it as a briefing, and never announce your role unless somebody "
        "asks. Simply be this person.\n\n" + persona
    )


def load_agents(root: Path) -> list[Agent]:
    """The group, from `group.json` next to the homes it describes."""
    config = root / "group.json"
    if not config.exists():
        return []
    data = json.loads(config.read_text())
    return [
        Agent(name=a["name"], port=int(a["port"]), key=a["key"])
        for a in data.get("agents", [])
    ]


def env_for(agent: Agent, root: Path, base_env: dict | None = None) -> dict:
    """The environment one agent's gateway runs under."""
    return {
        **(base_env or os.environ),
        "HERMES_HOME": str(agent.home(root)),
        "HERMES_AGENT_NAME": agent.name,
        "API_SERVER_KEY": agent.key,
    }
