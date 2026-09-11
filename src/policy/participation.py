"""Listen mode: the group decides, not the agent.

Everything else in this layer is the agent judging whether to speak. Sometimes
the chat wants to settle it — the conversation is having a moment and the
assistant should be present without being in it. So participation is a switch
anyone can flip:

    speak    the default; the rest of the layer decides
    mention  it reads and remembers everything, and only answers when addressed
    paused   nothing runs at all

``mention`` is the interesting one, because it is not a mute on the input. The
turn still happens, the memory still fills; what changes is only whether the
reply is allowed out. It is enforced twice — the model is told, and a gate at
the exit catches the turns where it answers anyway — because a rule that only
lives in a prompt is a rule the model may decline.

``paused`` is different in kind: the turn does not run. Scheduled work is not
affected, which is the point — paused means off in the chat, not off.

State is a small JSON file under the Hermes home so it survives a restart, and
every read fails open to ``speak``: a corrupt file must not silence an agent.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

SPEAK, MENTION, PAUSED = "speak", "mention", "paused"
MODES = (SPEAK, MENTION, PAUSED)

# A chat starts in mentions-only. The agent is a member of the conversation, not
# a participant in it: it reads and remembers everything from the first message
# and answers when called. Opting into `speak` is the chat deciding it wants an
# agent that volunteers.
DEFAULT = MENTION

_lock = threading.Lock()


def _file(home: str | Path | None = None) -> Path:
    """Where the state lives, under one Hermes home.

    The home is a parameter because a group is several gateways, each with its
    own home and so its own copy of this file. Setting a group's mode means
    writing it into every one of them: a single file under the launcher's home
    would be read by nobody, and the switch would look like it worked while
    changing nothing.
    """
    root = home or os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")
    return Path(root) / "participation.json"


def _read(home: str | Path | None = None) -> dict[str, str]:
    try:
        return json.loads(_file(home).read_text())
    except Exception:  # noqa: BLE001 — fail open to speak
        return {}


def mode(chat: object, home: str | Path | None = None) -> str:
    """This chat's mode. Anything unreadable or unknown falls back to the
    default rather than to the loudest option: a broken state file should leave
    the agent behaving as configured, not turn it chatty."""
    value = _read(home).get(str(chat or ""), DEFAULT)
    return value if value in MODES else DEFAULT


def set_mode(chat: object, value: str, home: str | Path | None = None) -> str:
    """Set a chat's mode, returning what it ended up as."""
    if value not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}")
    with _lock:
        state = _read(home)
        state[str(chat or "")] = value
        path = _file(home)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    return value


def all_modes(home: str | Path | None = None) -> dict[str, str]:
    """Chats that differ from the default."""
    return {k: v for k, v in _read(home).items() if v in MODES and v != DEFAULT}


def resolve(value: str) -> str | None:
    """A mode from a prefix, so `/mode m` is `mention`. None when ambiguous or
    unknown — guessing here would silence a chat nobody meant to silence."""
    hit = [m for m in MODES if m.startswith(value.strip().lower())]
    return hit[0] if len(hit) == 1 else None


def preamble(chat: object, addressed: bool) -> str:
    """What the model is told about this chat's mode, per turn.

    Mentions-only is enforced twice: here, and again at the exit. Telling the
    model is what makes a silent turn cheap — it stops before writing a reply
    nobody will see — and the gate is what makes it reliable, because a rule
    that lives only in a prompt is a rule the model may decline.

    ``speak`` says nothing at all: the rest of the layer is the instruction.
    """
    current = mode(chat)
    if current == PAUSED:
        return (
            "\n\nThis conversation is paused. Do not reply. End your turn with "
            "SILENT."
        )
    if current != MENTION:
        return ""
    if addressed:
        # Told, not ordered. This branch used to end "Answer it.", which took
        # the decision away in the one case where it is actually a decision: a
        # message NAMES the agent without being for it. "Steve, tell Pepe to say
        # hi" carries Pepe's name, so the check said addressed and the note
        # made him answer a request that was Steve's to relay — and then he
        # answered again when she did relay it. The check is a fact about the
        # text; whether it was meant is a judgement, and the model is the one
        # holding the sentence.
        return (
            "\n\nThis conversation is in mentions-only mode and your name is in "
            "this message. Being named is not being addressed:\n"
            "  Robin, what time is it?   → yours. Answer.\n"
            "  Sam, ask Robin the time   → Sam's. Wait for her to ask you.\n"
            "Unsure? Answer."
        )

    return (
        "\n\nThis conversation is in mentions-only mode and this message is not "
        "addressed to you. Read it, remember it, and end your turn with SILENT. "
        "Your name appearing in a message aimed at somebody else does not make "
        "it yours: being asked about is not being asked. If they are relaying "
        "something to you, wait and answer them, not the message about you. "
        "Otherwise, if you are genuinely unsure whether you were addressed, "
        "answer anyway: a missed question is worse than an extra reply."
    )
