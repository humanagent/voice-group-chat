from __future__ import annotations

import json

from src.context import compose_group_context, inject_request_context


def test_compose_context_adds_custom_and_template(monkeypatch, tmp_path) -> None:
    custom = tmp_path / "custom.md"
    custom.write_text("Custom chat rule", encoding="utf-8")
    template = tmp_path / "TEMPLATE.json"
    template.write_text(json.dumps({"prompt": "Plan the trip"}), encoding="utf-8")
    monkeypatch.setenv("HERMES_GROUP_CONTEXT", str(custom))
    monkeypatch.setenv("HERMES_GROUP_TEMPLATE", str(template))

    context = compose_group_context()

    assert "Group-conversation contract" in context
    assert "Custom chat rule" in context
    assert "Plan the trip" in context


def test_injects_chat_completions_system_message_once() -> None:
    request: dict[str, object] = {
        "messages": [
            {"role": "system", "content": "Hermes base"},
            {"role": "user", "content": "hello"},
        ]
    }

    once = inject_request_context(
        request, "<!-- hermes-agent-groups-context -->\nGroup"
    )
    twice = inject_request_context(once, "<!-- hermes-agent-groups-context -->\nGroup")

    messages = twice["messages"]
    assert isinstance(messages, list)
    assert str(messages[0]).count("hermes-agent-groups-context") == 1
    assert request["messages"] != messages


def test_injects_responses_instructions() -> None:
    request = {"instructions": "Hermes base", "input": "hello"}

    rewritten = inject_request_context(request, "group rules")

    assert rewritten["instructions"] == "Hermes base\n\ngroup rules"


def test_a_per_turn_note_lands_at_the_tail_not_in_the_system_prompt() -> None:
    """The group context is stable and cacheable at the front. A note that
    changes every turn must not go there, or it moves the cache boundary
    forward on every turn and re-bills everything behind it."""
    from src.context import append_turn_note

    request = {"messages": [{"role": "system", "content": "base"}, {"role": "user", "content": "hey"}]}
    out = append_turn_note(request, "not addressed to you")

    assert out["messages"][0]["content"] == "base", "the cached prefix is untouched"
    assert out["messages"][-1]["content"] == "not addressed to you"
    assert len(out["messages"]) == 3


def test_an_empty_note_changes_nothing() -> None:
    from src.context import append_turn_note

    request = {"messages": [{"role": "user", "content": "hey"}]}
    assert append_turn_note(request, "") == request
