"""Observer hooks — the debug-level view of a turn.

The plugin's own trace records the two decisions it makes. That answers "did it
speak", but not "why did that take nine seconds" or "what did the model
actually see". These hooks fill in the rest of the turn, in order:

    inbound     the user message, before the model sees it   (pre_llm_call)
    context     what the middleware injected                 (llm_request)
    tool        each tool the model ran                      (pre/post_tool_call)
    round       one API round: model, latency, tokens        (post_api_request)
    turn        the decision, and what shipped               (transform_llm_output)

A turn with tool calls produces several `round` records — that is the loop, and
seeing it is usually the answer to "why was that slow".

These are observers. They return nothing, they change nothing, and they each
swallow their own exceptions: instrumentation must never be able to break a
turn it is only supposed to watch.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any, Protocol

from . import trace

_tool_started: dict[str, float] = {}


class _PluginContext(Protocol):
    def register_hook(self, hook_name: str, callback: Callable[..., object]) -> None: ...


def _text(value: Any, limit: int = 500) -> str:
    try:
        return str(value)[:limit]
    except Exception:  # noqa: BLE001
        return ""


def _on_pre_llm_call(**kw: Any) -> None:
    try:
        trace.emit(
            "inbound",
            session=kw.get("session_id"),
            turn=kw.get("turn_id"),
            model=kw.get("model"),
            first=bool(kw.get("is_first_turn")),
            history=len(kw.get("conversation_history") or []),
            message=_text(kw.get("user_message")),
        )
    except Exception:  # noqa: BLE001
        pass


def _on_post_api_request(**kw: Any) -> None:
    try:
        usage = kw.get("usage") or {}
        if not isinstance(usage, dict):
            usage = {}
        trace.emit(
            "round",
            session=kw.get("session_id"),
            turn=kw.get("turn_id"),
            n=kw.get("api_call_count"),
            model=kw.get("response_model") or kw.get("model"),
            provider=kw.get("provider"),
            secs=round(float(kw.get("api_duration") or 0), 2),
            finish=kw.get("finish_reason"),
            tools=kw.get("assistant_tool_call_count"),
            chars=kw.get("assistant_content_chars"),
            messages=kw.get("message_count"),
            usage={
                k: v
                for k, v in usage.items()
                if isinstance(v, (int, float)) and "token" in str(k)
            },
        )
    except Exception:  # noqa: BLE001
        pass


def _on_pre_tool_call(**kw: Any) -> None:
    try:
        name = str(kw.get("tool_name") or "?")
        _tool_started[name] = time.monotonic()
    except Exception:  # noqa: BLE001
        pass


def _on_post_tool_call(**kw: Any) -> None:
    try:
        name = str(kw.get("tool_name") or "?")
        started = _tool_started.pop(name, None)
        trace.emit(
            "tool",
            session=kw.get("session_id"),
            name=name,
            secs=round(time.monotonic() - started, 2) if started else None,
        )
    except Exception:  # noqa: BLE001
        pass


def register(ctx: _PluginContext) -> None:
    """Attach every observer. Kept apart from the behaviour hooks on purpose:
    this module only watches, and nothing here may change a turn."""
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_api_request", _on_post_api_request)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
