"""Bounded persistent ring buffer for message-id idempotency."""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

from pydantic import Field

from src.lib.persistent import PersistentModel


class _RingModel(PersistentModel):
    ids: list[str] = Field(default_factory=list)


class DedupRing:
    """Bounded JSON ring buffer for gateway message-id idempotency.

    A plain JSON file written atomically via PersistentModel is simple and
    corruption-free — no WAL, no checkpoint, no locking. Bounded at
    MAX_ENTRIES so the file stays small across container restarts.
    """

    MAX_ENTRIES: ClassVar[int] = 100

    def __init__(self, file_path: Path) -> None:
        self._model: _RingModel = _RingModel(
            file_path=file_path  # pyright: ignore[reportCallIssue]
        )

    def contains(self, message_id: str) -> bool:
        return message_id in self._model.ids

    def ids(self) -> list[str]:
        """Snapshot of the currently-retained ids (oldest first)."""
        return list(self._model.ids)

    def record(self, message_id: str) -> None:
        ids = list(self._model.ids)
        if message_id not in ids:
            ids.append(message_id)
            if len(ids) > self.MAX_ENTRIES:
                ids = ids[-self.MAX_ENTRIES :]
            self._model.ids = ids  # triggers atomic write-through
