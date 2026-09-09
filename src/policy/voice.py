"""Answers come back as audio.

You type; it speaks. The gateway does this on messaging platforms — there is an
`auto_tts` flag and a send pipeline that turns a file into a voice note — but
`api_server` never touches TTS, so over HTTP a reply is text and nothing else.

So this layer does it, at the one place every reply already passes through. The
turn that stays silent produces no audio at all, which is the point: silence
costs nothing here either.

Off unless asked for, and it never fails a turn. A missing key or a provider
having a bad minute costs the audio, never the answer — a reply you can read is
worth more than one you can hear.
"""

from __future__ import annotations

import os
import re
import secrets
import time
from pathlib import Path
from typing import TYPE_CHECKING

from src.defaults import TTS_MODEL

if TYPE_CHECKING:
    from elevenlabs.client import ElevenLabs


def _setting(name: str) -> str:
    """A setting, from the environment or from the project's .env.

    The gateway loads that file at import, so a key sitting there is live for a
    turn — but a status check running in a fresh shell would call it missing.
    Reading both is what stops the status from disagreeing with the runtime.
    """
    value = os.environ.get(name, "").strip()
    if value:
        return value
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    env = Path(home) / ".env"
    if not env.exists():
        return ""
    for line in env.read_text().splitlines():
        if line.lstrip().startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        if key.strip() == name:
            return raw.strip()
    return ""


def enabled() -> bool:
    """Whether replies should be spoken. Needs both the switch and a key: a
    switch that silently does nothing is worse than one that is off."""
    if _setting("SPEAK_REPLIES").lower() not in {"1", "true", "yes", "on"}:
        return False
    return bool(_setting("ELEVENLABS_API_KEY"))


def why_not() -> str:
    """What is missing, for a status line to say something useful."""
    if not _setting("ELEVENLABS_API_KEY"):
        return "no ELEVENLABS_API_KEY"
    if _setting("SPEAK_REPLIES").lower() not in {"1", "true", "yes", "on"}:
        return "SPEAK_REPLIES not set"
    return ""


# One voice per agent. Three of them reading in the same voice is a transcript
# being narrated, not a room — and the point of a group is telling who is
# talking without reading the name first.
#
# Ten, because there are ten personas: a room can deal every one of them a
# different person and still give each of those people a voice of their own.
#
# Chosen on three things, in this order.
#
# How modern the voice is, which the account will tell you if you ask:
# `high_quality_base_model_ids` is how many of the current model families a
# voice is actually supported on. Most sit at 7 or 8. Adam, who led this list
# for months, sits at ZERO — an original 2023 voice, carried for compatibility
# and rendered by nothing current, which is exactly why it sounded flat next to
# the others. Sarah sits at 3. Neither is here now; nothing below is under 7.
#
# What the voice is FOR. These are people talking in a room, so conversational
# and informative reads first, and the character-animation and advertisement
# voices — Harry, Callum, Bill — are left out however good they are. A room does
# not need a narrator.
#
# And how unlike its neighbour each one is. Assignment below goes by position in
# the sorted group, so an adjacent pair is the pair that has to be told apart:
# this alternates woman, man, woman, man the whole way down, and spreads
# american, british and australian across it.
#
# All premade, and each verified to synthesise on this account. Every voice in
# the shared library — including every native non-English one — answers a free
# account with `paid_plan_required`, so a list drawn from there would be
# silence. The language is the model's job in any case: `eleven_flash_v2_5`
# speaks 32 of them, so these read Spanish perfectly well. What a free account
# cannot have is a native ACCENT, not a language.
VOICES = [
    "cgSgspJ2msm6clMCkdW9",  # Jessica — female, american, young, conversational
    "onwK4e9ZLuTAKqWW03F9",  # Daniel — male, british, formal
    "XrExE9yKIg1WjnnlVkGX",  # Matilda — female, american, knowledgable
    "IKne3meq5aSn9XLyUdCD",  # Charlie — male, australian, energetic
    "Xb7hH8MSUJpSbSDYk0k2",  # Alice — female, british, clear
    "CwhRBWXzGAHq8TQ4Fs17",  # Roger — male, american, laid-back
    "FGY2WhTYpPnrIDTdsKH5",  # Laura — female, american, bright
    "SAz9YHcvj6GT2YYXdXww",  # River — neutral, american, relaxed
    "pFZP5JQG7iQjIQuC4Bku",  # Lily — female, british, velvety
    "nPczCjzI2devNBz1zQrb",  # Brian — male, american, deep
]


def voice_for(name: str, among: list[str] | None = None) -> str:
    """A voice for this agent, distinct from the others in the group.

    Hashing the name gave a stable voice but collided — Jordan and Pepe drew the
    same one out of four, which defeats the entire point. Position in the group
    is what guarantees they differ, and the group is sorted first so the
    assignment does not depend on the order somebody happened to list them in.

    Without a group to place it in, the hash is the fallback: better a stable
    voice than none.
    """
    if among:
        ordered = sorted(among, key=str.lower)
        if name in ordered:
            return VOICES[ordered.index(name) % len(VOICES)]
    return VOICES[sum(ord(c) for c in (name or "").lower()) % len(VOICES)]


