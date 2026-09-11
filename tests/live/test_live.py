"""The layer against a running gateway.

Everything else here is a unit test, and every bug this layer has had got past
them. The flag that swallowed real replies, the preamble that broke the prompt
cache, the vocative without a comma: all found by reading the log of a live
turn, and pinned by a unit test only afterwards. These run the same six checks
first.

They skip when nothing is listening, so `pnpm test` stays useful with the
runtime down. Start it (`pnpm start`) and they run.

They cost real tokens and a few seconds each, which is why there are six of them
and not sixty. Each is a case that has actually been wrong at some point.
"""

from __future__ import annotations

import json
import os
import pathlib
import socket
import time
import urllib.error
import urllib.request

import pytest

HOST = os.environ.get("HOST", "127.0.0.1:8642")
REPO = pathlib.Path(__file__).resolve().parents[1]
GATEWAY_HOME = REPO / ".hermes"
SILENT = {"NO_REPLY", "SILENT", "HEARTBEAT_OK", "(empty)"}


def _listening() -> bool:
    host, _, port = HOST.partition(":")
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex((host, int(port))) == 0


def _key() -> str | None:
    env = GATEWAY_HOME / ".env"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        if line.startswith("API_SERVER_KEY="):
            return line.split("=", 1)[1].strip()
    return None


pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not _listening() or not _key(),
        reason="no gateway on {} — start it with `pnpm start`".format(HOST),
    ),
]


def _call(method: str, path: str, payload: dict | None = None, timeout: int = 240):
    req = urllib.request.Request(
        f"http://{HOST}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {_key()}", "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return json.loads(body) if body else {}


@pytest.fixture
def chat():
    """A chat of its own, torn down after. Chats are cheap and shared state is
    not: a leftover history changes what the next turn decides."""
    name = f"pytest-{int(time.time() * 1000)}"
    _call("POST", "/api/sessions", {"session_id": name}, timeout=30)
    yield name
    try:
        _call("DELETE", f"/api/sessions/{name}", timeout=30)
    except urllib.error.HTTPError:
        pass


@pytest.fixture
def mode():
    """Set a chat's participation mode the way the gateway reads it, and put it
    back afterwards."""
    os.environ.setdefault("HERMES_HOME", str(GATEWAY_HOME))
    from src.policy import participation

    touched: list[str] = []

    def _set(chat_name: str, value: str) -> None:
        participation.set_mode(chat_name, value)
        touched.append(chat_name)

    yield _set
    for name in touched:
        participation.set_mode(name, participation.DEFAULT)


def say(chat_name: str, text: str) -> str:
    """One turn, as WORDS.

    The audio marker comes off first, the way every real client takes it off:
    a spoken reply arrives as a `MEDIA:` line plus the text, and a hundred-odd
    characters of file path is not something the agent said. Measuring the raw
    reply is how a 248-character answer failed a 250-character cap.
    """
    from src.policy import voice

    reply = (
        _call("POST", f"/api/sessions/{chat_name}/chat", {"message": text})
        .get("message", {})
        .get("content", "")
    )
    _, said = voice.split(reply)
    return said


def quiet(reply: str) -> bool:
    return reply.strip() in SILENT


# ── the six ──────────────────────────────────────────────────────────────────

def test_it_answers_when_called(chat) -> None:
    assert not quiet(say(chat, "Fabri: agent, what time is it?"))


def test_a_room_starts_quiet_until_called(chat) -> None:
    """Mentions-only is the default, so an unaddressed message gets nothing even
    when it is a perfectly good question."""
    assert quiet(say(chat, "Fabri: does anyone know what time it is?"))


def test_it_does_not_answer_over_somebody_else(chat, mode) -> None:
    """The observed false positive, and the reason addressing stopped being the
    model's judgement call: a question aimed at Steve, answered by the agent."""
    mode(chat, "speak")
    assert quiet(say(chat, "Fabri: Steve, do you know when the post office opens?"))


def test_a_greeting_without_a_comma_still_names_somebody(chat, mode) -> None:
    """People leave the comma out. "hey pepe how are you" calls Pepe exactly as
    much as "Pepe, how are you?" does, and this was answering the first one."""
    mode(chat, "speak")
    assert quiet(say(chat, "Fabri: hey pepe how are you"))


def test_a_paused_room_says_nothing_even_when_called(chat, mode) -> None:
    mode(chat, "paused")
    assert quiet(say(chat, "Fabri: agent, what time is it?"))


def test_a_long_answer_comes_back_capped(chat) -> None:
    """Guidance biases the model toward short; the cap is what makes it true."""
    reply = say(chat, "Fabri: agent, tell me the whole history of tea, long and detailed")
    assert not quiet(reply)
    assert len(reply) <= 250, f"{len(reply)} chars got past the cap"
