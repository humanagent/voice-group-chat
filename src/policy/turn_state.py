"""What the exit gate needs to know, carried from the start of the turn.

``transform_llm_output`` sees the reply and the session id, and nothing else —
not the message that caused it, not whether the turn was scheduled. Those are
only visible at ``pre_llm_call``, so they are stashed there and read back here.

The stash rides the THREAD, not the session. A background review runs
concurrently with the conversation it reviews, in the same session, so keying on
session id lands a turn's state on whichever turn finishes first — observed
once, and it silenced a real reply while the review spoke. A turn runs start to
finish on one thread; a thread cannot mix two turns up.

Losing the stash (an upstream that hands a turn between threads) degrades to
"the gate has no inbound to judge", which is the behaviour before any of this
existed rather than a new way to swallow somebody's reply.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

_state = threading.local()


@dataclass(frozen=True)
class TurnContext:
    inbound: str | None = None
    # Scheduled work: nobody sent it, nobody is waiting. It may still deliver.
    is_system: bool = False
    # Upstream's own maintenance turn. It never delivers anything a chat wants.
    is_review: bool = False


EMPTY = TurnContext()


def begin(inbound: object, *, is_system: bool = False, is_review: bool = False) -> None:
    """Record what started the turn running on this thread."""
    _state.ctx = TurnContext(
        inbound=inbound if isinstance(inbound, str) else None,
        is_system=is_system or is_review,
        is_review=is_review,
    )


def peek() -> TurnContext:
    """Read this thread's turn context without consuming it.

    The middleware that builds the prompt runs after ``pre_llm_call`` and before
    the gate, and needs the same inbound both of them see.
    """
    return getattr(_state, "ctx", EMPTY)


def take() -> TurnContext:
    """Read and clear this thread's turn context."""
    ctx = getattr(_state, "ctx", EMPTY)
    _state.ctx = EMPTY
    return ctx
