"""A question asked in a room has to say whose it is.

Everything said here is heard by everybody. In a one-to-one chat "what did you
have in mind?" is unambiguous, because there is only one "you". In a room it is
a question left hanging in the air: three agents and a person all hear it, none
of them knows whether it was theirs, and what follows is either silence or all
of them answering at once. Observed, exactly as written:

    Anna:  I'm good! Pepe, are you up for doing something tomorrow?
    Pepe:  Sure — what did you have in mind?

Anna asked Pepe by name. Pepe asked back into the void.

`group_context.md` asks the model to put the name on it. This is the
deterministic backstop underneath that, the same arrangement `outbound_length`
has with BREVITY: guidance biases the reply, and a function guarantees it. A
reply that carries a question mark and names nobody gets the name of whoever it
is answering, placed at the question itself:

    Sure — what did you have in mind, Anna?

Nothing is invented here. The name comes from the ``Speaker:`` prefix on the
message that opened the turn, which is the only thing in this process that
knows who was talking. Two cases therefore go out untouched, on purpose:

* The asker has no name. A person types into the room as ``you:`` in both the
  browser and the terminal client, and ", you?" is worse than the silence it
  was meant to fix.
* The reply already addresses somebody — the asker, another member by name at
  the head of the line, or the whole room ("anyone free Saturday?"). A question
  that already has an audience does not need a second one.
"""

from __future__ import annotations

import re

from ..members import MACHINERY, SPEAKER, UNNAMED
from .addressing import called_at_head, is_addressed

# Ways of addressing the room itself. A question aimed at everybody is already
# addressed, and pinning one member's name to it would narrow it to somebody
# nobody meant. Both languages the room speaks, because it speaks both.
_EVERYBODY = re.compile(
    r"(?<!\w)(?:everyone|everybody|anyone|anybody|someone|somebody|"
    r"you\s+all|y'?all|guys|folks|people|team|"
    r"todos|todas|alguien|alguno|gente|chicos)(?!\w)",
    re.IGNORECASE,
)

# Prefixes that are labels rather than people. `you` is a person who never
# gave a name, and `System` is the room's own machinery: the opening roster
# arrives as "System: In this chat: …", and the first turn of every room asks
# something back. "What do you need, System?" was found in the trace of a real
# one before this line existed.
_NOT_A_PERSON = {UNNAMED, MACHINERY.lower()}

# What to step back over to find where the name goes: sentence punctuation and
# the space in front of it. Commas are in the set so a name is never stacked on
# top of one that is already there.
_BEFORE_THE_MARK = "?!.…,;: \t\u00a0"


def ensure_addressed(text: str, *, inbound: str | None, agent_name: str) -> str:
    """Put the asker's name on this reply's first question, if it needs one.

    Returns ``text`` unchanged whenever the guard cannot act honestly: no
    question, nobody named to answer, or a question that already has an
    audience. Only the FIRST question mark is named — one address settles who
    the reply is talking to, and a name on every clause reads like a hostage
    video.
    """
    if "?" not in text:
        return text
    asker = _asker(inbound, agent_name)
    if not asker or _addresses_somebody(text, asker):
        return text
    return _name_the_question(text, asker)


def _asker(inbound: str | None, agent_name: str) -> str:
    """Who this turn is answering, by name, or "" when there is no name to use.

    The last person in the inbound who called the agent by name; failing that,
    the last person to speak at all. Most turns are one line and both answers
    are the same person. When they are not — a batch where somebody else spoke
    after the question — the one who used the agent's name is the one waiting
    for it.
    """
    named = [
        (match.group(1).strip(), line)
        for line in str(inbound or "").split("\n")
        if (match := SPEAKER.match(line))
    ]
    if not named:
        return ""
    called = [name for name, line in named if is_addressed(line, agent_name)]
    asker = (called or [name for name, _ in named])[-1]
    return "" if asker.lower() in _NOT_A_PERSON else asker


def _addresses_somebody(text: str, asker: str) -> bool:
    """Whether this reply already has an audience.

    Three ways it can: it names the asker anywhere in the line, it opens by
    calling somebody else ("Jordan, are you in?" — a redirect, and adding the
    asker to it would address two people at once), or it calls on the room.

    Anywhere in the line, not just in the question, and that is deliberately
    loose: "I'll ask Anna — what time works?" mentions her rather than asking
    her, and is left alone anyway. A guard that fired there would produce "I'll
    ask Anna — what time works, Anna?", which is worse than the miss. This only
    ever adds a name to a line that has none.
    """
    return bool(
        is_addressed(text, asker) or called_at_head(text) or _EVERYBODY.search(text)
    )


def _name_the_question(text: str, asker: str) -> str:
    """``…have in mind?`` -> ``…have in mind, Anna?``

    The name goes where a person would say it: at the end of the question, not
    bolted onto the front of the message. Stepping back over the punctuation
    first is what keeps "really!?" from becoming "really!, Anna?".
    """
    mark = text.index("?")
    head = text[:mark].rstrip(_BEFORE_THE_MARK)
    if not head:
        # A question mark with nothing in front of it has no sentence to attach
        # a name to. Leave it alone rather than open the line with a comma.
        return text
    return f"{head}, {asker}{text[len(head):]}"
