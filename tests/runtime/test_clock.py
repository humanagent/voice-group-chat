"""The time, told rather than looked up."""

from datetime import datetime, timedelta, timezone

from src.policy import clock


def test_it_states_the_hour_and_the_zone() -> None:
    """An agent that knows the hour but not the zone still guesses wrong for
    whoever is reading."""
    at = datetime(2026, 8, 28, 17, 8, tzinfo=timezone(timedelta(hours=-3)))
    note = clock.now_note(at)
    assert "17:08" in note
    assert "28 August 2026" in note
    assert "UTC-0300" in note
    assert note.startswith("\n\n")


def test_it_is_one_sentence() -> None:
    """It rides at the tail of the turn note, beside the participation line —
    anything longer would be paying prompt for a fact worth one line."""
    note = clock.now_note()
    assert note.strip().count(".") == 1
    assert len(note) < 90


def test_a_zone_that_is_just_an_offset_is_not_said_twice() -> None:
    """%Z is not always a name. Depending on the platform and the tzinfo it can
    be "-03" or "UTC-03:00", and pairing either with the offset says one fact
    twice: "(-03, UTC-0300)"."""
    at = datetime(2026, 8, 28, 17, 8, tzinfo=timezone(timedelta(hours=-3)))
    assert clock.now_note(at).endswith("(UTC-0300).")
    assert clock.now_note(datetime(2026, 8, 28, 17, 8, tzinfo=timezone.utc)).endswith(
        "(UTC)."
    )


def test_a_time_that_carries_a_zone_keeps_it() -> None:
    """`astimezone()` CONVERTS an aware datetime to the local zone. Right for a
    naive `now()`, wrong for a time handed in already carrying one — which is
    how a test pinning 17:08-03:00 read 20:08 on a UTC machine."""
    at = datetime(2026, 8, 28, 17, 8, tzinfo=timezone(timedelta(hours=-3)))
    assert "17:08" in clock.now_note(at)
