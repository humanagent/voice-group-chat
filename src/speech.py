"""What the room sounds like, read from the one file that says so.

`speech.json` at the repo root, because both languages in this project speak.
The browser asks for a reply out loud and the terminal client synthesises one,
and they used to hold separate copies of the voice list with a test that parsed
one language's source from the other to check they still agreed. Agreement is
not a thing to test for when the two can read the same file.

Read once, at import. It is a constant that ships with the source, not state:
changing it is a deploy, and a running process that disagreed with the file for
one turn and agreed the next would be worse than one that never noticed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

SPEECH_FILE = Path(__file__).resolve().parents[1] / "speech.json"


def _load() -> dict[str, object]:
    """Loudly, if at all. A missing or broken file means the room cannot speak,
    and the useful failure is at startup naming the file rather than ten voices
    later at the first reply."""
    try:
        loaded = cast(object, json.loads(SPEECH_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError) as failure:
        raise RuntimeError(f"could not read {SPEECH_FILE}: {failure}") from failure
    if not isinstance(loaded, dict):
        raise RuntimeError(f"{SPEECH_FILE} should hold an object")
    return cast(dict[str, object], loaded)


_SPEECH = _load()

# What speaks the replies. See the file for how it was chosen.
model = _SPEECH.get("model")
if not isinstance(model, str) or not model:
    raise RuntimeError(f"{SPEECH_FILE} has no `model`")
TTS_MODEL: str = model

_voices = _SPEECH.get("voices")
if not isinstance(_voices, list) or not _voices:
    raise RuntimeError(f"{SPEECH_FILE} has no `voices`")

# One voice per agent, in this order. Position in the sorted group picks one,
# so the order is the assignment and reordering this file reshuffles who sounds
# like whom.
VOICES: list[str] = []
for entry in cast(list[object], _voices):
    if not isinstance(entry, dict):
        raise RuntimeError(f"{SPEECH_FILE} has a voice that is not an object")
    voice_id = cast(dict[str, object], entry).get("id")
    if not isinstance(voice_id, str) or not voice_id:
        raise RuntimeError(f"{SPEECH_FILE} has a voice with no `id`")
    VOICES.append(voice_id)

if len(set(VOICES)) != len(VOICES):
    # It happened: Adam appeared twice, so two of any three agents shared a
    # voice however they were assigned, and the hashing took the blame.
    raise RuntimeError(f"{SPEECH_FILE} lists the same voice twice")
