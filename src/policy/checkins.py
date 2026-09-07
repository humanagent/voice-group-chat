"""Scheduled work delivers something real, or stays completely silent.

A check-in wakes the agent with nobody waiting on the other end. That inverts
the usual bias: an "On it — running the sweep now" is reassurance nobody asked
for, and the chat only sees noise.

Two rules, and the second is the one nobody expects.

**Judged on the shape of the reply, never on whether it did any work.** Gating
on "did a tool run" would silence a joke-of-the-day check-in, which runs nothing
and is still the whole deliverable. So the ack is matched on how it reads: an
opener standing alone, or a progress verb landing on "now".

**A check-in has no memory of its last run.** It fires whether or not the world
changed, finds the same news an hour later, and posts it again. So every
delivery is fingerprinted against a short history — not just the previous run,
because a story rotates back to a state it already held.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from src.lib.dedup_ring import DedupRing

_ACK_MAX_CHARS = 100

# An opener on its own, or trailed by a progress clause. The opener already
# establishes the ack, so the narration after it needs no "now".
_OPENER = r"""(?: on\ it | got\ it | will\ do | one\ moment | hang\ tight
    | back\ shortly | sure\ thing | right\ away | coming\ up )"""
_VERB = r"""(?: running | pulling | checking | finding | fetching | grabbing
    | gathering | compiling | searching | looking\ into | working\ on
    | putting\ together | digging\ into )"""
# A progress clause ABOUT the user is a deliverable, not machinery narration:
# "checking in on you right now" is a wellness check-in's actual content.
_NOT_SECOND_PERSON = r"(?! [^.:\n]* \b your? \b )"
_CLAUSE = rf"""(?:
    {_OPENER}\b (?: [\s,;:—–-]* {_VERB}\b {_NOT_SECOND_PERSON} [^.:\n]* )?
  | {_VERB}\b {_NOT_SECOND_PERSON} [^.:\n]* \b(?: now | shortly | right\ now | in\ a\ sec )\b
)"""
_ACK = re.compile(rf"""^\s* (?: {_CLAUSE} [\s.…!—–-]* )+ $""", re.IGNORECASE | re.VERBOSE)


def is_bare_ack(text: str | None) -> bool:
    """Is this reply pure acknowledgement, with no deliverable in it?

    Anchored so any leftover with real words ships: "Got it — 3 new listings"
    and "On it: next reminder is at 4pm" are results, not acks. The length cap
    is only a cheap pre-filter; the clause anchoring does the work.
    """
    t = (text or "").strip()
    if not t or len(t) > _ACK_MAX_CHARS:
        return False
    return _ACK.match(t) is not None


def _ring() -> DedupRing | None:
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    try:
        return DedupRing(Path(home) / "checkin-deliveries.json")
    except Exception:  # noqa: BLE001
        return None


def fingerprint(text: str) -> str:
    """A delivery's identity: its words, normalised.

    Whitespace and case only; punctuation stays, because "no rain today" and
    "no rain today!" really are the same post twice.
    """
    normalised = " ".join((text or "").lower().split())
    return hashlib.sha256(normalised.encode()).hexdigest()[:16]


def already_delivered(text: str) -> bool:
    """Has this exact delivery gone out recently? Fail-open to no."""
    ring = _ring()
    if ring is None:
        return False
    try:
        return ring.contains(fingerprint(text))
    except Exception:  # noqa: BLE001
        return False


def record_delivery(text: str) -> None:
    """Remember a delivery so the next run does not repeat it. Fail-open."""
    ring = _ring()
    if ring is None:
        return
    try:
        ring.record(fingerprint(text))
    except Exception:  # noqa: BLE001
        pass
