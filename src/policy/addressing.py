"""Was the agent spoken to?

The prompt asks the model this every turn and the model gets it wrong in a way
worth naming: a message that names somebody *else* still reads to it as an
opening. Observed, before this existed — "Anna, do you know when the post office
opens?" and the agent answered, over Anna's shoulder.

That is not a judgement call. The message either carries the agent's name or it
does not, and a function can say so where a prompt can only hope. So this runs
before the model and hands it the answer, and the exit gate uses the same answer
to catch the turns where it replies anyway.

Deliberately biased toward "yes". A false silence swallows a real question
forever; a false reply is a slightly chatty bot. Hence the typo tolerance, the
single-word match, and the reply-to shortcut.

Ported from the source runtime's ``channel._is_addressed``, minus the transport:
this takes text and a name rather than an inbound message object.
"""

from __future__ import annotations

import re

# The one reserved way to address an agent without knowing its name. It only
# addresses when carrying the "@" sigil: "@agent" is deliberate, while "we need
# an agent for this" is talking *about* agents.
GENERIC_TOKEN = "agent"
_GENERIC_MENTION = re.compile(r"(?<!\w)@agent(?!\w)", re.IGNORECASE)
_WORDS = re.compile(r"[^\W_]+")
# The openers that make the next word a name. Used by both vocative shapes, so
# "hey ana" and "Anna," cannot drift into disagreeing about what counts as a
# greeting.
_GREETINGS = (
    r"hey|heyy+|hi|hii+|hiya|hello|yo|howdy|morning|"
    r"good\s+(?:morning|afternoon|evening)"
)

_SKIP = {"the", "and", "a", "an"}


def _max_edits(token_len: int) -> int:
    """Typo tolerance for a name token, scaled by length.

    Short tokens get none — too easy to collide with an ordinary word. The
    tolerance grows so "assistant" forgives "asssistant" and "assistent" while
    a four-letter name stays exact.
    """
    if token_len <= 4:
        return 0
    if token_len <= 7:
        return 1
    return 2


def _squeeze(word: str) -> str:
    """A word with its runs of one letter collapsed: "annaa" -> "ana".

    A doubled letter is not really a typo, it is how a name arrives. A
    transcriber writes down the spelling its own language prefers — "Ana" and
    "Anna" are the same sound in two languages and it has to pick one — and
    somebody typing writes "anaa" or "annaa". Collapsing every run to a single
    letter makes all of those one word.

    Short names need this most and are the ones the edit budget cannot help: a
    three-letter token gets no tolerance at all outside the vocative, on
    purpose, so "various people came" does not call Aria. Squeezing costs none
    of that safety, because it only ever merges a word with itself said louder.
    """
    return re.sub(r"(.)\1+", r"\1", word)


def _within(a: str, b: str, max_dist: int) -> bool:
    """Levenshtein, bounded: bails as soon as a row cannot come in under the
    limit, so it stays cheap on the short strings this compares."""
    la, lb = len(a), len(b)
    if abs(la - lb) > max_dist:
        return False
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        ca = a[i - 1]
        row_best = cur[0]
        for j in range(1, lb + 1):
            cost = 0 if ca == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            row_best = min(row_best, cur[j])
        if row_best > max_dist:
            return False
        prev = cur
    return prev[lb] <= max_dist


