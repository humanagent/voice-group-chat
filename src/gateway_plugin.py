"""Group-chat behaviour installed through Hermes's public plugin interfaces."""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from typing import Protocol

from . import observe, trace
from .context import (
    append_turn_note,
    compose_group_context,
    inject_request_context,
)
from .markers import ParsedLink, parse_response
from .policy import (
    checkins,
    clock,
    outbound_length,
    participation,
    questions,
    review_turns,
    turn_gate,
    turn_state,
)
from .policy.addressing import is_addressed
from .policy.suppress_tokens import has_suppress_token

_SILENT_REPLY = "NO_REPLY"
_ASYNC_DELEGATE_LEAK = re.compile(
    r"\[batch-[a-z0-9]{6,}.*?(running|queued|in progress|coming).*?\]",
    re.IGNORECASE,
)


class _PluginContext(Protocol):
    def register_hook(
        self, hook_name: str, callback: Callable[..., object]
    ) -> None: ...

    def register_middleware(
        self, kind: str, callback: Callable[..., object]
    ) -> None: ...


def _inject_group_context(
    *, request: dict[str, object], **kwargs: object
) -> dict[str, object] | None:
    ctx = turn_state.peek()
    context = compose_group_context()
    if not context:
        trace.emit("context", session=kwargs.get("session_id"), injected=False)
        return None
    injected = inject_request_context(request, context)

    # The per-turn note goes at the tail, never into the system prompt: it
    # changes every turn, and in front it would move the cache boundary forward
    # each time and re-bill everything behind it.
    note = ""
    if ctx.inbound is not None and not ctx.is_review:
        # The clock rides along with it. Same slot, same reason: a fact that
        # changes every turn belongs where it cannot move the cache boundary,
        # and an agent that has to shell out for the time pays a tool call and
        # a second round for something this process already knows.
        note = clock.now_note() + participation.preamble(
            kwargs.get("session_id"),
            is_addressed(ctx.inbound, _agent_name()),
        )
        injected = append_turn_note(injected, note)
    trace.emit(
        "context",
        session=kwargs.get("session_id"),
        injected=True,
        chars=len(context),
        model=kwargs.get("model"),
        carrier=next(
            (k for k in ("messages", "instructions", "input") if k in injected),
            "unknown",
        ),
        note=len(note),
    )
    return {"request": injected, "source": "hermes-agent-groups"}


def _agent_name() -> str:
    """The name the agent answers to. One place, so the gate and the prompt
    cannot disagree about who is being called."""
    return os.environ.get("HERMES_AGENT_NAME", "agent")


def _open_turn(*, user_message: object = None, **_: object) -> None:
    """Stash what started this turn, for the exit gate to judge against.

    Returns nothing: nothing is decided here. The inbound is simply not visible
    from the hook that decides.
    """
    turn_state.begin(user_message, is_review=review_turns.is_review_prompt(user_message))
    return None


def _render_link(link: ParsedLink) -> str:
    return f"{link.caption} ({link.url})" if link.caption else link.url


def _effects_only(parsed: object) -> str:
    """What a silenced turn still ships: the file it made, the link it found.

    Hiding text and cancelling effects are different switches. A turn that had
    nothing to say may still have produced something.
    """
    parts = [f"MEDIA:{media}" for media in parsed.media]
    parts.extend(_render_link(link) for link in parsed.links)
    return "\n".join(parts).strip()


