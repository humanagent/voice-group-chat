from __future__ import annotations

import json
import os  # noqa: F401  # pyright: ignore[reportUnusedImport] -- I/O failure-injection seam
import tempfile  # noqa: F401  # pyright: ignore[reportUnusedImport] -- I/O failure-injection seam
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar, cast

from typing_extensions import override

from pydantic import BaseModel, ConfigDict, PrivateAttr

from .atomic_fs import atomic_write_text


def _object_mapping(value: object) -> dict[object, object] | None:
    """Narrow a runtime mapping without constraining its arbitrary graph."""
    if not isinstance(value, dict):
        return None
    return cast(dict[object, object], value)


def _object_sequence(value: object) -> list[object] | tuple[object, ...] | None:
    if not isinstance(value, (list, tuple)):
        return None
    return cast(list[object] | tuple[object, ...], value)


def _object_set(value: object) -> set[object] | frozenset[object] | None:
    if not isinstance(value, (set, frozenset)):
        return None
    return cast(set[object] | frozenset[object], value)


def _instance_state(value: object) -> dict[str, object] | None:
    """Return an object's instance mapping while retaining its runtime semantics."""
    if not hasattr(value, "__dict__"):
        return None
    return cast(dict[str, object], vars(value))


def _pydantic_state(model: BaseModel, name: str) -> dict[str, object] | None:
    return cast(
        dict[str, object] | None,
        object.__getattribute__(model, name),
    )


def _pydantic_fields_set(model: BaseModel) -> set[str]:
    return cast(set[str], object.__getattribute__(model, "__pydantic_fields_set__"))


@dataclass(frozen=True)
class _MappingCommitPlan:
    removals: tuple[str, ...]
    replacements: tuple[tuple[str, object], ...]


@dataclass(frozen=True)
class _OptionalMappingCommitPlan:
    replace_mapping: bool
    replacement: dict[str, object] | None
    changes: _MappingCommitPlan


@dataclass(frozen=True)
class _CommitPlan:
    data: _MappingCommitPlan
    fields_set: frozenset[str] | None
    extra: _OptionalMappingCommitPlan
    private: _OptionalMappingCommitPlan


