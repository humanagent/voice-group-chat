from __future__ import annotations

import json
from pathlib import Path

from src.group import Agent, Line, briefing, cast, is_silence, roster


def test_a_line_carries_who_said_it() -> None:
    """An agent has no way to tell a person's line from another agent's, and no
    reason to: both are members of the room."""
    assert Line("Fabri", "hey").rendered() == "Fabri: hey"
    assert Line("Anna", "morning").rendered() == "Anna: morning"


def test_every_shape_of_silence_reads_as_silence() -> None:
    for reply in ("NO_REPLY", "SILENT", "  ", ""):
        assert is_silence(reply)
    assert not is_silence("hey")


def test_each_agent_gets_its_own_home() -> None:
    """Separate memory is what makes them separate agents rather than one
    wearing three names."""
    root = Path("/tmp/x")
    homes = {Agent(n, 9000, "k").home(root) for n in ("Anna", "Jordan", "Pepe")}
    assert len(homes) == 3


def test_the_roster_names_everyone_and_says_who_you_are() -> None:
    """Without it an agent knows only its own name, and cannot tell a question
    aimed at Jordan from one aimed at itself."""
    agents = [Agent("Anna", 9001, "k"), Agent("Jordan", 9002, "k")]
    text = roster(agents, ["Fabri"])
    assert "Fabri" in text and "Anna" in text and "Jordan" in text
    assert "{you}" in text, "each agent is told which of the names it is"


def test_the_roster_tells_them_not_to_write_the_prefix() -> None:
    """Lines arrive as "Name: text" and a model reads that as the format to
    write in: one answered with a bare colon and the question quoted back."""
    text = roster([Agent("Anna", 9001, "k")], ["Fabri"])
    assert "Do not write that prefix" in text


def _folder(tmp_path: Path, count: int) -> Path:
    (tmp_path / "personas").mkdir()
    for i in range(count):
        (tmp_path / "personas" / f"{i}.md").write_text(f"# Role {i}\n")
    (tmp_path / ".hermes").mkdir()
    return tmp_path


def test_every_agent_gets_a_different_person(tmp_path: Path) -> None:
    """Two agents playing the same person is the one outcome that makes the
    room pointless — they would agree about everything, for the same reasons."""
    root = _folder(tmp_path, 10)
    hands = cast(root, ["Anna", "Jordan", "Pepe"])
    assert len(hands) == 3
    assert len(set(hands)) == 3


def test_who_is_who_survives_clearing_the_room(tmp_path: Path) -> None:
    """A cleared context is the same people with nothing behind them. An agent
    that ran support before and runs security after is not a cleared room, it
    is a different person wearing the same name."""
    root = _folder(tmp_path, 10)
    names = ["Anna", "Jordan", "Pepe"]
    first = cast(root, names)
    assert cast(root, names) == first
    assert cast(root, names) == first


def test_an_agent_joining_later_takes_a_person_nobody_has(tmp_path: Path) -> None:
    """The ones already cast keep theirs, and the newcomer draws from what is
    left rather than doubling somebody."""
    root = _folder(tmp_path, 10)
    before = cast(root, ["Anna", "Jordan"])
    after = cast(root, ["Anna", "Jordan", "Pepe"])
    assert after[:2] == before
    assert after[2] not in before


def test_a_persona_that_disappeared_is_dealt_again(tmp_path: Path) -> None:
    """The written cast names files. One deleted between runs must not leave an
    agent holding nothing for the life of the room."""
    root = _folder(tmp_path, 3)
    cast(root, ["Anna"])
    held = json.loads((root / ".hermes" / "cast.json").read_text())
    (root / "personas" / held["Anna"]).unlink()
    assert cast(root, ["Anna"])[0] is not None


def test_more_agents_than_personas_still_opens_the_room(tmp_path: Path) -> None:
    """Whoever draws nothing is simply itself. Refusing to open the room would
    be a worse answer than a group where one member has no backstory."""
    root = _folder(tmp_path, 2)
    hands = cast(root, ["Anna", "Jordan", "Pepe", "Sam"])
    assert len([h for h in hands if h]) == 2
    assert hands.count(None) == 2


def test_no_personas_folder_is_not_an_error(tmp_path: Path) -> None:
    """The room worked before there were personas and has to keep working."""
    assert cast(tmp_path, ["Anna", "Jordan", "Pepe"]) == [None, None, None]


def test_the_briefing_says_the_persona_is_private() -> None:
    """The others cannot read it, which is the only reason the room is
    interesting — so an agent reciting it gives the game away."""
    text = briefing("# Staff Engineer\n")
    assert "yours alone" in text
    assert "never quote it" in text
    assert "# Staff Engineer" in text
