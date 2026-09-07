from __future__ import annotations

import pytest

from src.policy import checkins as c


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))


@pytest.mark.parametrize(
    "text",
    [
        "On it.",
        "On it — running the sweep now.",
        "Got it, checking now",
        "Pulling the latest now.",
        "Right away, digging into it now.",
        "On it. Running the numbers now.",
    ],
)
def test_pure_acknowledgement_is_noise(text: str) -> None:
    assert c.is_bare_ack(text)


@pytest.mark.parametrize(
    "text",
    [
        "Got it — 3 new listings found",
        "On it: next reminder is at 4pm",
        "Running the numbers now: 42 found",
        "Checking in on you right now",
        "Un haiku: la lluvia cae, el mate se enfria, alguien pregunta",
        "",
    ],
)
def test_anything_carrying_a_deliverable_ships(text: str) -> None:
    """Judged on the shape of the reply, never on whether a tool ran: a
    joke-of-the-day check-in uses no tools and is still the whole delivery."""
    assert not c.is_bare_ack(text)


def test_a_long_reply_is_never_an_ack() -> None:
    assert not c.is_bare_ack("On it. " * 40)


def test_the_same_delivery_twice_is_caught() -> None:
    post = "Hoy no llueve en Buenos Aires: 12% y 0 mm."
    assert not c.already_delivered(post)
    c.record_delivery(post)
    assert c.already_delivered(post)


def test_the_fingerprint_ignores_spacing_and_case() -> None:
    c.record_delivery("No rain today")
    assert c.already_delivered("  no   RAIN today ")


def test_a_different_delivery_is_not_caught() -> None:
    c.record_delivery("No rain today")
    assert not c.already_delivered("Rain tomorrow")
