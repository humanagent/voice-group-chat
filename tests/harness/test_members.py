from __future__ import annotations

from src.members import speakers_in


def test_a_prefixed_line_names_its_speaker() -> None:
    assert speakers_in("Steve: hey") == ["Steve"]


def test_a_coalesced_burst_names_everyone_in_it() -> None:
    assert speakers_in("Steve: hey\nJordan: yes\nSteve: sure") == ["Steve", "Jordan"]


def test_an_unprefixed_line_names_nobody() -> None:
    """Typing without a name is how most messages arrive, and it must not
    invent a member out of the first words."""
    assert speakers_in("hey how are you") == []
    assert speakers_in("") == []


def test_something_long_before_the_colon_is_not_a_name() -> None:
    """URLs and prose carry colons. A name is short, so the cap is what stops
    'Relativity is Einstein's idea: ...' from joining the dm."""
    assert speakers_in("https://example.com/x: mira esto") == []
    assert speakers_in("una frase larguisima que sigue y sigue y sigue: y termina") == []


def test_someone_typing_without_a_name_is_still_in_the_chat() -> None:
    """Most messages arrive unprefixed. Leaving them out made the header
    disagree with the agent, which knew who it was talking to."""
    from src.members import UNNAMED

    class _Fake:
        def __init__(self, payload): self.payload = payload
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): 
            import json
            return json.dumps(self.payload).encode()

    import urllib.request
    from src import members as mod

    def listed(messages):
        original = urllib.request.urlopen
        urllib.request.urlopen = lambda *a, **k: _Fake({"data": messages})
        try:
            return mod.members("h", "c", "k")
        finally:
            urllib.request.urlopen = original

    # Nobody has named themselves: the person typing is the only member there
    # is, so they need a placeholder.
    assert listed([{"role": "user", "content": "hey agent"}]) == [UNNAMED]

    # Somebody has. One person alternating between "Fabri: hey" and "hey" is
    # one person, and listing them twice described the notation, not the room.
    assert listed([
        {"role": "user", "content": "Fabri: hey"},
        {"role": "user", "content": "hey agent"},
        {"role": "assistant", "content": "hey"},
    ]) == ["Fabri"]
