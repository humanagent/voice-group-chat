from __future__ import annotations

from collections.abc import Callable

from src.gateway_plugin import _open_turn, _transform_output, register


class _FakePluginContext:
    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable[..., object]]] = {}
        self.middleware: dict[str, Callable[..., object]] = {}

    def register_hook(self, hook_name: str, callback: Callable[..., object]) -> None:
        # Upstream appends rather than replaces (plugins.py: setdefault(...).append),
        # so a name can carry several callbacks and the double must too.
        self.hooks.setdefault(hook_name, []).append(callback)

    def register_middleware(self, kind: str, callback: Callable[..., object]) -> None:
        self.middleware[kind] = callback


# Everything the plugin registers is either behaviour or observation, and the
# split is load-bearing: exactly one hook may change what the user sees.
BEHAVIOUR_HOOKS = {"transform_llm_output", "pre_llm_call"}
OBSERVER_HOOKS = {
    "pre_llm_call",
    "post_api_request",
    "pre_tool_call",
    "post_tool_call",
}


def test_registers_only_upstream_extension_points() -> None:
    context = _FakePluginContext()

    register(context)

    assert set(context.hooks) == BEHAVIOUR_HOOKS | OBSERVER_HOOKS
    assert set(context.middleware) == {"llm_request"}


def test_observers_cannot_change_a_turn() -> None:
    """An observer that returns a string would silently become a transform.

    ``transform_llm_output`` takes the first non-empty string any hook returns,
    so an observer that returned one would start rewriting replies. Pin them to
    None, and pin that they swallow their own failures — instrumentation must
    never be able to break the turn it is watching.
    """
    context = _FakePluginContext()
    register(context)

    for name in OBSERVER_HOOKS:
        for callback in context.hooks[name]:
            assert callback(session_id="s", turn_id="t") is None
            # Junk in, still nothing out and nothing raised.
            assert callback(conversation_history=object(), usage="bad") is None


def test_suppression_token_anywhere_becomes_upstream_silence() -> None:
    assert _transform_output(response_text="Nothing changed. SILENT") == "NO_REPLY"


def test_send_block_is_selected_and_markdown_is_cleaned() -> None:
    response = "internal narration\nSEND:\n**Friday** works for everyone."

    assert _transform_output(response_text=response) == "Friday works for everyone."


def test_media_and_links_are_preserved_for_upstream_delivery() -> None:
    response = (
        "MEDIA:/tmp/map.png\nLINK:https://example.com map details\nSEND:Here it is"
    )

    assert _transform_output(response_text=response) == (
        "MEDIA:/tmp/map.png\nHere it is\nmap details (https://example.com)"
    )


def test_plain_text_is_deterministically_capped() -> None:
    transformed = _transform_output(response_text="word " * 100)

    assert transformed is not None
    assert len(transformed) <= 250
    assert transformed.endswith("…")


def test_a_question_leaves_the_turn_with_a_name_on_it(monkeypatch) -> None:
    """End to end: the turn opens with Anna's line, the reply asks back without
    naming anybody, and what ships says who it is asking."""
    monkeypatch.setenv("HERMES_AGENT_NAME", "Pepe")
    _open_turn(user_message="Anna: I'm good! Pepe, are you up for something tomorrow?")

    assert _transform_output(response_text="Sure — what did you have in mind?") == (
        "Sure — what did you have in mind, Anna?"
    )


def test_the_name_is_added_before_the_cap_not_after(monkeypatch) -> None:
    """The cap is the layer's one promise about outbound length. A name added
    after the trim would ship 250 characters plus a name."""
    monkeypatch.setenv("HERMES_AGENT_NAME", "Pepe")
    _open_turn(user_message="Anna: Pepe, what do you think?")

    transformed = _transform_output(response_text="word " * 100 + "right?")

    assert transformed is not None and len(transformed) <= 250


def test_the_review_flag_cannot_cross_into_another_turn() -> None:
    """A review runs concurrently with the conversation it reviews, in the same
    session. Keying the flag on the session let the review's flag be consumed by
    a real user turn — that turn went silent and the review spoke. Pin that a
    flag raised on one thread is invisible to another."""
    import threading

    context = _FakePluginContext()
    register(context)
    begin = context.hooks["pre_llm_call"][0]
    begin(session_id="s", user_message="Review the conversation above and consider saving to memory.")

    other: list[str | None] = []
    worker = threading.Thread(
        target=lambda: other.append(_transform_output(response_text="8", session_id="s"))
    )
    worker.start()
    worker.join()

    assert other == ["8"], "another thread's turn must not be swallowed"
    # This thread still holds its own flag.
    assert _transform_output(response_text="Saved.", session_id="s") == "NO_REPLY"


def test_a_background_review_turn_does_not_speak() -> None:
    """Hermes fires its own memory/skill reviews as full turns. Nobody sent them
    and nobody is waiting, so their prose must not reach the chat."""
    context = _FakePluginContext()
    register(context)
    flag = context.hooks["pre_llm_call"][0]

    flag(
        session_id="s1",
        user_message="Review the conversation above and consider saving to memory.",
    )

    assert _transform_output(response_text="Saved.", session_id="s1") == "NO_REPLY"
    # The flag is consumed: the next real turn in the same session still speaks.
    assert _transform_output(response_text="Saved.", session_id="s1") == "Saved."


def test_an_ordinary_turn_is_untouched_by_the_review_gate(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    context = _FakePluginContext()
    register(context)
    context.hooks["pre_llm_call"][0](session_id="s2", user_message="Fabri: agent, hey")

    assert _transform_output(response_text="Hey!", session_id="s2") == "Hey!"