class PersistentModel(BaseModel):
    """
    A Pydantic model that is backed by a file on disk.

    Subclasses must set `file_path` as a ClassVar, or pass it as a
    constructor keyword argument for per-instance routing.  Override
    `_serialize` / `_deserialize` to support formats other than JSON.

    Reads: the model is loaded once on construction and held in memory.
    Writes: every attribute assignment is flushed to disk atomically.

    Known limitations:
    - Not safe for concurrent writers (no flock). Two processes or threads
      writing the same file will clobber each other. If concurrency is
      needed, add `fcntl.flock` (POSIX) or switch to SQLite.
    - Nested model mutations don't trigger writes. `cfg.sub.x = 1` fires
      `__setattr__` on the submodel, not on the parent. Reassign the whole
      submodel (`cfg.sub = cfg.sub.model_copy(update={"x": 1})`) or call
      `cfg._persist()` manually after nested edits.
    - In-place mutation of list/dict fields doesn't trigger writes for the
      same reason. Use `cfg.items = [*cfg.items, new]` rather than
      `cfg.items.append(new)`.
    - Every write rewrites the whole file. Fine up to a few MB.
    - A private runtime handle that rejects deepcopy is reused only when it
      has no instance or slot state. Assignment validators must not mutate
      those opaque handles. A private value with observable mutable state
      that cannot be copied rejects persistent mutations before validation.
    """

    # Subclasses override this. ClassVar keeps it out of the schema.
    file_path: ClassVar[str | Path]

    # Pydantic v2 config: validate on assignment so type checks run on every
    # set, and allow us to suspend persistence during bulk updates.
    model_config: ClassVar[ConfigDict] = ConfigDict(validate_assignment=True)

    _suspend_persist: bool = PrivateAttr(default=False)
    _file_path_override: str | Path | None = PrivateAttr(default=None)

    # ---- construction ---------------------------------------------------

    def __init__(
        self, *, file_path: str | Path | None = None, **overrides: object
    ) -> None:
        """Load from disk if the file exists, then apply any overrides.

        Pass ``file_path`` to route writes to a specific path rather than the
        ClassVar.  Two instances with different paths coexist safely — each
        reads and writes its own file.
        """
        effective_path: Path
        if file_path is not None:
            effective_path = Path(file_path)
        else:
            effective_path = Path(self.__class__.file_path)

        data: dict[str, object] = {}
        if effective_path.exists():
            raw = effective_path.read_text(encoding="utf-8")
            if raw.strip():
                data = self._deserialize(raw)
        data.update(overrides)

        super().__init__(**data)
        # Store the per-instance override so _persist() picks it up.
        # Use Pydantic's private attr channel so __pydantic_private__ is populated.
        if file_path is not None:
            private = cast(
                dict[str, object],
                object.__getattribute__(self, "__pydantic_private__"),
            )
            private["_file_path_override"] = effective_path
        # If the file didn't exist, write the defaults out so disk
        # reflects state. A second construction on an existing file
        # therefore does NOT rewrite the file.
        if not effective_path.exists():
            self._persist()

    # ---- hooks for subclasses ------------------------------------------

    @classmethod
    def _serialize(cls, data: dict[str, object]) -> str:
        return json.dumps(data, indent=2, default=str)

    @classmethod
    def _deserialize(cls, raw: str) -> dict[str, object]:
        return cast(dict[str, object], json.loads(raw))

    # ---- write-through --------------------------------------------------

    @override
    def __setattr__(self, name: str, value: object) -> None:
        # Don't persist private attrs or during suspended updates.
        # Without these guards, setting `_suspend_persist = True` would
        # itself trigger a write, and `update()` would write per-iteration.
        if name.startswith("_"):
            super().__setattr__(name, value)
            return
        if self._persistence_is_suspended():
            super().__setattr__(name, value)
            return

        self._mutate_and_persist({name: value})

    def _persistence_is_suspended(self) -> bool:
        """Read suspension without trusting a shadowed private attribute.

        Pydantic private attributes live in ``__pydantic_private__``, but
        callers that use ``object.__setattr__`` can leave a same-named value
        in ``__dict__``. Honor both representations while staging, so an old
        shadow cannot make a candidate recursively persist itself.
        """
        try:
            private = _pydantic_state(self, "__pydantic_private__")
        except AttributeError:
            private = None
        private_suspended = bool(private and private.get("_suspend_persist", False))
        try:
            shadowed = cast(
                dict[str, object],
                object.__getattribute__(self, "__dict__"),
            ).get("_suspend_persist", False)
        except AttributeError:
            shadowed = False
        return private_suspended or bool(shadowed)

    def _isolated_candidate(self) -> tuple[PersistentModel, dict[int, object]]:
        """Return a complete, independently mutable model copy.

        Pydantic's ``model_copy(deep=True)`` deep-copies each state mapping
        separately. ``deepcopy(self)`` carries one memo through fields,
        extras, and private attributes, preserving aliases while isolating
        validators that mutate nested containers.
        """
        memo: dict[int, object] = {}
        private = _pydantic_state(self, "__pydantic_private__") or {}
        for name, value in private.items():
            try:
                deepcopy(value)
            except Exception as error:
                if self._is_opaque_private_runtime(value):
                    memo[id(value)] = value
                    continue
                raise TypeError(
                    f"{type(self).__name__} private attribute {name!r} cannot "
                    "be copied for transactional persistence"
                ) from error
        candidate = deepcopy(self, memo)
        self._repair_frozenset_copy_cycles(candidate, memo)
        return candidate, memo

    def _repair_frozenset_copy_cycles(
        self,
        candidate: PersistentModel,
        memo: dict[int, object],
    ) -> None:
        """Restore frozenset identity that ``deepcopy`` loses in cycles.

        ``deepcopy`` cannot memoize a frozenset until its members are copied.
        A mutable member that points back to its enclosing frozenset can
        therefore receive a detached, equal container. Normalize that copy
        artifact before validators run, without changing deliberate validator
        replacements later in the transaction.
        """
        canonical_frozensets: dict[int, frozenset[object]] = {}
        visited: set[tuple[int, int]] = set()

        def matching_value(before_value: object, after_values: object) -> object | None:
            copied = memo.get(id(before_value), before_value)
            for after_value in cast(tuple[object, ...], after_values):
                if after_value is copied:
                    return after_value
            return None

        def repair_mapping(
            before_mapping: Mapping[object, object], after_mapping: dict[object, object]
        ) -> None:
            updates: list[tuple[object, object]] = []
            after_items = tuple(after_mapping.items())
            for before_key, before_value in before_mapping.items():
                after_key = matching_value(before_key, (key for key, _ in after_items))
                if after_key is None:
                    continue
                after_value = next(
                    value for key, value in after_items if key is after_key
                )
                repaired_key = repair(before_key, after_key)
                repaired_value = repair(before_value, after_value)
                if repaired_key is not after_key or repaired_value is not after_value:
                    updates.append((after_key, repaired_value))
            for key, value in updates:
                after_mapping[key] = value

        def repair(before: object, after: object) -> object:
            if type(before) is not type(after):
                return after
            if isinstance(before, frozenset):
                canonical = canonical_frozensets.get(id(before))
                if canonical is not None:
                    return canonical
                canonical_frozensets[id(before)] = cast(frozenset[object], after)

            pair = (id(before), id(after))
            if pair in visited:
                return after
            visited.add(pair)

            before_mapping = _object_mapping(before)
            if before_mapping is not None:
                after_mapping = _object_mapping(after)
                if after_mapping is not None:
                    repair_mapping(before_mapping, after_mapping)
                return after
            before_sequence = _object_sequence(before)
            after_sequence = _object_sequence(after)
            if before_sequence is not None and after_sequence is not None:
                rebuilt = list(after_sequence)
                changed = False
                for index, (before_value, after_value) in enumerate(
                    zip(before_sequence, after_sequence, strict=False)
                ):
                    repaired_value = repair(before_value, after_value)
                    if repaired_value is not after_value:
                        rebuilt[index] = repaired_value
                        changed = True
                if changed:
                    # A list is repaired in place so aliases to it stay valid;
                    # a tuple is immutable, so it has to be rebuilt and handed
                    # back for the caller to write through.
                    if isinstance(after_sequence, list):
                        after_sequence[:] = rebuilt
                    else:
                        return tuple(rebuilt)
                return after
            before_set = _object_set(before)
            after_set = _object_set(after)
            if before_set is not None and after_set is not None:
                for before_value in before_set:
                    after_value = matching_value(before_value, tuple(after_set))
                    if after_value is not None:
                        repair(before_value, after_value)
                return after
            if isinstance(before, BaseModel):
                after_model = cast(BaseModel, after)
                before_state = _instance_state(before)
                after_state = _instance_state(after_model)
                if before_state is not None and after_state is not None:
                    repair_mapping(
                        cast(Mapping[object, object], before_state),
                        cast(dict[object, object], after_state),
                    )
                before_extra = _pydantic_state(before, "__pydantic_extra__")
                after_extra = _pydantic_state(after_model, "__pydantic_extra__")
                if before_extra and after_extra:
                    repair_mapping(
                        cast(Mapping[object, object], before_extra),
                        cast(dict[object, object], after_extra),
                    )
                before_private = _pydantic_state(before, "__pydantic_private__")
                after_private = _pydantic_state(after_model, "__pydantic_private__")
                if before_private and after_private:
                    repair_mapping(
                        cast(Mapping[object, object], before_private),
                        cast(dict[object, object], after_private),
                    )
                return after

            before_dict = _instance_state(before)
            after_dict = _instance_state(after)
            if before_dict is not None and after_dict is not None:
                repair_mapping(
                    cast(Mapping[object, object], before_dict),
                    cast(dict[object, object], after_dict),
                )
            for name in self._slot_names(before):
                try:
                    before_value = cast(object, object.__getattribute__(before, name))
                    after_value = cast(object, object.__getattribute__(after, name))
                except AttributeError:
                    continue
                repaired_value = repair(before_value, after_value)
                if repaired_value is not after_value:
                    object.__setattr__(after, name, repaired_value)
            return after

        repair(self, candidate)

    @classmethod
    def _slot_names(cls, value: object) -> tuple[str, ...]:
        """Return every concrete slot an instance can carry, including bases."""
        names: list[str] = []
        for base in type(value).__mro__:
            slots = base.__dict__.get("__slots__", ())
            if isinstance(slots, str):
                slots = (slots,)
            for name in slots:
                if name in {"__dict__", "__weakref__"}:
                    continue
                if name.startswith("__") and not name.endswith("__"):
                    name = f"_{base.__name__.lstrip('_')}{name}"
                if name not in names:
                    names.append(name)
        return tuple(names)

    @classmethod
    def _is_opaque_private_runtime(cls, value: object) -> bool:
        """Whether a non-copyable private value has no observable state."""
        return not hasattr(value, "__dict__") and not cls._slot_names(value)

    @classmethod
    def _mapping_pairs(
        cls,
        before: dict[object, object],
        after: dict[object, object],
        seen: set[tuple[int, int]],
        *,
        include_values: bool,
        memo: dict[int, object] | None,
    ) -> tuple[tuple[object, object], ...] | None:
        """Match mapping values by strict keys without hash/equality lookup."""
        if len(before) != len(after):
            return None
        before_items = tuple(before.items())
        after_items = tuple(after.items())

        compatible: list[list[int]] = []
        for old_key, old_value in before_items:
            matches: list[int] = []
            for candidate_index, (new_key, new_value) in enumerate(after_items):
                trial_seen = set(seen)
                if not cls._state_value_unchanged(
                    old_key, new_key, trial_seen, memo=memo
                ):
                    continue
                if include_values and not cls._state_value_unchanged(
                    old_value, new_value, trial_seen, memo=memo
                ):
                    continue
                matches.append(candidate_index)
            if not matches:
                return None
            compatible.append(matches)

        matched_by_old = cls._match_compatible_values(compatible, len(after_items))
        if matched_by_old is None:
            return None
        pairs: list[tuple[object, object]] = []
        for old_index, (old_key, old_value) in enumerate(before_items):
            new_key, new_value = after_items[matched_by_old[old_index]]
            if not cls._state_value_unchanged(old_key, new_key, seen, memo=memo):
                return None
            if include_values and not cls._state_value_unchanged(
                old_value, new_value, seen, memo=memo
            ):
                return None
            pairs.append((old_value, new_value))

        return tuple(pairs)

    @staticmethod
    def _match_compatible_values(
        compatible: list[list[int]],
        candidate_count: int,
    ) -> tuple[int, ...] | None:
        """Find a complete bipartite matching without recursion.

        Each breadth-first augmenting-path search runs in O(E), making the
        complete matching polynomial while avoiding a call stack proportional
        to collection size.
        """
        matched_by_old = [-1] * len(compatible)
        matched_by_candidate = [-1] * candidate_count
        for start in range(len(compatible)):
            pending = [start]
            seen_old = {start}
            seen_candidate: set[int] = set()
            parent_candidate = [-1] * candidate_count
            unmatched_candidate = -1

            for old_index in pending:
                for candidate_index in compatible[old_index]:
                    if candidate_index in seen_candidate:
                        continue
                    seen_candidate.add(candidate_index)
                    parent_candidate[candidate_index] = old_index
                    if matched_by_candidate[candidate_index] == -1:
                        unmatched_candidate = candidate_index
                        break
                    next_old = matched_by_candidate[candidate_index]
                    if next_old not in seen_old:
                        seen_old.add(next_old)
                        pending.append(next_old)
                if unmatched_candidate != -1:
                    break

            if unmatched_candidate == -1:
                return None

            candidate_index = unmatched_candidate
            while candidate_index != -1:
                old_index = parent_candidate[candidate_index]
                previous_candidate = matched_by_old[old_index]
                matched_by_old[old_index] = candidate_index
                matched_by_candidate[candidate_index] = old_index
                candidate_index = previous_candidate

        return tuple(matched_by_old)

    @classmethod
    def _set_pairs(
        cls,
        before: set[object] | frozenset[object],
        after: set[object] | frozenset[object],
        seen: set[tuple[int, int]],
        *,
        memo: dict[int, object] | None,
    ) -> tuple[tuple[object, object], ...] | None:
        """Match set members by strict state without invoking member equality."""
        if len(before) != len(after):
            return None
        before_values = tuple(before)
        after_values = tuple(after)

        compatible: list[list[int]] = []
        for old_value in before_values:
            matches: list[int] = []
            for candidate_index, new_value in enumerate(after_values):
                trial_seen = set(seen)
                if cls._state_value_unchanged(
                    old_value, new_value, trial_seen, memo=memo
                ):
                    matches.append(candidate_index)
            if not matches:
                return None
            compatible.append(matches)

        matched_by_old = cls._match_compatible_values(compatible, len(after_values))
        if matched_by_old is None:
            return None
        pairs: list[tuple[object, object]] = []
        for old_index, old_value in enumerate(before_values):
            new_value = after_values[matched_by_old[old_index]]
            if not cls._state_value_unchanged(old_value, new_value, seen, memo=memo):
                return None
            pairs.append((old_value, new_value))
        return tuple(pairs)

    @classmethod
    def _state_value_unchanged(
        cls,
        before: object,
        after: object,
        seen: set[tuple[int, int]] | None = None,
        *,
        memo: dict[int, object] | None = None,
    ) -> bool:
        """Compare complete state without accepting equal-but-different types."""
        if type(before) is not type(after):
            return False
        if seen is None:
            seen = set()
        pair = (id(before), id(after))
        if any(old_id == pair[0] and new_id != pair[1] for old_id, new_id in seen):
            return False
        if any(old_id != pair[0] and new_id == pair[1] for old_id, new_id in seen):
            return False
        if pair in seen:
            return True
        seen.add(pair)
        if before is after:
            return True

        before_mapping = _object_mapping(before)
        if before_mapping is not None:
            after_mapping = _object_mapping(after)
            if after_mapping is None:
                return False
            return (
                cls._mapping_pairs(
                    before_mapping,
                    after_mapping,
                    seen,
                    include_values=True,
                    memo=memo,
                )
                is not None
            )
        before_sequence = _object_sequence(before)
        if before_sequence is not None:
            after_sequence = _object_sequence(after)
            if after_sequence is None:
                return False
            return len(before_sequence) == len(after_sequence) and all(
                cls._state_value_unchanged(old, new, seen, memo=memo)
                for old, new in zip(before_sequence, after_sequence, strict=True)
            )
        before_set = _object_set(before)
        if before_set is not None:
            after_set = _object_set(after)
            return (
                after_set is not None
                and cls._set_pairs(before_set, after_set, seen, memo=memo) is not None
            )
        if isinstance(before, BaseModel):
            after_model = cast(BaseModel, after)
            return (
                cls._state_value_unchanged(
                    _instance_state(before),
                    _instance_state(after_model),
                    seen,
                    memo=memo,
                )
                and _pydantic_fields_set(before) == _pydantic_fields_set(after_model)
                and cls._state_value_unchanged(
                    _pydantic_state(before, "__pydantic_extra__"),
                    _pydantic_state(after_model, "__pydantic_extra__"),
                    seen,
                    memo=memo,
                )
                and cls._state_value_unchanged(
                    _pydantic_state(before, "__pydantic_private__"),
                    _pydantic_state(after_model, "__pydantic_private__"),
                    seen,
                    memo=memo,
                )
            )

        before_dict = _instance_state(before)
        after_dict = _instance_state(after)
        if before_dict is not None or after_dict is not None:
            if before_dict is None or after_dict is None:
                return False
            if not cls._state_value_unchanged(before_dict, after_dict, seen, memo=memo):
                return False
        slots = cls._slot_names(before)
        if slots:
            for name in slots:
                try:
                    before_slot = cast(object, object.__getattribute__(before, name))
                except AttributeError:
                    try:
                        object.__getattribute__(after, name)
                    except AttributeError:
                        continue
                    return False
                try:
                    after_slot = cast(object, object.__getattribute__(after, name))
                except AttributeError:
                    return False
                if not cls._state_value_unchanged(
                    before_slot, after_slot, seen, memo=memo
                ):
                    return False
            return True
        if before_dict is not None:
            return True

        if type(before) in {
            type(None),
            bool,
            bytes,
            complex,
            float,
            int,
            range,
            str,
        }:
            return before == after

        # A slotless opaque value is unchanged only when deepcopy's shared
        # memo proves this exact candidate is its copy. Never call user
        # equality for state we cannot inspect.
        return memo is not None and memo.get(id(before)) is after

    @classmethod
    def _reusable_values(
        cls,
        current: object,
        candidate: object,
        memo: dict[int, object],
    ) -> dict[int, object]:
        """Map unchanged copies throughout supported Pydantic/object state."""
        reusable: dict[int, object] = {}
        visited: set[tuple[int, int]] = set()
        comparison_seen: set[tuple[int, int]] = set()

        def state_unchanged(before: object, after: object) -> bool:
            trial_seen = set(comparison_seen)
            if not cls._state_value_unchanged(before, after, trial_seen, memo=memo):
                return False
            comparison_seen.update(trial_seen)
            return True

        def visit(before: object, after: object) -> None:
            pair = (id(before), id(after))
            if pair in visited:
                return
            visited.add(pair)
            if type(before) is not type(after):
                return
            if state_unchanged(before, after):
                reusable[id(after)] = before
                return

            before_mapping = _object_mapping(before)
            if before_mapping is not None:
                after_mapping = _object_mapping(after)
                if after_mapping is None:
                    return
                trial_seen = set(comparison_seen)
                pairs = cls._mapping_pairs(
                    before_mapping,
                    after_mapping,
                    trial_seen,
                    include_values=False,
                    memo=memo,
                )
                if pairs is not None:
                    comparison_seen.update(trial_seen)
                    for old_value, new_value in pairs:
                        visit(old_value, new_value)
                return
            before_sequence = _object_sequence(before)
            if before_sequence is not None:
                after_sequence = _object_sequence(after)
                if after_sequence is None:
                    return
                for old_value, new_value in zip(
                    before_sequence, after_sequence, strict=False
                ):
                    visit(old_value, new_value)
                return
            before_set = _object_set(before)
            if before_set is not None:
                after_set = _object_set(after)
                if after_set is None:
                    return
                trial_seen = set(comparison_seen)
                pairs = cls._set_pairs(before_set, after_set, trial_seen, memo=memo)
                if pairs is not None:
                    comparison_seen.update(trial_seen)
                    for old_value, new_value in pairs:
                        visit(old_value, new_value)
                return
            if isinstance(before, BaseModel):
                after_model = cast(BaseModel, after)
                visit(_instance_state(before), _instance_state(after_model))
                before_extra = _pydantic_state(before, "__pydantic_extra__")
                after_extra = _pydantic_state(after_model, "__pydantic_extra__")
                if before_extra and after_extra:
                    visit(before_extra, after_extra)
                before_private = _pydantic_state(before, "__pydantic_private__")
                after_private = _pydantic_state(after_model, "__pydantic_private__")
                if before_private and after_private:
                    visit(before_private, after_private)
                return

            before_dict = _instance_state(before)
            after_dict = _instance_state(after)
            if before_dict is not None and after_dict is not None:
                visit(before_dict, after_dict)
            for name in cls._slot_names(before):
                try:
                    old_value = cast(object, object.__getattribute__(before, name))
                    new_value = cast(object, object.__getattribute__(after, name))
                except AttributeError:
                    continue
                visit(old_value, new_value)

        visit(current, candidate)
        return reusable

    @classmethod
    def _plan_state_mapping(
        cls,
        current: dict[str, object],
        candidate: dict[str, object],
        memo: dict[int, object],
        forced_names: set[str],
        reusable: dict[int, object],
        remap_memo: dict[int, object],
    ) -> _MappingCommitPlan:
        """Compute state changes before making the durable replacement."""
        removals = tuple(name for name in current if name not in candidate)
        replacements: list[tuple[str, object]] = []
        for name, value in candidate.items():
            if (
                name not in current
                or name in forced_names
                or not cls._state_value_unchanged(current[name], value, memo=memo)
            ):
                replacements.append(
                    (name, cls._remap_commit_value(value, reusable, remap_memo))
                )
        return _MappingCommitPlan(removals, tuple(replacements))

    @classmethod
    def _remap_commit_value(
        cls,
        value: object,
        reusable: dict[int, object],
        remap_memo: dict[int, object],
        in_progress: set[int] | None = None,
        immutable_cycles: set[int] | None = None,
    ) -> object:
        """Restore aliases through mutable containers and object state graphs."""
        if id(value) in reusable:
            return reusable[id(value)]
        if id(value) in remap_memo:
            if in_progress is not None and id(value) in in_progress:
                if immutable_cycles is not None:
                    immutable_cycles.add(id(value))
            return remap_memo[id(value)]
        if in_progress is None:
            in_progress = set()
        if immutable_cycles is None:
            immutable_cycles = set()
        if isinstance(value, list):
            value = cast(list[object], value)
            remap_memo[id(value)] = value
            value[:] = [
                cls._remap_commit_value(
                    item, reusable, remap_memo, in_progress, immutable_cycles
                )
                for item in value
            ]
            return value
        if isinstance(value, dict):
            value = cast(dict[object, object], value)
            remap_memo[id(value)] = value
            items = [
                (
                    cls._remap_commit_value(
                        key, reusable, remap_memo, in_progress, immutable_cycles
                    ),
                    cls._remap_commit_value(
                        item, reusable, remap_memo, in_progress, immutable_cycles
                    ),
                )
                for key, item in value.items()
            ]
            value.clear()
            value.update(items)
            return value
        if isinstance(value, tuple):
            value = cast(tuple[object, ...], value)
            remap_memo[id(value)] = value
            in_progress.add(id(value))
            items = tuple(
                cls._remap_commit_value(
                    item, reusable, remap_memo, in_progress, immutable_cycles
                )
                for item in value
            )
            in_progress.remove(id(value))
            if all(old is new for old, new in zip(value, items, strict=True)):
                return value
            if id(value) in immutable_cycles:
                raise TypeError(
                    "PersistentModel cannot remap a changed cyclic immutable tuple"
                )
            remapped_tuple = tuple(items)
            remap_memo[id(value)] = remapped_tuple
            return remapped_tuple
        if isinstance(value, set):
            value = cast(set[object], value)
            remap_memo[id(value)] = value
            items = {
                cls._remap_commit_value(
                    item, reusable, remap_memo, in_progress, immutable_cycles
                )
                for item in value
            }
            value.clear()
            value.update(items)
            return value
        if isinstance(value, frozenset):
            # Build and register the replacement before traversing mutable
            # members. A member can refer back to this frozenset, and must
            # receive the committed container rather than the detached copy.
            remapped_set = frozenset(tuple(value))
            remap_memo[id(value)] = remapped_set
            in_progress.add(id(value))
            items = tuple(
                cls._remap_commit_value(
                    item, reusable, remap_memo, in_progress, immutable_cycles
                )
                for item in value
            )
            in_progress.remove(id(value))
            if all(old is new for old, new in zip(value, items, strict=True)):
                return remapped_set
            if id(value) in immutable_cycles:
                raise TypeError(
                    "PersistentModel cannot remap a changed cyclic immutable frozenset"
                )
            remapped_set = frozenset(items)
            remap_memo[id(value)] = remapped_set
            return remapped_set
        if isinstance(value, BaseModel):
            remap_memo[id(value)] = value
            state = cast(dict[str, object], _instance_state(value))
            cls._remap_mapping(
                state,
                reusable,
                remap_memo,
                in_progress,
                immutable_cycles,
            )
            extra = _pydantic_state(value, "__pydantic_extra__")
            if extra is not None:
                cls._remap_mapping(
                    extra,
                    reusable,
                    remap_memo,
                    in_progress,
                    immutable_cycles,
                )
            private = _pydantic_state(value, "__pydantic_private__")
            if private is not None:
                cls._remap_mapping(
                    private,
                    reusable,
                    remap_memo,
                    in_progress,
                    immutable_cycles,
                )
            return value

        value_dict = _instance_state(value)
        slots = cls._slot_names(value)
        if value_dict is not None or slots:
            remap_memo[id(value)] = value
            if value_dict is not None:
                cls._remap_mapping(
                    value_dict, reusable, remap_memo, in_progress, immutable_cycles
                )
            for name in slots:
                try:
                    old_value = cast(object, object.__getattribute__(value, name))
                except AttributeError:
                    continue
                new_value = cls._remap_commit_value(
                    old_value, reusable, remap_memo, in_progress, immutable_cycles
                )
                if new_value is not old_value:
                    object.__setattr__(value, name, new_value)
            return value
        return value

    @classmethod
    def _remap_mapping(
        cls,
        mapping: dict[str, object] | dict[object, object],
        reusable: dict[int, object],
        remap_memo: dict[int, object],
        in_progress: set[int],
        immutable_cycles: set[int],
    ) -> None:
        mutable_mapping = cast(dict[object, object], mapping)
        live_mapping = reusable.get(id(mutable_mapping))
        if isinstance(live_mapping, dict):
            mutable_mapping.clear()
            mutable_mapping.update(cast(dict[object, object], live_mapping))
            return
        items = [
            (
                cls._remap_commit_value(
                    key, reusable, remap_memo, in_progress, immutable_cycles
                ),
                cls._remap_commit_value(
                    value, reusable, remap_memo, in_progress, immutable_cycles
                ),
            )
            for key, value in mutable_mapping.items()
        ]
        mutable_mapping.clear()
        mutable_mapping.update(items)

    @classmethod
    def _plan_optional_state_mapping(
        cls,
        current: dict[str, object] | None,
        candidate: dict[str, object] | None,
        memo: dict[int, object],
        forced_names: set[str],
        reusable: dict[int, object],
        remap_memo: dict[int, object],
    ) -> _OptionalMappingCommitPlan:
        """Plan an optional Pydantic extra/private state mapping commit."""
        if candidate is None:
            return _OptionalMappingCommitPlan(
                current is not None,
                None,
                _MappingCommitPlan((), ()),
            )
        if current is None:
            replacement = {
                name: cls._remap_commit_value(value, reusable, remap_memo)
                for name, value in candidate.items()
            }
            return _OptionalMappingCommitPlan(
                True,
                replacement,
                _MappingCommitPlan((), ()),
            )
        return _OptionalMappingCommitPlan(
            False,
            None,
            cls._plan_state_mapping(
                current,
                candidate,
                memo,
                forced_names,
                reusable,
                remap_memo,
            ),
        )

    def _plan_candidate_commit(
        self,
        candidate: PersistentModel,
        memo: dict[int, object],
        forced_names: set[str],
        incoming_aliases: dict[int, object],
    ) -> _CommitPlan:
        """Finish all fallible comparison work before replacing the file."""
        current_data = cast(dict[str, object], _instance_state(self))
        candidate_data = cast(dict[str, object], _instance_state(candidate))
        reusable = self._reusable_values(self, candidate, memo)
        reusable.update(incoming_aliases)

        remap_memo: dict[int, object] = {}
        fields_set = (
            frozenset(_pydantic_fields_set(candidate))
            if _pydantic_fields_set(self) != _pydantic_fields_set(candidate)
            else None
        )
        return _CommitPlan(
            self._plan_state_mapping(
                current_data,
                candidate_data,
                memo,
                forced_names,
                reusable,
                remap_memo,
            ),
            fields_set,
            self._plan_optional_state_mapping(
                _pydantic_state(self, "__pydantic_extra__"),
                _pydantic_state(candidate, "__pydantic_extra__"),
                memo,
                forced_names,
                reusable,
                remap_memo,
            ),
            self._plan_optional_state_mapping(
                _pydantic_state(self, "__pydantic_private__"),
                _pydantic_state(candidate, "__pydantic_private__"),
                memo,
                set(),
                reusable,
                remap_memo,
            ),
        )

    @staticmethod
    def _candidate_assignment_value(
        candidate: PersistentModel, name: str
    ) -> tuple[bool, object]:
        """Read a normal assignment target without invoking model accessors."""
        data = cast(dict[str, object], _instance_state(candidate))
        if name in data:
            return True, data[name]
        extra = _pydantic_state(candidate, "__pydantic_extra__")
        if extra is not None and name in extra:
            return True, extra[name]
        return False, None

    @classmethod
    def _incoming_aliases(
        cls,
        candidate: PersistentModel,
        staged_inputs: list[tuple[str, object, object, object, bool]],
    ) -> dict[int, object]:
        """Restore aliases preserved by assignment validation."""
        aliases: dict[int, object] = {}
        for name, original, staged, pristine, was_live_value in staged_inputs:
            found, assigned = cls._candidate_assignment_value(candidate, name)
            if (
                found
                and (assigned is staged or was_live_value)
                and cls._state_value_unchanged(pristine, assigned)
            ):
                aliases[id(assigned)] = original
        return aliases

    @staticmethod
    def _apply_mapping_commit(
        current: dict[str, object], plan: _MappingCommitPlan
    ) -> None:
        for name in plan.removals:
            del current[name]
        for name, value in plan.replacements:
            current[name] = value

    def _commit_candidate(self, plan: _CommitPlan) -> None:
        """Apply a precomputed plan without invoking comparison user code."""
        self._apply_mapping_commit(
            cast(dict[str, object], _instance_state(self)), plan.data
        )

        if plan.fields_set is not None:
            fields_set = _pydantic_fields_set(self)
            fields_set.clear()
            fields_set.update(plan.fields_set)

        if plan.extra.replace_mapping:
            object.__setattr__(self, "__pydantic_extra__", plan.extra.replacement)
        else:
            extra = _pydantic_state(self, "__pydantic_extra__")
            if extra is not None:
                self._apply_mapping_commit(extra, plan.extra.changes)

        if plan.private.replace_mapping:
            object.__setattr__(self, "__pydantic_private__", plan.private.replacement)
        else:
            private = _pydantic_state(self, "__pydantic_private__")
            if private is not None:
                self._apply_mapping_commit(private, plan.private.changes)

    def _mutate_and_persist(self, changes: dict[str, object]) -> None:
        """Validate and persist a complete candidate before changing this model."""
        if not changes:
            return

        candidate, memo = self._isolated_candidate()
        candidate._suspend_persist = True
        staged_inputs: list[tuple[str, object, object, object, bool]] = []
        try:
            for name, value in changes.items():
                # This intentionally uses normal setattr: subclasses and
                # Pydantic property handlers retain their assignment behavior.
                was_live_value = id(value) in memo
                staged = deepcopy(value, memo)
                # Assignment validators can mutate the staged value, while
                # coercion can preserve equal values but change nested types.
                staged_inputs.append(
                    (name, value, staged, deepcopy(staged), was_live_value)
                )
                setattr(candidate, name, staged)
            # Serialize an isolated copy so an impure serializer cannot change
            # the candidate that will be committed after the payload is durable.
            serialized_candidate, _ = candidate._isolated_candidate()
            payload = serialized_candidate._serialized_payload()
        finally:
            candidate._suspend_persist = False

        plan = self._plan_candidate_commit(
            candidate,
            memo,
            set(changes),
            self._incoming_aliases(candidate, staged_inputs),
        )
        self._write_payload(payload)
        self._commit_candidate(plan)

    def _persistence_path(self) -> Path:
        """Resolve the per-instance persistence target."""
        private = _pydantic_state(self, "__pydantic_private__")
        override = private.get("_file_path_override") if private else None
        if override is not None:
            path = Path(cast(str | Path, override))
        else:
            class_state = cast(Mapping[str, object], vars(self.__class__))
            cls_path = class_state.get("file_path")
            if cls_path is None:
                cls_path = cast(object, getattr(self.__class__, "file_path", None))
            if cls_path is None:
                raise RuntimeError(
                    f"{type(self).__name__} has no file_path — pass file_path= to the constructor"
                )
            path = Path(cast(str | Path, cls_path))
        return path

    def _serialized_payload(self) -> str:
        """Run model serialization exactly once and retain its exact output."""
        return self._serialize(cast(dict[str, object], self.model_dump(mode="json")))

    def _write_payload(self, payload: str) -> None:
        """Atomically write an already-serialized payload without user hooks."""
        path = self._persistence_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, payload, tmp_prefix=f".{path.name}.")

    def _persist(self) -> None:
        """Serialize the current state and atomically write it to disk."""
        self._write_payload(self._serialized_payload())

    # ---- bulk updates ---------------------------------------------------

    def update(self, **changes: object) -> None:
        """Atomically validate, persist, then apply multiple changes.

        Stage assignments on an isolated candidate so an invalid later
        assignment cannot expose earlier changes through either this instance
        or its file. Candidate assignment is suspended only for persistence;
        normal ``setattr`` still preserves subclass and Pydantic hooks.
        """
        self._mutate_and_persist(changes)
