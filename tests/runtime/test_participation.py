from __future__ import annotations

import pytest

from src.policy import participation as p


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))


def test_a_room_starts_in_mentions_only() -> None:
    """The agent is a member of the conversation, not a participant in it."""
    assert p.mode("chat-1") == p.MENTION


def test_a_mode_survives_being_written_and_read_back() -> None:
    p.set_mode("chat-1", p.SPEAK)
    assert p.mode("chat-1") == p.SPEAK
    assert p.mode("chat-2") == p.MENTION


def test_an_unknown_mode_is_refused_rather_than_stored() -> None:
    with pytest.raises(ValueError):
        p.set_mode("chat-1", "quiet-ish")
    assert p.mode("chat-1") == p.MENTION


def test_a_corrupt_file_falls_back_to_the_default(tmp_path) -> None:
    """A broken state file leaves the agent behaving as configured, rather than
    picking either extreme on its behalf."""
    (tmp_path / "participation.json").write_text("{ not json")
    assert p.mode("chat-1") == p.DEFAULT


def test_only_the_rooms_that_differ_are_listed() -> None:
    p.set_mode("a", p.PAUSED)
    p.set_mode("b", p.MENTION)
    assert p.all_modes() == {"a": p.PAUSED}


def test_speak_says_nothing_to_the_model() -> None:
    """In `speak` the rest of the layer is the instruction; a preamble would
    only be noise in the prompt."""
    p.set_mode("r", p.SPEAK)
    assert p.preamble("r", addressed=False) == ""


def test_mentions_only_tells_the_model_which_turn_it_is() -> None:
    p.set_mode("r", p.MENTION)
    named = p.preamble("r", addressed=True)
    assert "your name is in this message" in named
    quiet = p.preamble("r", addressed=False)
    assert "SILENT" in quiet
    # Still biased toward speaking where it is genuinely unclear.
    assert "unsure" in quiet


def test_being_named_is_told_and_never_ordered() -> None:
    """The check is a fact about the text; whether the message was MEANT for
    this agent is a judgement, and the model is the one holding the sentence.

    "Steve, tell Pepe to say hi" carries Pepe's name, so the check says addressed.
    Ending that note with "Answer it." made him answer a request that was Steve's
    to relay — and answer again when she relayed it.
    """
    p.set_mode("r", p.MENTION)
    named = p.preamble("r", addressed=True)
    assert "Answer it." not in named
    assert "Being named is not being addressed" in named
    # The distinction, shown rather than described: one it should answer, one
    # somebody else was asked to relay.
    assert "yours. Answer." in named
    assert "Wait for her to ask you." in named
    # And it still leans toward speaking when it cannot tell.
    assert "Unsure? Answer." in named


def test_a_paused_room_says_so_before_the_model_writes_anything() -> None:
    p.set_mode("r", p.PAUSED)
    assert "paused" in p.preamble("r", addressed=True)
