from __future__ import annotations

from src.policy.questions import ensure_addressed

NAME = "Pepe"


ASKED = "Steve: Pepe, are you up for something?"


def guard(text: str, inbound: str | None = ASKED) -> str:
    return ensure_addressed(text, inbound=inbound, agent_name=NAME)


def test_the_observed_case_gets_a_name_on_it() -> None:
    """Steve asked Pepe by name; Pepe asked back into the void, and in a room
    that is a question nobody knows is theirs."""
    assert guard("Sure — what did you have in mind?") == (
        "Sure — what did you have in mind, Steve?"
    )


def test_a_statement_is_left_exactly_as_written() -> None:
    said = "Tomorrow works for me."
    assert guard(said) == said


def test_a_question_that_already_names_the_asker_is_untouched() -> None:
    said = "Steve, what did you have in mind?"
    assert guard(said) == said
    tail = "What did you have in mind, Steve?"
    assert guard(tail) == tail


def test_a_question_handed_to_somebody_else_keeps_its_own_addressee() -> None:
    """A redirect is already addressed. Adding the asker would put the question
    to two people at once, which is the ambiguity this exists to remove."""
    said = "Jordan, are you free Saturday?"
    assert guard(said) == said


def test_a_question_to_the_whole_room_stays_open() -> None:
    """Naming one member would narrow a question nobody meant to narrow."""
    assert guard("Is anyone free Saturday?") == "Is anyone free Saturday?"
    assert guard("¿Alguien puede el sábado?") == "¿Alguien puede el sábado?"


def test_an_unnamed_person_is_not_a_name_to_call() -> None:
    """A person types into the room as `you:` in the browser and the terminal
    client both. ", you?" is worse than the silence it would fix."""
    said = "Sure — what did you have in mind?"
    assert guard(said, inbound="you: pepe, want to do something tomorrow?") == said


def test_a_turn_nobody_started_has_nobody_to_name() -> None:
    said = "Anything I should pick up on the way?"
    assert guard(said, inbound=None) == said
    assert guard(said, inbound="") == said


def test_only_the_first_question_is_named() -> None:
    """One address settles who the reply is talking to; a name on every clause
    reads like a hostage video."""
    assert guard("What time? And where?") == "What time, Steve? And where?"


def test_the_name_lands_before_the_punctuation_not_inside_it() -> None:
    assert guard("Wait, really!?") == "Wait, really, Steve!?"
    assert guard("Hmm... what?") == "Hmm... what, Steve?"
    assert guard("¿Qué hora es?") == "¿Qué hora es, Steve?"


def test_a_bare_question_mark_is_left_alone() -> None:
    """Nothing in front of it to attach a name to, so nothing is done to it
    rather than opening the line with a comma."""
    assert guard("?") == "?"


def test_the_asker_is_whoever_called_the_agent() -> None:
    """A batch where somebody spoke after the question: the one who used the
    agent's name is the one waiting on the answer."""
    inbound = "Jordan: Pepe, are you around tomorrow?\nSteve: brb"
    said = "Should be — what time?"
    assert guard(said, inbound) == "Should be — what time, Jordan?"


def test_the_asker_is_the_last_to_speak_when_nobody_used_a_name() -> None:
    inbound = "Jordan: hey\nSteve: we still doing tomorrow"
    assert guard("Think so — what time?", inbound) == "Think so — what time, Steve?"


def test_a_misheard_name_still_counts_as_naming_the_asker() -> None:
    """The room arrives through speech-to-text and the outbound side inherits
    the same spellings. "Steeve" is Steve being called, not a second person."""
    said = "Steeve, what did you have in mind?"
    assert guard(said) == said


def test_the_room_s_own_machinery_is_not_somebody_to_call() -> None:
    """The opening roster arrives as "System: In this chat: …", and the first
    turn of every room answers it. Found in a real trace as "What do you need,
    System?"."""
    said = "I'm here. What do you need?"
    assert guard(said, inbound="System: In this chat: Fabri, Steve, Pepe.") == said