# What a voice cannot say. Emoji get read out as their names — "Hey Fabri
# waving hand" — and the markers the layer uses internally are not speech at
# all. Stripped only on the way to the synthesiser: the written reply keeps
# them, because there they are the tone.
_UNSPEAKABLE = re.compile(
    "["
    "\U0001F300-\U0001FAFF"  # symbols, pictographs, emoji proper
    "\U00002600-\U000027BF"  # dingbats, misc symbols
    "\U0001F1E6-\U0001F1FF"  # flags
    "\U0000FE00-\U0000FE0F"  # variation selectors
    "\U0001F3FB-\U0001F3FF"  # skin tones
    "\U00002190-\U000021FF"  # arrows
    "\U00002B00-\U00002BFF"
    "\U0000200D"              # zero-width joiner, which glues them together
    "]+"
)


def sayable(text: str) -> str:
    """The part of a reply a voice can actually read.

    Nothing is replaced with a word: an emoji at the end of a sentence is tone,
    and tone that has to be pronounced stops being tone.
    """
    cleaned = _UNSPEAKABLE.sub("", text or "")
    # Collapse what the removal left behind, so a line that ended in an emoji
    # does not end in a space before its full stop.
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\s+([,.;:!?…])", r"\1", cleaned)
    return cleaned.strip()


# The format every one of these clips comes back in. Named rather than left to
# the default so a change upstream cannot quietly alter what lands on disk, and
# because it is the one an account on any plan can ask for.
_OUTPUT_FORMAT = "mp3_44100_128"

_client_for: tuple[str, "ElevenLabs"] | None = None


def _client() -> ElevenLabs:
    """One client per key, for as long as the key does not change.

    Reused rather than built per call: a client owns an HTTP connection pool,
    and a room synthesises a line at a time for as long as it is open.
    """
    global _client_for
    from elevenlabs.client import ElevenLabs

    api_key = _setting("ELEVENLABS_API_KEY")
    if _client_for is not None and _client_for[0] == api_key:
        return _client_for[1]
    made = ElevenLabs(api_key=api_key)
    _client_for = (api_key, made)
    return made


def _clip_path() -> Path:
    """Where a clip lands: the agent's own Hermes home.

    Its own, and not a shared temporary directory, because each agent in a group
    runs as a separate process with a separate home — and because the web app
    serves clips only from these directories, so a file written anywhere else is
    one nothing is allowed to play.

    The name carries the time it was made, so a clip never changes under a URL,
    plus enough randomness that two replies inside one millisecond do not land
    on each other.
    """
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    folder = Path(home) / "cache" / "audio"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"reply-{int(time.time() * 1000)}-{secrets.token_hex(3)}.mp3"


def speak(text: str, *, voice_id: str | None = None) -> str | None:
    """Synthesise one reply, returning the audio path or None.

    Straight through the ElevenLabs SDK. It used to go through the gateway's own
    TTS tool, which reads its voice out of a config file — so the only way to
    give each agent a different one was to reach in and replace a private
    function on that module for the duration of the call and put it back
    afterwards. Passing the voice as an argument is what the API has always
    wanted; the whole reason for the patch was that a tool was standing between
    this and it.

    Swallows everything. Instrumentation and convenience never get to break a
    turn, and this is both.
    """
    line = sayable(text)
    # A reply that was only an emoji has nothing left to say out loud, and
    # synthesising an empty string bills for silence.
    if not line or not enabled():
        return None
    try:
        audio = _client().text_to_speech.convert(
            voice_id=voice_id or VOICES[0],
            text=line,
            model_id=TTS_MODEL,
            output_format=_OUTPUT_FORMAT,
        )
        path = _clip_path()
        # Written as it arrives: `convert` returns the clip in chunks, and this
        # is the point at which they stop being a stream and start being a file.
        with path.open("wb") as clip:
            for chunk in audio:
                clip.write(chunk)
    except Exception:  # noqa: BLE001
        return None

    # A zero-byte file is what a refused request leaves behind, and handing that
    # back would be a client trying to play silence rather than saying nothing.
    if not path.exists() or path.stat().st_size == 0:
        path.unlink(missing_ok=True)
        return None
    return str(path)


AUDIO = (".mp3", ".ogg", ".wav", ".m4a")


def split(reply: str) -> tuple[str | None, str]:
    """Pull the audio off a reply, leaving the words.

    A spoken reply is a `MEDIA:` marker plus the text — the same shape the
    gateway's send path uses for any attachment, reused here rather than
    inventing a second channel. Every client has to undo it, which is why this
    lives beside the code that does it: the group client did not, printed the
    path into the conversation, and then read it aloud.
    """
    audio, said = None, []
    for line in (reply or "").split("\n"):
        if line.startswith("MEDIA:") and line.strip().endswith(AUDIO):
            audio = line[len("MEDIA:") :].strip()
        else:
            said.append(line)
    return audio, "\n".join(said).strip()
