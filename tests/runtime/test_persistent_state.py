"""What the object looks like on the other side of a write.

A persistent write is a transaction over a live object graph, so the
interesting failures are not about the file — they are about what is left in
memory afterwards. An alias two callers share, a private attribute, a slot, a
container whose members point back at it: after a commit each must be the
committed thing, and after a rollback each must be exactly what it was, down to
identity. These are the cases that get that wrong.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import ClassVar, cast
from unittest.mock import patch

import pytest
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    ValidationError,
    field_validator,
    model_validator,
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


def test_failed_validator_nested_mutations_leave_complete_state_and_disk_unchanged(
    tmp_path,
):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = "ok"
        public_state: dict[str, list[str]] = Field(
            default_factory=lambda: {"values": ["public"]}
        )
        _private_state: dict[str, list[str]] = PrivateAttr(
            default_factory=lambda: {"values": ["private"]}
        )
        model_config = ConfigDict(validate_assignment=True, extra="allow")

        @model_validator(mode="after")
        def mutate_then_reject_bad_name(self):
            if self.name == "bad":
                self.public_state["values"].append("failed-public")
                self._private_state["values"].append("failed-private")
                self.extra_state["values"].append("failed-extra")
                raise ValueError("bad name")
            return self

    m = _M()
    m.extra_state = {"values": ["extra"]}
    before_disk = path.read_bytes()
    before_dump = m.model_dump()
    before_private = list(m._private_state["values"])

    with pytest.raises(ValidationError):
        m.name = "bad"

    assert path.read_bytes() == before_disk
    assert m.model_dump() == before_dump
    assert m._private_state["values"] == before_private

    m.name = "saved"
    assert "failed" not in path.read_text(encoding="utf-8")
    assert _M().model_dump() == m.model_dump()


def test_update_suspends_nested_validator_assignments_and_honors_subclass_setattr(
    tmp_path,
):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = ""
        validator_events: list[str] = Field(default_factory=list)
        _private_events: list[str] = PrivateAttr(default_factory=list)
        setattr_names: ClassVar[list[str]] = []

        def __setattr__(self, name: str, value: object) -> None:
            if not name.startswith("_"):
                type(self).setattr_names.append(name)
            super().__setattr__(name, value)

        @property
        def validation_note(self) -> None:
            return None

        @validation_note.setter
        def validation_note(self, value: str) -> None:
            self.validator_events.append(value)
            self._private_events.append(value)

        @model_validator(mode="after")
        def record_assignment(self):
            if self.name and self._persistence_is_suspended():
                self.validation_note = self.name
            return self

    m = _M()
    _M.setattr_names.clear()

    with patch("src.lib.persistent.os.replace", wraps=os.replace) as replace:
        m.update(name="after")

    assert replace.call_count == 1
    assert {"name", "validation_note"} <= set(_M.setattr_names)
    assert m.validator_events == ["after"]
    assert m._private_events == ["after"]
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "name": "after",
        "validator_events": ["after"],
    }
    assert _M().model_dump() == {
        "name": "after",
        "validator_events": ["after"],
    }


def test_successful_update_preserves_untouched_aliases_and_private_runtime_identity(
    tmp_path,
):
    path = tmp_path / "m.json"

    class _Runtime:
        pass

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = ""
        public_value: object = None
        _private_alias: object = PrivateAttr()
        _runtime: object = PrivateAttr()

    m = _M()
    shared = {"stable": ["value"]}
    runtime = _Runtime()
    m.public_value = shared
    m._private_alias = shared
    m._runtime = runtime
    assert m.public_value is shared
    assert m._private_alias is shared

    m.update(name="changed")

    assert m.public_value is shared
    assert m._private_alias is shared
    assert m.public_value is m._private_alias
    assert m._runtime is runtime
    assert _M().name == "changed"


def test_failed_assignment_from_existing_alias_cannot_mutate_live_state(tmp_path):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        values: list[str] = Field(default_factory=lambda: ["stable"])
        alias: list[str] | None = None

        @model_validator(mode="after")
        def mutate_alias_then_fail(self):
            if self.alias is not None:
                self.alias.append("failed")
                raise ValueError("reject alias")
            return self

    m = _M()
    before_disk = path.read_bytes()
    values = m.values

    with pytest.raises(ValidationError):
        m.alias = m.values

    assert path.read_bytes() == before_disk
    assert m.values is values
    assert m.values == ["stable"]
    assert m.alias is None


def test_successful_assignment_from_existing_alias_preserves_live_identity(tmp_path):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        values: list[str] = Field(default_factory=lambda: ["stable"])
        alias: list[str] | None = None

    m = _M()
    values = m.values

    m.alias = m.values

    assert m.values is values
    assert m.alias is values


def test_hostile_container_keys_preserve_state_without_invoking_equality(tmp_path):
    class _RaisingKey:
        __slots__ = ()

        equality_calls = 0

        def __hash__(self) -> int:
            return 1

        def __eq__(self, other: object) -> bool:
            type(self).equality_calls += 1
            victims[0].name = "corrupted"
            raise RuntimeError("hostile equality was called")

        def __deepcopy__(self, memo: dict[int, object]):
            copied = type(self)()
            memo[id(self)] = copied
            return copied

    class _M(PersistentModel):
        name: str = "before"
        _container: object = PrivateAttr()

    victims: list[_M] = []
    for kind in ("set", "dict"):
        path = tmp_path / f"{kind}.json"
        m = _M(file_path=path)
        victims[:] = [m]
        key = _RaisingKey()
        container: object
        if kind == "set":
            container = {key}
        else:
            container = {key: "value"}
        m._container = container

        with patch("src.lib.persistent.os.replace", wraps=os.replace) as replace:
            m.update(name="after")

        assert replace.call_count == 1
        assert _RaisingKey.equality_calls == 0
        assert m.model_dump() == {"name": "after"}
        assert m._container is container
        assert json.loads(path.read_text(encoding="utf-8")) == {"name": "after"}
        assert _M(file_path=path).model_dump() == {"name": "after"}


def test_slot_only_validator_mutation_commits_candidate_state_after_persist(tmp_path):
    path = tmp_path / "m.json"

    class _SlotValue:
        __slots__ = ("value",)

        def __init__(self, value: str) -> None:
            self.value = value

        def __deepcopy__(self, memo: dict[int, object]):
            copied = type(self)(self.value)
            memo[id(self)] = copied
            return copied

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = ""
        value: object = Field(default_factory=lambda: _SlotValue("before"))

        @model_validator(mode="after")
        def mutate_slot_on_assignment(self):
            if self.name == "after":
                self.value.value = "changed"
            return self

        def model_dump(self, *args: object, **kwargs: object) -> dict[str, object]:
            return {"name": self.name, "value": self.value.value}

    m = _M()
    before_value = m.value
    m.name = "after"

    assert m.value is not before_value
    assert m.value.value == "changed"
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "name": "after",
        "value": "changed",
    }


def test_unusable_private_runtime_handle_does_not_block_unrelated_write(tmp_path):
    path = tmp_path / "m.json"

    class _OpaqueHandle:
        __slots__ = ()

        def __deepcopy__(self, memo: dict[int, object]):
            raise TypeError("runtime handle")

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = ""
        _handle: object = PrivateAttr()

    m = _M()
    handle = _OpaqueHandle()
    m._handle = handle

    m.name = "saved"

    assert m._handle is handle
    assert _M().name == "saved"


def test_noncopyable_private_mutable_state_rejects_transaction_before_write(tmp_path):
    path = tmp_path / "m.json"

    class _MutableRuntime:
        def __init__(self) -> None:
            self.value = "stable"

        def __deepcopy__(self, memo: dict[int, object]):
            raise TypeError("mutable runtime")

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = ""
        _runtime: object = PrivateAttr()

    m = _M()
    runtime = _MutableRuntime()
    m._runtime = runtime
    before_disk = path.read_bytes()

    with pytest.raises(
        TypeError, match="private attribute '_runtime' cannot be copied"
    ):
        m.name = "failed"

    assert path.read_bytes() == before_disk
    assert m.name == ""
    assert m._runtime is runtime


def test_validator_mutation_does_not_restore_a_changed_incoming_alias(tmp_path):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        values: list[str] = Field(default_factory=lambda: ["stable"])
        alias: list[str] | None = None

        @model_validator(mode="after")
        def append_to_alias(self):
            if self.alias is not None and self._persistence_is_suspended():
                self.alias.append("validated")
            return self

    m = _M()
    original = m.values

    m.alias = m.values

    assert m.values is original
    assert m.values == ["stable"]
    assert m.alias is not original
    assert m.alias == ["stable", "validated"]
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "values": ["stable"],
        "alias": ["stable", "validated"],
    }
    assert _M().model_dump() == {
        "values": ["stable"],
        "alias": ["stable", "validated"],
    }


def test_validator_replacement_does_not_restore_an_equal_incoming_alias(tmp_path):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        alias: list[str] | None = None

        @field_validator("alias")
        @classmethod
        def detach_alias(cls, value: list[str] | None) -> list[str] | None:
            return list(value) if value is not None else None

    m = _M()
    caller_value = ["stable"]

    m.alias = caller_value

    assert m.alias is not caller_value
    caller_value.append("not-persisted")
    assert m.alias == ["stable"]
    assert json.loads(path.read_text(encoding="utf-8")) == {"alias": ["stable"]}


def test_equal_valued_type_coercion_does_not_restore_an_incoming_alias(tmp_path):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        integers: list[int] = Field(default_factory=lambda: [1])
        floats: list[float] | None = None

    m = _M()
    original = m.integers

    m.floats = m.integers

    assert m.integers is original
    assert m.floats is not original
    assert m.floats == [1.0]
    assert type(m.floats[0]) is float


def test_equal_valued_dict_key_coercion_does_not_restore_an_incoming_alias(
    tmp_path,
):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        integers: dict[int, str] = Field(default_factory=lambda: {1: "one"})
        floats: dict[float, str] | None = None

    m = _M()
    original = m.integers

    m.floats = m.integers

    assert m.integers is original
    assert m.floats is not original
    assert m.floats == {1.0: "one"}
    assert type(next(iter(m.floats))) is float
    assert list(json.loads(path.read_text(encoding="utf-8"))["floats"]) == ["1.0"]
    reloaded = _M()
    assert reloaded.floats == {1.0: "one"}
    assert type(next(iter(reloaded.floats))) is float


def test_serializer_mutation_cannot_diverge_committed_state_from_payload(tmp_path):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = "before"
        marker: str = "before"
        serialize_calls: ClassVar[int] = 0

        def model_dump(self, *args: object, **kwargs: object) -> dict[str, object]:
            data = super().model_dump(*args, **kwargs)
            if self.name == "after":
                self.marker = "mutated-by-serializer"
            return data

        @classmethod
        def _serialize(cls, data: dict[str, object]) -> str:
            cls.serialize_calls += 1
            return json.dumps(data)

    m = _M()
    _M.serialize_calls = 0

    m.name = "after"

    assert _M.serialize_calls == 1
    assert m.marker == "before"
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "name": "after",
        "marker": "before",
    }
    assert _M().model_dump() == m.model_dump()


def test_private_slot_mutation_is_committed_after_persist(tmp_path):
    path = tmp_path / "m.json"

    class _PrivateSlot:
        __slots__ = ("__token",)

        def __init__(self, token: str) -> None:
            self.__token = token

        @property
        def token(self) -> str:
            return self.__token

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = ""
        value: object = Field(default_factory=lambda: _PrivateSlot("before"))

        @model_validator(mode="after")
        def mutate_private_slot(self):
            if self.name == "after":
                value = cast(_PrivateSlot, self.value)
                value._PrivateSlot__token = "after"
            return self

        def model_dump(self, *args: object, **kwargs: object) -> dict[str, object]:
            value = cast(_PrivateSlot, self.value)
            return {"name": self.name, "token": value.token}

    m = _M()
    live_value = m.value

    m.name = "after"

    assert m.value is not live_value
    assert cast(_PrivateSlot, m.value).token == "after"
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "name": "after",
        "token": "after",
    }


def test_mapping_pairing_avoids_permuting_indistinguishable_keys(tmp_path):
    path = tmp_path / "m.json"

    class _Key:
        __slots__ = ()

        def __deepcopy__(self, memo: dict[int, object]):
            copied = type(self)()
            memo[id(self)] = copied
            return copied

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = ""
        values: object = Field(default_factory=dict)

        @model_validator(mode="after")
        def make_one_value_different(self):
            if self.name == "after":
                key = next(iter(self.values))
                self.values[key] = "changed"
            return self

        def model_dump(self, *args: object, **kwargs: object) -> dict[str, object]:
            return {"name": self.name}

    m = _M()
    m.values = {_Key(): "stable" for _ in range(9)}

    with patch.object(
        PersistentModel,
        "_state_value_unchanged",
        wraps=PersistentModel._state_value_unchanged,
    ) as unchanged:
        m.name = "after"

    assert unchanged.call_count < 500


def test_large_set_does_not_overflow_matching_recursion(tmp_path):
    path = tmp_path / "m.json"

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = ""
        values: set[int] = Field(default_factory=set)

    m = _M(values=set(range(1_100)))

    m.name = "after"

    assert m.name == "after"


def test_frozenset_member_backref_uses_committed_container(tmp_path):
    path = tmp_path / "m.json"

    class _Member:
        def __init__(self) -> None:
            self.changed = "before"
            self.backref: frozenset[_Member] | None = None

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = "before"
        members: object

        @model_validator(mode="after")
        def mutate_member(self):
            if self.name == "after":
                next(iter(cast(frozenset[_Member], self.members))).changed = "after"
            return self

        def model_dump(self, *args: object, **kwargs: object) -> dict[str, object]:
            return {"name": self.name}

    member = _Member()
    members = frozenset({member})
    member.backref = members
    m = _M(members=members)

    m.name = "after"

    committed_members = cast(frozenset[_Member], m.members)
    committed_member = next(iter(committed_members))
    assert committed_members is not members
    assert committed_member.backref is committed_members


def test_inherited_slot_state_is_not_treated_as_a_stateless_runtime_handle(tmp_path):
    path = tmp_path / "m.json"

    class _StatefulBase:
        __slots__ = ("state",)

        def __init__(self) -> None:
            self.state: list[str] = ["live"]

        def __deepcopy__(self, memo: dict[int, object]):
            raise TypeError("stateful runtime")

    class _InheritedSlots(_StatefulBase):
        __slots__ = ()

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = ""
        _runtime: object = PrivateAttr()

    m = _M()
    runtime = _InheritedSlots()
    m._runtime = runtime
    before_disk = path.read_bytes()

    with pytest.raises(
        TypeError, match="private attribute '_runtime' cannot be copied"
    ):
        m.name = "failed"

    assert path.read_bytes() == before_disk
    assert m.name == ""
    assert m._runtime is runtime


def test_remap_preserves_nested_aliases_inside_changed_model_and_custom_state(tmp_path):
    path = tmp_path / "m.json"

    class _Nested(BaseModel):
        model_config = ConfigDict(extra="allow")

        changed: str = "before"
        stable: list[str]
        _private_state: list[str] = PrivateAttr()

    class _Custom:
        def __init__(self, stable: list[str]) -> None:
            self.changed = "before"
            self.stable = stable
            self.self_ref = self

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = "before"
        nested: _Nested
        custom: object

        @model_validator(mode="after")
        def mutate_nested_state(self):
            if self.name == "after":
                self.nested.changed = "after"
                self.custom.changed = "after"
            return self

        def model_dump(self, *args: object, **kwargs: object) -> dict[str, object]:
            return {
                "name": self.name,
                "nested": {"changed": self.nested.changed},
                "custom": {"changed": self.custom.changed},
            }

    nested_stable = ["nested"]
    nested_extra = ["extra"]
    nested_private = ["private"]
    nested = _Nested(stable=nested_stable)
    nested.extra_state = nested_extra
    nested._private_state = nested_private
    custom_stable = ["custom"]
    custom = _Custom(custom_stable)
    m = _M(nested=nested, custom=custom)
    live_nested = m.nested
    live_nested_stable = m.nested.stable
    live_nested_extra = m.nested.extra_state
    live_nested_private = m.nested._private_state
    live_custom = m.custom
    live_custom_stable = m.custom.stable

    m.name = "after"

    assert m.nested is not live_nested
    assert m.nested.stable is live_nested_stable
    assert m.nested.extra_state is live_nested_extra
    assert m.nested._private_state is live_nested_private
    assert m.custom is not live_custom
    assert m.custom.stable is live_custom_stable
    assert m.custom.self_ref is m.custom


def test_frozenset_backref_inside_a_tuple_uses_committed_container(tmp_path):
    """A tuple-wrapped backref must be repaired like a list-wrapped one.

    ``repair`` returns a replacement rather than mutating when it canonicalizes
    a frozenset. Tuples are immutable, so the sequence has to be rebuilt and
    written back — dropping the replacement leaves the member pointing at
    deepcopy's detached copy.
    """
    path = tmp_path / "m.json"

    class _Member:
        def __init__(self) -> None:
            self.changed = "before"
            self.backref: tuple[frozenset[_Member], ...] | None = None

    class _M(PersistentModel):
        file_path: ClassVar[Path] = path
        name: str = "before"
        members: object

        @model_validator(mode="after")
        def mutate_member(self):
            if self.name == "after":
                next(iter(cast(frozenset[_Member], self.members))).changed = "after"
            return self

        def model_dump(self, *args: object, **kwargs: object) -> dict[str, object]:
            return {"name": self.name}

    member = _Member()
    members = frozenset({member})
    member.backref = (members,)
    m = _M(members=members)

    m.name = "after"

    committed_members = cast(frozenset[_Member], m.members)
    committed_member = next(iter(committed_members))
    assert committed_members is not members
    assert committed_member.backref is not None
    assert committed_member.backref[0] is committed_members
