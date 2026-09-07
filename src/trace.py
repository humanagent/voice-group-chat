"""Per-turn decision trace.

The plugin decides three things on every turn — what context went in, whether
the turn speaks at all, and how much of the reply survives — and until now it
decided all of them silently. That is fine in production and useless while
developing: a turn that ends in nothing looks identical to a turn that broke.

So each decision appends one JSON line to a trace file. The reader
(``scripts/tui.py``) tails it.

Two rules this module never breaks:

1. **It cannot fail the turn.** Every entry point swallows its own exceptions.
   Tracing is a development convenience; a full disk or a read-only home must
   never cost a reply.
2. **It is off unless asked for.** No ``HERMES_GROUP_TRACE`` in the environment means
   no file is opened and no work is done.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

_ENV_VAR = "HERMES_GROUP_TRACE"
_lock = threading.Lock()
_seq = 0


def trace_path() -> Path | None:
    """Where to write, or ``None`` when tracing is off.

    ``HERMES_GROUP_TRACE=1`` picks the default under the Hermes home;
    ``HERMES_GROUP_TRACE=/some/file.jsonl`` writes there instead.
    """
    raw = os.environ.get(_ENV_VAR, "").strip()
    if not raw or raw.lower() in {"0", "false", "off", "no"}:
        return None
    if raw.lower() in {"1", "true", "on", "yes"}:
        home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
        return Path(home) / "group-trace.jsonl"
    return Path(raw).expanduser()


def emit(kind: str, **fields: Any) -> None:
    """Append one trace record. Never raises."""
    try:
        path = trace_path()
        if path is None:
            return
        global _seq
        with _lock:
            _seq += 1
            record = {"seq": _seq, "ts": time.time(), "kind": kind, **fields}
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a") as fh:
                fh.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception:  # noqa: BLE001 — tracing must never cost a reply
        pass
