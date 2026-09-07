"""Writing, and not writing.

The contract a persistent model owes its file: a change reaches disk, it
reaches it exactly once, a change that changes nothing writes nothing at all,
and a write that fails at any step leaves the file exactly as it found it.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import ClassVar
from unittest.mock import patch

import pytest
from pydantic import (
    ConfigDict,
    ValidationError,
)

from src.lib.persistent import PersistentModel


def _model_class(path: Path):
    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str | None = None
        count: int = 0

    return _M


def _extra_model_class(path: Path):
    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str | None = None
        count: int = 0
        model_config = ConfigDict(validate_assignment=True, extra="allow")

    return _M


def test_creates_file_with_defaults_when_absent(tmp_path):
    Cls = _model_class(tmp_path / "m.json")
    m = Cls()
    assert (tmp_path / "m.json").is_file()
    assert m.count == 0


def test_does_not_rewrite_on_construction_when_file_exists(tmp_path):
    Cls = _model_class(tmp_path / "m.json")
    Cls(name="x")  # creates file
    mtime_before = (tmp_path / "m.json").stat().st_mtime_ns
    bytes_before = (tmp_path / "m.json").read_bytes()
    Cls()  # second construction
    assert (tmp_path / "m.json").stat().st_mtime_ns == mtime_before
    assert (tmp_path / "m.json").read_bytes() == bytes_before


def test_attribute_assignment_persists(tmp_path):
    Cls = _model_class(tmp_path / "m.json")
    m = Cls()
    m.name = "hello"
    reloaded = Cls()
    assert reloaded.name == "hello"


def test_update_persists_exactly_once(tmp_path):
    path = tmp_path / "m.json"
    Cls = _model_class(path)
    m = Cls()
    with patch("src.lib.persistent.os.replace", wraps=os.replace) as replace:
        m.update(name="x", count=5)
    assert replace.call_count == 1
    assert path.read_text(encoding="utf-8")
    assert Cls().model_dump() == {"name": "x", "count": 5}


def test_validation_error_leaves_file_unchanged(tmp_path):
    Cls = _model_class(tmp_path / "m.json")
    m = Cls(name="ok")
    before = (tmp_path / "m.json").read_bytes()
    before_dump = m.model_dump()
    with pytest.raises(ValidationError):
        m.count = "not-an-int"  # pyright: ignore[reportAssignmentType]
    assert (tmp_path / "m.json").read_bytes() == before
    assert m.model_dump() == before_dump

    m.count = 7
    assert "not-an-int" not in (tmp_path / "m.json").read_text()


@pytest.mark.parametrize("failure", ["serialize", "fsync", "replace"])
def test_assignment_persist_failures_restore_memory_and_disk(tmp_path, failure):
    path = tmp_path / "m.json"
    Cls = _model_class(path)
    m = Cls(name="ok")
    before = path.read_bytes()
    before_dump = m.model_dump()

    if failure == "serialize":
        failing_operation = patch.object(
            Cls, "_serialize", side_effect=OSError("serialize failed")
        )
    elif failure == "fsync":
        failing_operation = patch(
            "src.lib.persistent.os.fsync", side_effect=OSError("fsync failed")
        )
    else:
        failing_operation = patch(
            "src.lib.persistent.os.replace", side_effect=OSError("replace failed")
        )

    with failing_operation:
        with pytest.raises(OSError):
            m.name = "failed"

    assert path.read_bytes() == before
    assert m.model_dump() == before_dump

    m.name = "saved"
    assert "failed" not in path.read_text()
    assert Cls().model_dump() == m.model_dump()


def test_replace_failure_leaves_file_unchanged_and_no_tmp(tmp_path):
    Cls = _model_class(tmp_path / "m.json")
    m = Cls(name="ok")
    before = (tmp_path / "m.json").read_bytes()
    with patch("src.lib.persistent.os.replace", side_effect=OSError("boom")):
        with pytest.raises(OSError):
            m.name = "x"
    assert (tmp_path / "m.json").read_bytes() == before
    leftovers = [p for p in tmp_path.iterdir() if p.name.startswith(".m.json.")]
    assert leftovers == []


@pytest.mark.parametrize("failure", ["validation", "serialize", "fsync", "replace"])
def test_update_failure_restores_extras_and_fields_set(tmp_path, failure):
    path = tmp_path / "m.json"
    Cls = _extra_model_class(path)
    m = Cls(name="ok")
    m.existing_extra = "keep"
    before = path.read_bytes()
    before_dump = m.model_dump()
    before_extra = m.__pydantic_extra__.copy()
    before_fields_set = m.__pydantic_fields_set__.copy()
    changes: dict[str, object] = {
        "name": "failed-name",
        "failed_extra": "failed-extra",
    }

    if failure == "validation":
        changes["count"] = "not-an-int"
        failing_operation = None
    elif failure == "serialize":
        failing_operation = patch.object(
            Cls, "_serialize", side_effect=OSError("serialize failed")
        )
    elif failure == "fsync":
        failing_operation = patch(
            "src.lib.persistent.os.fsync", side_effect=OSError("fsync failed")
        )
    else:
        failing_operation = patch(
            "src.lib.persistent.os.replace", side_effect=OSError("replace failed")
        )

    if failing_operation is None:
        with pytest.raises(ValidationError):
            m.update(**changes)
    else:
        with failing_operation:
            with pytest.raises(OSError):
                m.update(**changes)

    assert path.read_bytes() == before
    assert m.model_dump() == before_dump
    assert m.__pydantic_extra__ == before_extra
    assert m.__pydantic_fields_set__ == before_fields_set

    m.update(name="saved", saved_extra="saved-extra", count=7)
    assert "failed" not in path.read_text()
    assert Cls().model_dump() == m.model_dump()


def test_file_path_constructor_override_routes_writes_to_supplied_path(tmp_path):
    """Two instances with different paths each persist to their own file."""
    path_a = tmp_path / "a.json"
    path_b = tmp_path / "b.json"

    class _M(PersistentModel):
        value: str = ""

    inst_a = _M(file_path=path_a, value="for-a")
    inst_b = _M(file_path=path_b, value="for-b")

    assert path_a.is_file()
    assert path_b.is_file()

    # Mutate and verify each writes to its own file.
    inst_a.value = "changed-a"
    inst_b.value = "changed-b"

    reloaded_a = _M(file_path=path_a)
    reloaded_b = _M(file_path=path_b)
    assert reloaded_a.value == "changed-a"
    assert reloaded_b.value == "changed-b"


def test_update_with_no_changes_keeps_state_identity_and_does_not_write(tmp_path):
    Cls = _model_class(tmp_path / "m.json")
    m = Cls(name="stable")
    data = m.__dict__
    fields_set = m.__pydantic_fields_set__
    private = m.__pydantic_private__

    with patch("src.lib.persistent.os.replace", wraps=os.replace) as replace:
        m.update()

    assert replace.call_count == 0
    assert m.__dict__ is data
    assert m.__pydantic_fields_set__ is fields_set
    assert m.__pydantic_private__ is private


def test_update_after_object_setattr_suspension_reuses_unlinked_state_file(tmp_path):
    path = tmp_path / "m.json"
    Cls = _model_class(path)
    m = Cls(name="old")

    # Match callers that suppress persistence with object.__setattr__, which
    # shadows Pydantic's private attribute in __dict__.
    object.__setattr__(m, "_suspend_persist", True)
    try:
        m.name = None
    finally:
        object.__setattr__(m, "_suspend_persist", False)
    path.unlink()

    with patch("src.lib.persistent.os.replace", wraps=os.replace) as replace:
        m.update(name="fresh")

    assert replace.call_count == 1
    assert path.is_file()
    assert Cls().model_dump() == {"name": "fresh", "count": 0}
