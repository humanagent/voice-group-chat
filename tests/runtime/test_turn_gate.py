from __future__ import annotations

import pytest

from src.policy import checkins, participation
from src.policy.turn_gate import judge

NAME = "agent"


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))


def call(**kw):
    base = dict(
        text="hey",
        chat="r",
        agent_name=NAME,
        inbound="Fabri: agent, hey",
        is_system_turn=False,
        is_review_turn=False,
        has_suppress_token=False,
    )
    return judge(**{**base, **kw})


def test_an_ordinary_addressed_turn_speaks() -> None:
    assert call(inbound="Fabri: agent, hey").speak


def test_paused_stops_the_words_and_the_effects() -> None:
    participation.set_mode("r", participation.PAUSED)
    v = call()
    assert not v.speak and not v.keep_effects


def test_a_silent_turn_still_ships_what_it_made() -> None:
    """Hiding text and cancelling effects are different switches: a turn with
    nothing to say may still have produced a file."""
    v = call(has_suppress_token=True)
    assert not v.speak and v.keep_effects


def test_mentions_only_withholds_the_reply_and_the_attachments() -> None:
    """Staying quiet while still posting things is not staying quiet."""
    participation.set_mode("r", participation.MENTION)
    v = call(inbound="Anna: hey jordan did you see the time")
    assert not v.speak and not v.keep_effects
    assert call(inbound="Fabri: agent, what time is it").speak


def test_a_question_aimed_at_another_member_is_left_alone() -> None:
    """In `speak` the model would otherwise get to judge this one, and it judged
    it wrong: it answered over Anna's shoulder."""
    participation.set_mode("r", participation.SPEAK)
    v = call(inbound="Fabri: Anna, do you know what time it opens?")
    assert not v.speak and v.reason == "addressed to someone else"


def test_a_scheduled_turn_that_only_acknowledges_says_nothing() -> None:
    v = call(text="On it — running the sweep now.", is_system_turn=True)
    assert not v.speak and v.reason == "bare acknowledgement"


def test_a_scheduled_turn_with_a_deliverable_ships() -> None:
    assert call(text="3 new listings on Guatemala St.", is_system_turn=True).speak


def test_a_scheduled_turn_does_not_post_the_same_thing_twice() -> None:
    post = "Hoy no llueve: 12% y 0 mm."
    assert call(text=post, is_system_turn=True).speak
    checkins.record_delivery(post)
    assert not call(text=post, is_system_turn=True).speak


def test_a_human_turn_may_repeat_itself_freely() -> None:
    """The fingerprint is for scheduled work, which has no memory of its last
    run. A person asking the same thing twice deserves the same answer twice."""
    post = "Hoy no llueve: 12% y 0 mm."
    checkins.record_delivery(post)
    assert call(text=post, is_system_turn=False).speak


def test_a_maintenance_review_never_speaks_whatever_it_produced() -> None:
    """Unlike a check-in, a review can never carry something the chat asked
    for — so it is silenced on kind, not on the shape of its reply."""
    v = call(text="Saved.", is_system_turn=True, is_review_turn=True)
    assert not v.speak and v.reason == "background review turn"
    assert not v.keep_effects
