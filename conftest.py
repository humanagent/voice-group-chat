"""Ensure the extracted runtime packages are importable in tests."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


@pytest.fixture(autouse=True)
def _no_real_speech(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never synthesise.

    Reading the project's .env is what makes the status honest at runtime, and
    it also meant the suite picked up a live key and started calling a paid API:
    slow, networked, billed, and it made three assertions fail on an audio
    marker they never expected. Off everywhere unless a test asks for it.
    """
    monkeypatch.setenv("SPEAK_REPLIES", "0")
