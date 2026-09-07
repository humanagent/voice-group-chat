"""Background-review turns must not speak.

Hermes fires its own maintenance turns — the memory review, the skill review —
by feeding the agent a harness prompt and running a full turn on it. Nobody sent
that message and nobody is waiting on the answer, but the turn still produces
one, and on a chat transport that answer is delivered: a bare "Saved." arriving
in the chat with no one having asked anything.

It is not free either. One observed memory review cost 52,093 tokens and 6.7s
across two rounds to say six characters to nobody.

So the turn is allowed to run — it is doing real work, writing to memory — and
only its prose is dropped. This is the same split the rest of the layer uses:
hiding text and cancelling effects are different switches, and the memory write
has already happened by the time the words are judged.

The prefixes come from upstream rather than being copied, so a reworded harness
prompt cannot silently start leaking again.
"""

from __future__ import annotations

try:  # upstream owns the list; a private name, so tolerate it moving
    from hermes_state import _REVIEW_HARNESS_PREFIXES as PREFIXES
except Exception:  # noqa: BLE001
    PREFIXES = (
        "Review the conversation above and update the skill library",
        "Review the conversation above and consider saving to memory",
    )


def is_review_prompt(text: object) -> bool:
    """Whether this inbound is one of upstream's background-review harnesses."""
    return isinstance(text, str) and text.lstrip().startswith(PREFIXES)
