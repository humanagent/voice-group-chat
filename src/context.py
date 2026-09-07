"""Stable group-conversation context layered onto upstream Hermes requests."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import cast

_CONTEXT_MARKER = "<!-- hermes-agent-groups-context -->"
_DEFAULT_CONTEXT_PATH = Path(__file__).with_name("group_context.md")
_MAX_CONTEXT_CHARS = 200_000

#: The persona file, which lives beside the standing context but is not part of it.
SOUL = "SOUL.md"


def _read_text(path: Path) -> str:
    """One file, or a whole directory of them in name order.

    The agent's standing context is a folder of ordinary Markdown files rather
    than one generated blob: they are edited by hand, so they are stored the way
    they are read, and sorting by name is the cheapest ordering there is.

    ``SOUL.md`` sits in the same folder and is deliberately skipped. It is the
    agent's persona, delivered as its own file in each agent's home — reading it
    here as well would ship every word of it twice on every turn.
    """
    try:
        if path.is_dir():
            parts = [
                f.read_text(encoding="utf-8").strip()
                for f in sorted(path.glob("*.md"))
                if f.name != SOUL
            ]
            return "\n\n".join(p for p in parts if p)[:_MAX_CONTEXT_CHARS]
        return path.read_text(encoding="utf-8").strip()[:_MAX_CONTEXT_CHARS]
    except (OSError, UnicodeError):
        return ""


def _template_path() -> Path:
    configured = os.environ.get("HERMES_GROUP_TEMPLATE", "").strip()
    if configured:
        return Path(configured).expanduser()
    hermes_home = Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser()
    return hermes_home / "TEMPLATE.json"


def _template_prompt(path: Path) -> str:
    try:
        value = cast(object, json.loads(path.read_text(encoding="utf-8")))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return ""
    if not isinstance(value, dict):
        return ""
    prompt = cast(dict[object, object], value).get("prompt")
    return prompt.strip()[:_MAX_CONTEXT_CHARS] if isinstance(prompt, str) else ""


def compose_group_context() -> str:
    """Load the standing group contract and optional per-agent context.

    ``HERMES_GROUP_CONTEXT`` adds a Markdown file, or a directory of them. A
    per-agent
    ``TEMPLATE.json`` prompt is loaded from ``HERMES_GROUP_TEMPLATE`` or the
    active ``HERMES_HOME``. Files are read for every request so edits are
    visible on the next model round without restarting the gateway.
    """
    blocks = [_read_text(_DEFAULT_CONTEXT_PATH)]

    configured_context = os.environ.get("HERMES_GROUP_CONTEXT", "").strip()
    if configured_context:
        blocks.append(_read_text(Path(configured_context).expanduser()))

    blocks.append(_template_prompt(_template_path()))
    body = "\n\n".join(block for block in blocks if block)
    return f"{_CONTEXT_MARKER}\n{body}" if body else ""


def _extended_content(content: object, context: str) -> object:
    if isinstance(content, str):
        return f"{content}\n\n{context}".strip()
    if isinstance(content, list):
        parts = copy.deepcopy(cast(list[object], content))
        parts.append({"type": "text", "text": context})
        return parts
    return context


def _inject_message_list(messages: list[object], context: str) -> list[object]:
    rewritten = copy.deepcopy(messages)
    for item in rewritten:
        if not isinstance(item, dict):
            continue
        message = cast(dict[object, object], item)
        if message.get("role") != "system":
            continue
        content = message.get("content")
        if _CONTEXT_MARKER in str(content):
            return rewritten
        message["content"] = _extended_content(content, context)
        return rewritten
    return [{"role": "system", "content": context}, *rewritten]


def inject_request_context(
    request: dict[str, object], context: str
) -> dict[str, object]:
    """Return provider kwargs with ``context`` appended to system input.

    Hermes supports both Chat Completions-style ``messages`` and
    Responses-style ``instructions``/``input`` shapes. This adapter handles
    both without changing the upstream gateway or agent loop.
    """
    if not context:
        return request
    rewritten = copy.deepcopy(request)

    messages = rewritten.get("messages")
    if isinstance(messages, list):
        rewritten["messages"] = _inject_message_list(
            cast(list[object], messages), context
        )
        return rewritten

    instructions = rewritten.get("instructions")
    if isinstance(instructions, str):
        if _CONTEXT_MARKER not in instructions:
            rewritten["instructions"] = f"{instructions}\n\n{context}".strip()
        return rewritten

    input_value = rewritten.get("input")
    if isinstance(input_value, list):
        rewritten["input"] = _inject_message_list(
            cast(list[object], input_value), context
        )
        return rewritten

    rewritten["instructions"] = context
    return rewritten


def append_turn_note(request: dict[str, object], note: str) -> dict[str, object]:
    """Put a per-turn instruction at the TAIL of the conversation, not in the
    system prompt.

    The group context is stable across turns and sits at the front, where the
    provider can cache it. A note that changes every turn — "this message is not
    addressed to you" — must not go there: appending it to the system prompt
    moves the cache boundary forward on every turn and re-bills everything
    behind it. Measured, when this was done the wrong way: fresh input went from
    ~566 tokens to ~5,746.

    At the tail it is also the freshest thing the model reads before it decides,
    which is where a routing instruction belongs anyway.
    """
    if not note:
        return request
    rewritten = copy.deepcopy(request)

    for key in ("messages", "input"):
        value = rewritten.get(key)
        if isinstance(value, list):
            items = cast("list[object]", list(value))
            items.append({"role": "system", "content": note.strip()})
            rewritten[key] = items
            return rewritten

    instructions = rewritten.get("instructions")
    if isinstance(instructions, str):
        rewritten["instructions"] = f"{instructions}\n\n{note.strip()}"
    return rewritten
