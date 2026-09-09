"""A short memory of what has already gone out.

Scheduled work starts every run with no memory of the last one, so it finds the
same news an hour later and posts it again. This is the list that stops it —
the last hundred deliveries, by fingerprint, on disk.

That is the entire requirement, and it is worth saying what it is NOT, because
this file used to be the visible tip of about fifteen hundred lines. It is a
bounded list of short strings. There is one writer. Nothing reads it but the
process that wrote it, nothing else on disk points at it, and losing it costs
one repeated post. A whole-file write and a rename is the correct amount of
machinery for that, and anything more is machinery being carried rather than
used.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import ClassVar, cast


class DedupRing:
    """Bounded, oldest first. Never raises for a file that is missing, empty or
    corrupt: this is a memory of what was said, and having none of it is the
    same situation as starting up for the first time."""

    MAX_ENTRIES: ClassVar[int] = 100
    _path: Path

    def __init__(self, file_path: Path | str) -> None:
        self._path = Path(file_path)

    def ids(self) -> list[str]:
        """Snapshot of the currently-retained ids (oldest first)."""
        try:
            loaded = cast(object, json.loads(self._path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return []
        if not isinstance(loaded, list):
            return []
        # A file somebody else wrote is a list of anything, so the strings are
        # picked out rather than assumed.
        return [entry for entry in cast(list[object], loaded) if isinstance(entry, str)]

    def contains(self, message_id: str) -> bool:
        return message_id in self.ids()

    def record(self, message_id: str) -> None:
        ids = self.ids()
        if message_id in ids:
            return
        ids.append(message_id)
        self._write(ids[-self.MAX_ENTRIES :])

    def _write(self, ids: list[str]) -> None:
        """Whole file, then rename. A reader either sees the previous list or
        the new one, and a crash halfway through leaves the previous one — which
        is why the temporary file is made in the same directory, since a rename
        is only atomic within a filesystem."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle, staged = tempfile.mkstemp(dir=self._path.parent, suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                json.dump(ids, out)
            os.replace(staged, self._path)
        except BaseException:
            # Including cancellation: a half-written temporary file left behind
            # is the one piece of litter this can leave, so it never does.
            try:
                os.unlink(staged)
            except OSError:
                pass
            raise
