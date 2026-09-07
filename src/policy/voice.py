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

import json
import os
import re
from pathlib import Path


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


def speak(text: str, *, voice_id: str | None = None) -> str | None:
    """Synthesise one reply, returning the audio path or None.

    Swallows everything. Instrumentation and convenience never get to break a
    turn, and this is both.
    """
    text = sayable(text)
    # A reply that was only an emoji has nothing left to say out loud, and
    # synthesising an empty string bills for silence.
    if not text or not enabled():
        return None
    try:
        from tools.tts_tool import text_to_speech_tool

        if voice_id:
            # The tool reads its voice from config, so the only way to give
            # each agent its own is to set it for the call and put it back.
            import tools.tts_tool as tts

            original = tts._load_tts_config
            tts._load_tts_config = lambda: {
                **original(),
                "elevenlabs": {**(original().get("elevenlabs") or {}), "voice_id": voice_id},
            }
            try:
                result = json.loads(text_to_speech_tool(text))
            finally:
                tts._load_tts_config = original
        else:
            result = json.loads(text_to_speech_tool(text))
    except Exception:  # noqa: BLE001
        return None

    path = result.get("file_path") if isinstance(result, dict) else None
    return str(path) if path and Path(path).exists() else None


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
