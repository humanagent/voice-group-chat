"""Was the agent spoken to?"""

from src.policy.addressing import addresses_another, is_addressed

NAME = "Helpful Assistant"


def test_the_name_addresses_it() -> None:
    assert is_addressed("Assistant, what time do you open?", NAME)
    assert is_addressed("hey assistant do you know?", NAME)


def test_the_reserved_mention_addresses_any_agent() -> None:
    assert is_addressed("@agent do you know?", "Whatever")
    assert is_addressed("hey @AGENT", "Whatever")
    assert is_addressed("@agent what time is it", "Whatever")


def test_the_bare_word_does_not() -> None:
    assert not is_addressed("I need a real estate agent", NAME)
    assert not is_addressed("support@agent.com", NAME)
    assert not is_addressed("@agentic is another thing", NAME)


def test_a_typo_in_a_long_name_still_addresses_it() -> None:
    assert is_addressed("assistnt do you remember?", NAME)
    assert is_addressed("assistantt?", NAME)


def test_a_short_name_is_exact_outside_the_vocative() -> None:
    assert is_addressed("aria come here", "Aria")
    assert not is_addressed("various people came", "Aria")


def test_a_reply_to_the_agent_is_addressed_whatever_it_says() -> None:
    assert is_addressed("yes", NAME, is_reply_to_agent=True)


def test_a_message_opening_on_somebody_else_is_theirs() -> None:
    assert addresses_another("Anna, do you know when the post office opens?", NAME)
    assert addresses_another("Fabri: Anna, can you send me the link?", NAME)


def test_a_message_opening_on_the_agent_is_not() -> None:
    assert not addresses_another("Assistant, what time is it?", NAME)


def test_a_message_naming_somebody_else_first_is_theirs() -> None:
    """"Anna, ask Pepe the time" is a request to Anna.

    Pepe answering it is the over-the-shoulder mistake one step removed, and it
    costs twice: he answers, then Anna relays the question and he answers again,
    so the room gets the same reply from the same agent for one thing that was
    typed once.
    """
    for text in (
        "hey ana ask pepe what time it is",
        "Fabri: hey ana ask pepe what time it is",
        "Anna, ask Pepe what time it is",
    ):
        assert is_addressed(text, "Anna")
        assert not is_addressed(text, "Pepe")
        assert not is_addressed(text, "Jordan")


def test_being_named_in_the_opening_still_counts() -> None:
    """The message can open on more than one person."""
    for text in ("Anna and Pepe, come over", "Anna, Pepe, come over"):
        assert is_addressed(text, "Anna")
        assert is_addressed(text, "Pepe")
        assert not is_addressed(text, "Jordan")


def test_an_opening_that_names_nobody_leaves_the_message_open() -> None:
    assert is_addressed("pepe do you know the time?", "Pepe")
    assert is_addressed("hey everyone, I need pepe", "Pepe")
    assert is_addressed("hey pepe", "Pepe")


def test_the_sigil_outranks_the_vocative() -> None:
    """Someone deliberately pulling the agent into a message meant for another
    person is the one address never worth second-guessing."""
    assert is_addressed("Anna, tell @agent to answer", "Pepe")


def test_a_short_name_forgives_a_typo_when_it_is_being_called() -> None:
    """"hey anaa" is Anna, misspelled.

    Short names are exact everywhere else — "various people came" must not call
    Aria — but nothing shares the vocative slot: the word after a greeting is
    who is being greeted, so a letter out of place there is a typo, not a
    coincidence.
    """
    assert is_addressed("hey anaa", "Anna")
    assert is_addressed("hey anna", "Anna")
    assert is_addressed("hey jordn", "Jordan")
    assert not is_addressed("hey anaa", "Pepe")


def test_a_head_that_is_not_a_list_of_people_calls_nobody() -> None:
    """"hey everyone, I need ana" fits the vocative shape and is not one."""
    assert is_addressed("hey everyone, I need ana", "Anna")
    assert is_addressed("hey, ana", "Anna")
    assert not is_addressed("hey everyone, I need ana", "Pepe")


def test_a_doubled_letter_still_addresses_it() -> None:
    """"Ana" is how a transcriber listening in Spanish writes "Anna".

    Both spellings are the same sound, so which one comes back is a guess made
    by whatever language model heard it. It is also how somebody types a name
    they are unsure of, and how they type it when they are pleased to see her.
    Without this, every one of these was silence.
    """
    for text in ("Hi, Ana.", "ana, are you there?", "hey annna", "anaa!"):
        assert is_addressed(text, "Anna"), text


def test_a_doubled_letter_does_not_invent_a_name() -> None:
    assert not is_addressed("various people came", "Aria")
    assert not is_addressed("I need a real estate agent", NAME)


def test_a_squeezed_name_does_not_land_on_an_ordinary_word() -> None:
    """Collapsing runs shortens, and a short enough name lands on English.

    "Ann" squeezed is "an", which is in most sentences, and "Lee" is "le".
    An agent that answers every sentence with an article in it is a worse
    failure than the silence the squeeze was written to fix.
    """
    assert not is_addressed("we need an extra runner", "Ann")
    assert not is_addressed("le monde is a newspaper", "Lee")
    # And the name it was written for still works.
    assert is_addressed("we need an extra runner", "Anna") is False
    assert is_addressed("Ana, can you take this?", "Anna")