def is_addressed(text: str, name: str, *, is_reply_to_agent: bool = False) -> bool:
    """Whether this message is aimed at the agent.

    Any of: a reply to something the agent said; the reserved ``@agent``; the
    display name as a phrase; any single word of the name; or a near-miss of
    one of those words.

    With one thing that outranks all of them except the sigil: a message that
    OPENS by calling somebody else is a message to them, and the agent's name
    further in is being talked about rather than talked to. "Anna, preguntale a
    Pepe la hora" is a request to Anna. Pepe answering it is the same
    over-the-shoulder mistake this module exists to stop, one step removed —
    and worse, because Anna then relays the question and gets the same answer a
    second time.
    """
    if is_reply_to_agent:
        return True

    text = (text or "").lower()
    own = (name or "").strip().lower()
    if not text:
        return False

    # The sigil still wins. "@agent" inside a message to Anna is somebody
    # deliberately pulling the agent in, and a deliberate address is the one
    # thing never worth second-guessing.
    if _GENERIC_MENTION.search(text):
        return True
    if not own:
        return False

    tokens = _name_tokens(own)
    called = _called_at_head(text)
    if called:
        # The vocative slot is the one place a short name can forgive a typo.
        # Everywhere else a three-letter name has to be exact, or "various
        # people came" calls Aria — but in "hey anaa" nothing is being said except
        # somebody's name, so a letter out of place is a typo and not a
        # coincidence. Short names were staying silent at a plain greeting.
        return any(_matches_name(one, own, tokens, tolerant=True) for one in called)

    return _matches_name(text, own, tokens)


def _name_tokens(own: str) -> list[str]:
    """The words of a name worth matching on their own, so "picker-test" is
    reachable as "picker"."""
    return [
        t
        for t in _WORDS.findall(own)
        if len(t) >= 3 and t not in _SKIP and t != GENERIC_TOKEN
    ]


def _vocative_edits(token_len: int) -> int:
    """Typo budget for a name in the vocative slot.

    The same as anywhere else, except that a short name gets one edit instead
    of none. Nothing else is in that slot to collide with: the word after
    "hey" is who is being greeted.
    """
    return max(1, _max_edits(token_len)) if token_len >= 3 else 0


def _matches_name(
    text: str, own: str, tokens: list[str], *, tolerant: bool = False
) -> bool:
    """Does this text name the agent? The matching half of `is_addressed`, with
    none of the judgement about who the message is FOR — so the vocative check
    can ask "is this name mine?" without asking itself the outer question."""
    text = (text or "").lower()
    budget = _vocative_edits if tolerant else _max_edits

    # The full display name as a whole phrase, so "Helpful Assistant" answers to
    # "helpful assistant" but not to "helpful assistantship".
    if own != GENERIC_TOKEN and re.search(rf"(?<!\w){re.escape(own)}(?!\w)", text):
        return True

    # An agent literally called "Agent" answers to the bare word: there the word
    # is its whole name, and treating it as a generic noun would leave a
    # default-named agent unreachable without the sigil.
    if own == GENERIC_TOKEN and re.search(rf"(?<!\w){GENERIC_TOKEN}(?!\w)", text):
        return True

    if any(re.search(rf"(?<!\w){re.escape(t)}(?!\w)", text) for t in tokens):
        return True

    # The same name with a letter held down. Before the edit budget, because
    # this is the case the budget cannot reach: it is exactly the short names
    # that get no tolerance and exactly the short names a transcriber doubles.
    #
    # Three letters once squeezed, or not at all. Squeezing shortens, and a name
    # that comes out of it as two letters lands on ordinary words: "Ann" becomes
    # "an", which is in most English sentences, and "Lee" becomes "le". An agent
    # answering every sentence with an article in it is a worse failure than the
    # silence this was written to fix.
    squeezed = {q for t in tokens if len(q := _squeeze(t)) >= 3}
    if squeezed and any(_squeeze(word) in squeezed for word in _WORDS.findall(text)):
        return True

    fuzzy = [(t, budget(len(t))) for t in tokens]
    fuzzy = [(t, d) for t, d in fuzzy if d > 0]
    if not fuzzy:
        return False
    return any(
        _within(word, token, d)
        for word in _WORDS.findall(text)
        for token, d in fuzzy
    )


# A name at the head of the message, followed by a comma: "Anna, what time does
# it open?" That shape is a vocative, and it is the exact case the model kept
# answering over somebody's shoulder. Kept narrow on purpose — head position and
# a comma — so an ordinary sentence that happens to contain a name does not trip
# it.
_VOCATIVE = re.compile(r"^\s*(?:[\w.\- ]{1,24}:\s*)?([A-Za-z]{2,20})\s*,")

