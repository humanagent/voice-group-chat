"""Every model decision, in one place.

These are not settings — they are what gets WRITTEN into settings, and what is
read back out of them. `groups init` creates the single runtime's config,
`group_up` creates one per agent, and the status header reads all of them back.
Three files, one question: which model is this thing running?

Spread across those files the answer drifted. The live homes ran one model while
a fresh clone was still being handed the one before it, the group had no `tts`
block at all so it silently fell to a library default nobody chose, and the only
way to find out was to open four YAML files by hand.

So the values, the template that writes them, and the reader that gets them back
all live here.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from src.speech import TTS_MODEL

__all__ = [
    "CONFIG_TEMPLATE",
    "DEFAULT_MODEL",
    "FIRST_GROUP_PORT",
    "gateway_binary",
    "GATEWAY_PORT",
    "TTS_MODEL",
    "align",
    "config_for",
    "model_in",
    "tts_model_in",
]

# The model. One line, and it is the only one.
#
# It used to be the model a NEW home was created with, and every home kept
# whatever its own config.yaml said after that — which sounds respectful and
# means changing the model is editing four files and forgetting one. It also
# left this constant free to say something nothing was running on.
#
# Every home is reconciled to this on start, and told so. A config.yaml is
# generated state living in a gitignored directory, not a file anybody is
# keeping notes in; the place to change the model is here, in source, where the
# change can be read in a diff.
DEFAULT_MODEL = "openai/gpt-5.6-sol"

# What speaks the replies, and the voices that do it, both from `speech.json`
# at the repo root. Re-exported here because this module is where the Python
# asks "which model is this thing running?" — but the answer is written in one
# file the web app reads too, since a browser that quietly synthesised with a
# different model would be slower or dearer for reasons nobody could see.
#
# That file carries the measurements behind the choice.

# The single-agent runtime. Its port is also its identity: every agent runs the
# same binary, so the port is the only thing that tells them apart.
GATEWAY_PORT = 8642

# The group counts up from here, one port per agent.
FIRST_GROUP_PORT = 8700


def gateway_binary() -> str:
    """The gateway executable.

    `uv sync` puts it in the project's own `.venv`, which is where it is locally
    and in an image built the same way. A container that installed the project
    some other way has it on PATH instead, and falling back there costs one
    lookup and saves an entrypoint that fails on a path it could have found.

    Here rather than in the script that starts agents, because the test that
    proves a gateway can actually serve has to launch the same thing the
    container launches, or it proves nothing about the container.
    """
    local = Path(__file__).resolve().parents[1] / ".venv" / "bin" / "hermes-groups"
    if local.exists():
        return str(local)
    return shutil.which("hermes-groups") or str(local)


CONFIG_TEMPLATE = """# {headline}
#
# `model.default` is any model your provider serves. `plugins.enabled` is not
# optional: without it the plugin is discovered and skipped, and the gateway
# boots perfectly well without any of this layer's behaviour.

model:
  default: {model}

plugins:
  enabled:
    - group-layer

# Flash is the model built for live conversation. `eleven_v3` reads better and
# costs two seconds a line, which a chat notices.
tts:
  elevenlabs:
    model_id: {tts_model}

platforms:
  api_server:
    enabled: true
    extra:
      host: 127.0.0.1
      port: {port}
"""


def config_for(port: int, *, headline: str, model: str | None = None) -> str:
    """A complete config.yaml. One template, so the runtime the group talks to
    and the agents in it cannot be configured differently by accident."""
    return CONFIG_TEMPLATE.format(
        headline=headline,
        model=model or DEFAULT_MODEL,
        tts_model=TTS_MODEL,
        port=port,
    )


# `model:` then an indented `default:`. Matched as a block rather than by
# hunting for a bare "default:" anywhere in the file — `platforms` and `tts`
# have their own keys, and the first one that happened to match won.
_MODEL_BLOCK = re.compile(r"^model:\s*$\s*^\s+default:\s*(\S+)\s*$", re.MULTILINE)
_TTS_MODEL = re.compile(r"^\s+model_id:\s*(\S+)\s*$", re.MULTILINE)


def model_in(home: str | Path) -> str | None:
    """The chat model one home is configured with, or None if it says nothing."""
    return _read(Path(home) / "config.yaml", _MODEL_BLOCK)


def tts_model_in(home: str | Path) -> str | None:
    """The voice model one home is configured with, or None."""
    return _read(Path(home) / "config.yaml", _TTS_MODEL)


def align(home: str | Path) -> str | None:
    """Point one home's config.yaml at the models this file names.

    Returns what it changed, for a caller that wants to say so, or None when
    there was nothing to change. A home with no config is not this function's
    problem — it has not been provisioned yet, and provisioning writes the right
    thing the first time.
    """
    config = Path(home) / "config.yaml"
    if not config.exists():
        return None

    text = config.read_text(encoding="utf-8")
    was_model, was_tts = model_in(home), tts_model_in(home)
    changed = []

    if was_model and was_model != DEFAULT_MODEL:
        text = _MODEL_BLOCK.sub(f"model:\n  default: {DEFAULT_MODEL}", text, count=1)
        changed.append(f"{was_model} -> {DEFAULT_MODEL}")
    if was_tts and was_tts != TTS_MODEL:
        text = _TTS_MODEL.sub(f"    model_id: {TTS_MODEL}", text, count=1)
        changed.append(f"{was_tts} -> {TTS_MODEL}")

    if not changed:
        return None
    config.write_text(text, encoding="utf-8")
    return ", ".join(changed)


def _read(config: Path, pattern: re.Pattern[str]) -> str | None:
    try:
        found = pattern.search(config.read_text())
    except OSError:
        return None
    return found.group(1) if found else None
