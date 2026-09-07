from __future__ import annotations

from src.policy import voice


def test_a_key_in_the_env_file_counts_as_set(tmp_path, monkeypatch) -> None:
    """The gateway loads .env at import, so a key sitting there is live for a
    turn. A status check that only read the shell called it missing while the
    audio was working."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("SPEAK_REPLIES", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    (tmp_path / ".env").write_text("ELEVENLABS_API_KEY=k\nSPEAK_REPLIES=1\n")

    assert voice.enabled()
    assert voice.why_not() == ""


def test_it_is_off_unless_both_the_switch_and_a_key_are_there(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    """A switch that silently does nothing is worse than one that is off, so
    the key is part of being enabled rather than a runtime surprise."""
    monkeypatch.delenv("SPEAK_REPLIES", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    assert not voice.enabled()

    monkeypatch.setenv("SPEAK_REPLIES", "1")
    assert not voice.enabled()
    assert voice.why_not() == "no ELEVENLABS_API_KEY"

    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    assert voice.enabled()
    assert voice.why_not() == ""


def test_a_provider_that_fails_costs_the_audio_not_the_answer(monkeypatch) -> None:
    """A reply you can read is worth more than one you can hear."""
    monkeypatch.setenv("SPEAK_REPLIES", "1")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")

    import sys
    import types

    module = types.ModuleType("tools.tts_tool")
    module.text_to_speech_tool = lambda text: (_ for _ in ()).throw(RuntimeError("down"))
    monkeypatch.setitem(sys.modules, "tools.tts_tool", module)

    assert voice.speak("hey") is None


def test_a_silent_turn_makes_no_audio(monkeypatch) -> None:
    monkeypatch.setenv("SPEAK_REPLIES", "1")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    assert voice.speak("") is None
    assert voice.speak("   ") is None


def test_no_voice_is_listed_twice() -> None:
    """It was: Adam appeared twice, so two of any three agents shared a voice
    however they were assigned — and the hashing took the blame for a typo."""
    from src.policy.voice import VOICES

    assert len(set(VOICES)) == len(VOICES)


def test_agents_in_a_group_never_share_a_voice() -> None:
    """Three agents reading in one voice is a transcript being narrated, not a
    room. Hashing the name alone collided: Jordan and Pepe drew the same one."""
    from src.policy.voice import VOICES, voice_for

    group = ["Anna", "Jordan", "Pepe"]
    voices = [voice_for(n, group) for n in group]
    assert len(set(voices)) == 3
    assert all(v in VOICES for v in voices)


def test_the_assignment_does_not_depend_on_how_they_were_listed() -> None:
    """Same room, different order in group.json — the same agent must keep its
    voice, or restarting reshuffles who sounds like whom."""
    from src.policy.voice import voice_for

    assert voice_for("Pepe", ["Anna", "Jordan", "Pepe"]) == voice_for(
        "Pepe", ["Pepe", "Anna", "Jordan"]
    )


def test_without_a_group_a_name_still_gets_a_stable_voice() -> None:
    from src.policy.voice import VOICES, voice_for

    assert voice_for("Anna") == voice_for("anna")
    assert voice_for("Anna") in VOICES


def test_the_audio_marker_comes_off_the_reply() -> None:
    """Every client has to undo the attachment. The group one did not: it
    printed the path into the conversation and then read it aloud."""
    from src.policy.voice import split

    audio, text = split("MEDIA:/tmp/a.mp3\nHey Fabri")
    assert audio == "/tmp/a.mp3"
    assert text == "Hey Fabri"
    assert split("Hey") == (None, "Hey")


def test_a_non_audio_attachment_is_left_alone() -> None:
    """Only audio is this layer's to strip; a document rides through."""
    from src.policy.voice import split

    audio, text = split("MEDIA:/tmp/report.pdf\nlisto")
    assert audio is None
    assert "report.pdf" in text


def test_emoji_never_reach_the_synthesiser() -> None:
    """They get read out as their names — "Hey Fabri waving hand" — which is
    the emoji being pronounced instead of felt."""
    from src.policy.voice import sayable

    assert sayable("Hey Fabri 👋") == "Hey Fabri"
    assert sayable("Sure 😄, see you") == "Sure, see you"
    assert sayable("🔥🔥 buenísimo") == "buenísimo"


def test_the_spacing_left_behind_is_cleaned_up() -> None:
    """A line that ended in an emoji must not end in a space before its stop."""
    from src.policy.voice import sayable

    assert sayable("Listo 👍 .") == "Listo."
    assert sayable("Good  👋  , thanks") == "Good, thanks"


def test_a_reply_that_was_only_an_emoji_is_not_spoken(monkeypatch, tmp_path) -> None:
    """Synthesising an empty string bills for silence."""
    from src.policy import voice

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("SPEAK_REPLIES", "1")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    assert voice.speak("👍") is None


def test_accents_and_punctuation_survive() -> None:
    """Only what cannot be pronounced goes. Accented letters are not collateral."""
    from src.policy.voice import sayable

    assert sayable("¿Cómo andás? Está bien 👍") == "¿Cómo andás? Está bien"
