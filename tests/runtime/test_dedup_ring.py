"""What the delivery memory owes its caller.

A bounded list of short strings, written whole. These are the properties
check-ins actually depend on; everything else this file used to guarantee was
guaranteeing it for nobody.
"""

from __future__ import annotations

import json

from src.lib.dedup_ring import DedupRing


def test_what_was_recorded_is_remembered(tmp_path) -> None:
    ring = DedupRing(tmp_path / "deliveries.json")
    assert not ring.contains("a")
    ring.record("a")
    assert ring.contains("a")
    assert not ring.contains("b")


def test_it_survives_the_process_that_wrote_it(tmp_path) -> None:
    """The whole point: a check-in has no memory of its last run, so the memory
    has to be the file rather than the object."""
    path = tmp_path / "deliveries.json"
    DedupRing(path).record("a")
    assert DedupRing(path).contains("a")


def test_recording_the_same_thing_twice_does_not_grow_it(tmp_path) -> None:
    ring = DedupRing(tmp_path / "deliveries.json")
    ring.record("a")
    ring.record("a")
    assert ring.ids() == ["a"]


def test_it_keeps_the_most_recent_and_forgets_the_rest(tmp_path) -> None:
    ring = DedupRing(tmp_path / "deliveries.json")
    for n in range(DedupRing.MAX_ENTRIES + 20):
        ring.record(str(n))
    ids = ring.ids()
    assert len(ids) == DedupRing.MAX_ENTRIES
    assert ids[0] == "20"
    assert ids[-1] == str(DedupRing.MAX_ENTRIES + 19)


def test_a_missing_or_unreadable_file_reads_as_no_memory(tmp_path) -> None:
    """Fail open, always. A delivery repeated is a worse outcome than a turn
    that could not run, so nothing here is allowed to raise."""
    assert DedupRing(tmp_path / "nothing.json").ids() == []

    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text("{not json", encoding="utf-8")
    assert DedupRing(corrupt).ids() == []
    assert not DedupRing(corrupt).contains("a")

    wrong_shape = tmp_path / "wrong.json"
    wrong_shape.write_text('{"ids": ["a"]}', encoding="utf-8")
    assert DedupRing(wrong_shape).ids() == []


def test_a_corrupt_file_is_recovered_by_the_next_write(tmp_path) -> None:
    path = tmp_path / "corrupt.json"
    path.write_text("{not json", encoding="utf-8")
    DedupRing(path).record("a")
    assert json.loads(path.read_text(encoding="utf-8")) == ["a"]


def test_it_creates_the_directory_it_was_pointed_at(tmp_path) -> None:
    ring = DedupRing(tmp_path / "made" / "up" / "deliveries.json")
    ring.record("a")
    assert ring.contains("a")


def test_it_leaves_no_temporary_files_behind(tmp_path) -> None:
    ring = DedupRing(tmp_path / "deliveries.json")
    for n in range(5):
        ring.record(str(n))
    assert [p.name for p in tmp_path.iterdir()] == ["deliveries.json"]