def _transform_output(*, response_text: str, **kwargs: object) -> str | None:
    """Apply the group-chat output contract before gateway delivery.

    Upstream owns actual sending and media handling. The plugin selects the
    visible prose, decides whether this turn speaks at all, and turns silence
    into the marker Hermes already understands.
    """
    session = kwargs.get("session_id")
    ctx = turn_state.take()

    parsed = parse_response(response_text)
    visible = parsed.send_text if parsed.send_text is not None else parsed.text
    stripped = outbound_length.strip_markdown(visible).strip()
    visible = "\n".join(
        line for line in stripped.splitlines() if not _ASYNC_DELEGATE_LEAK.search(line)
    ).strip()

    verdict = turn_gate.judge(
        text=visible,
        chat=session,
        agent_name=_agent_name(),
        inbound=ctx.inbound,
        is_system_turn=ctx.is_system,
        is_review_turn=ctx.is_review,
        has_suppress_token=has_suppress_token(response_text),
    )

    dropped = [
        name
        for name, present in (
            ("react", bool(parsed.reactions)),
            ("reply", parsed.reply_to is not None),
            ("profile", parsed.profile_name is not None),
            ("profileimage", parsed.profile_image is not None),
            ("metadata", bool(parsed.profile_metadata)),
        )
        if present
    ]

    if not verdict.speak:
        effects = _effects_only(parsed) if verdict.keep_effects else ""
        trace.emit(
            "turn",
            session=session,
            spoke=False,
            reason=verdict.reason,
            raw_chars=len(response_text),
            effects=len(effects),
            dropped=dropped,
            raw=response_text[:400],
        )
        return effects or _SILENT_REPLY

    # A question with nobody's name on it is a question nobody answers. The
    # prompt asks for the name; this puts it there when the prompt was ignored.
    # Before the clamp, so the cap still counts every character that ships.
    named = False
    if visible:
        addressed = questions.ensure_addressed(
            visible, inbound=ctx.inbound, agent_name=_agent_name()
        )
        # Read here, not at the trace: the clamp below rewrites `visible` too,
        # and comparing there would report every trimmed reply as named.
        named, visible = addressed != visible, addressed

    exempt = outbound_length.is_exempt(parsed)
    before_clamp = len(visible)
    if visible and not exempt:
        visible = outbound_length.clamp(visible)

    output_parts = [f"MEDIA:{media}" for media in parsed.media]
    if visible:
        output_parts.append(visible)
    output_parts.extend(_render_link(link) for link in parsed.links)
    transformed = "\n".join(output_parts).strip()

    if not transformed:
        trace.emit(
            "turn",
            session=session,
            spoke=False,
            reason="nothing left after transform",
            raw_chars=len(response_text),
            dropped=dropped,
        )
        return _SILENT_REPLY

    # Scheduled work repeats itself, because it starts each run with no memory
    # of the last one. Remember what went out so the next run can tell.
    if ctx.is_system:
        checkins.record_delivery(visible)

    # A turn returns words. It does not wait to be able to say them.
    #
    # This used to synthesise here, inline, and attach the clip as a MEDIA
    # marker — which meant the REPLY did not leave until the MP3 existed.
    # Measured on a 220-character answer: 4.14s of turn, of which 2.18s was the
    # model and 1.96s was the synthesiser. Two seconds of a room with nothing in
    # it, and not because anybody was thinking.
    #
    # So speech belongs to whoever wants to hear it. The browser streams it and
    # starts playing on the first chunk; the terminal client synthesises it
    # after the line has already been printed. Both of them know the agent's
    # name, and `voice_for` turns a name into the same voice everywhere, so
    # nothing is lost by not deciding it here.

    trace.emit(
        "turn",
        session=session,
        spoke=True,
        reason="",
        raw_chars=len(response_text),
        after_strip=len(stripped),
        before_clamp=before_clamp,
        final_chars=len(transformed),
        clamped=(not exempt) and before_clamp > outbound_length.OUTBOUND_CHAR_LIMIT,
        addressed=named,
        exempt=exempt,
        media=len(parsed.media),
        links=len(parsed.links),
        dropped=dropped,
        text=transformed[:400],
    )
    return transformed


def register(ctx: _PluginContext) -> None:
    """Register only behavior deltas; the upstream gateway owns transport."""
    ctx.register_middleware("llm_request", _inject_group_context)
    ctx.register_hook("pre_llm_call", _open_turn)
    ctx.register_hook("transform_llm_output", _transform_output)
    # Watching only — see src/observe.py. Registered here so a single
    # plugin entry point carries both, but kept in its own module so behaviour
    # and instrumentation never get edited by accident together.
    observe.register(ctx)
