"""The exit gate: everything the layer decides about one outbound turn.

The rules used to be spread through ``_transform_output`` as a run of early
returns, which is fine until they interact — and they do. Silence, listen mode,
addressing, check-in acks and repeat deliveries all end a turn the same way, but
they do not all mean the same thing for what rides along with the words.

That distinction is the whole reason this is one place rather than five:
**hiding text and cancelling effects are different switches.** A turn silenced
for having nothing to say still ships the file it produced. A turn silenced
because the chat asked for quiet ships nothing at all — staying silent while
still posting attachments is not staying silent.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import checkins, participation
from .addressing import addresses_another, is_addressed


@dataclass(frozen=True)
class Verdict:
    """What to do with a turn, and why."""

    speak: bool
    reason: str = ""
    # Whether media and links still ride along on a silenced turn.
    keep_effects: bool = True


SPEAK = Verdict(True)


def judge(
    *,
    text: str,
    chat: object,
    agent_name: str,
    inbound: str | None,
    is_system_turn: bool,
    is_review_turn: bool = False,
    has_suppress_token: bool,
) -> Verdict:
    """Decide one turn. Ordered most-decisive first."""

    mode = participation.mode(chat)

    # Paused is the chat saying "not now" — nothing goes out, effects included.
    if mode == participation.PAUSED:
        return Verdict(False, "paused", keep_effects=False)

    # Upstream's own maintenance turn — the memory review, the skill review.
    # Unlike a check-in it can never carry something the chat asked for, so it
    # never speaks whatever it produced. The work it did already happened.
    if is_review_turn:
        return Verdict(False, "background review turn", keep_effects=False)

    # The model's own signal that it has nothing to add. The turn may still have
    # produced a file, and that ships: it had something, just not words.
    if has_suppress_token:
        return Verdict(False, "suppress token")

    if is_system_turn:
        # Nobody is waiting on a scheduled turn, so it delivers something real
        # or nothing. Judged on the shape of the reply, never on whether a tool
        # ran — a joke-of-the-day check-in runs nothing and is the deliverable.
        if checkins.is_bare_ack(text):
            return Verdict(False, "bare acknowledgement")
        # A check-in has no memory of its last run: it will find the same news
        # an hour later and post it twice.
        if text.strip() and checkins.already_delivered(text):
            return Verdict(False, "already delivered")

    if inbound is not None:
        addressed = is_addressed(inbound, agent_name)

        # Mentions-only is not a mute on the input: the turn ran and the memory
        # filled. Only the reply is withheld — and reactions and attachments
        # with it, because staying quiet while still posting things is not
        # staying quiet.
        if mode == participation.MENTION and not addressed:
            return Verdict(False, "mentions only, not addressed", keep_effects=False)

        # Somebody else was called by name. Not a judgement call and not a close
        # one: the message opens with a name that is not the agent's.
        if addresses_another(inbound, agent_name):
            return Verdict(False, "addressed to someone else")

    return SPEAK