# The comma is the reliable signal, and people leave it out: "hey pepe you
# around" calls Pepe exactly as much as "Pepe, you around?". A greeting is a
# narrow enough opener to read the next word as the person being greeted.
_GREETING_VOCATIVE = re.compile(
    rf"^\s*(?:[\w.\- ]{{1,24}}:\s*)?(?:{_GREETINGS})\s+([A-Za-z]{{2,20}})\b",
    re.IGNORECASE,
)

# Words that follow a greeting without naming anybody. Kept generous, because
# the cost of a name missing from this list is a turn of silence and the cost of
# a common word being read as a name is a swallowed question.
_NOT_A_NAME = {
    "everyone", "everybody", "all", "guys", "folks", "people", "team", "crew",
    "group", "friends", "anyone", "anybody", "someone", "somebody", "there",
    "again", "how", "what", "who", "the", "and", "or", "for", "to", "of",
    "morning", "afternoon", "evening", "good",
}


# Whoever the message opens by calling: "Anna," / "hey ana" / "Anna and Pepe,".
# Several names because a message can open on more than one person, and reading
# only the first would silence everybody after the "y".
_SPEAKER_PREFIX = re.compile(r"^\s*[\w.\-\s]{1,24}:\s*")
_NAME = r"[A-Za-z]{2,20}"
# A greeting needs no comma: "hey ana ask…" calls Anna as plainly as "Anna,
# ask…" does. Joined only by conjunctions, never by a comma — a comma after a
# greeting ends the address rather than continuing it, and allowing one made
# "hey everyone, I need ana" read "I" as somebody's name.
_CALLED_AFTER_GREETING = re.compile(
    rf"^\s*(?:{_GREETINGS})\s+({_NAME}(?:\s*(?:y|e|and|&)\s*{_NAME})*)\b",
    re.IGNORECASE,
)
# Without a greeting the comma is what makes it a vocative rather than a
# sentence that happens to start with a name. Here a comma CAN join the list,
# because the closing comma is what ends it: "Anna, Pepe, vengan".
_CALLED_BEFORE_COMMA = re.compile(
    rf"^\s*({_NAME}(?:\s*(?:,|y|e|and|&)\s*{_NAME})*)\s*[,:]"
)


def _called_at_head(text: str) -> list[str]:
    """The names this message opens by calling. Empty when it opens on nobody."""
    body = _SPEAKER_PREFIX.sub("", text or "", count=1)
    match = _CALLED_AFTER_GREETING.match(body) or _CALLED_BEFORE_COMMA.match(body)
    if not match:
        return []
    parts = [
        part
        for raw in re.split(r"\s*(?:,|\by\b|\be\b|\band\b|&)\s*", match.group(1))
        if (part := raw.strip().lower())
    ]
    # All of them, or none. A head that mixes a name with a word that is not one
    # ("hey everyone, ...") is not a list of people being called — it is an
    # ordinary sentence that happened to fit the shape, and reading half of it
    # as a vocative would silence everybody it did not name.
    if any(part in _NOT_A_NAME or part in _NOT_A_CALL for part in parts):
        return []
    return parts


# Openers that are not somebody's name. "Hey, ..." opens with a greeting; the
# rest are the acknowledgements people start a line with.
_NOT_A_CALL = {
    "hey", "hi", "hello", "yo", "howdy", "hiya", "ok", "okay", "well",
    "thanks", "thank", "yes", "no", "sure", "right", "sorry", "look",
    "listen", "actually", "so", "wait",
}


def addresses_another(text: str, name: str) -> bool:
    """Whether the message opens by calling someone who is not the agent.

    Only ever used to withhold a reply, never to force one: a wrong "yes" costs
    one turn, and the layer stays biased toward speaking everywhere else.
    """
    if is_addressed(text, name):
        return False
    match = _VOCATIVE.match(text or "") or _GREETING_VOCATIVE.match(text or "")
    if not match:
        return False
    called = match.group(1)
    if called.lower() in _NOT_A_NAME:
        return False
    # "Hey, ..." and friends open with a greeting, not with a name.
    if called.lower() in _NOT_A_CALL:
        return False
    return not is_addressed(called, name)
