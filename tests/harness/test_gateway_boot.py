"""A gateway that starts is not the same as a gateway that answers.

This is the test that would have caught the outage, and the reason it exists is
that the cheaper checks did not.

`api_server` is the only platform this project runs, and upstream builds it with
aiohttp while declaring aiohttp only under extras this project does not install.
So the dependency is declared in `pyproject.toml`, nothing in this repo imports
it, and it reads as removable. Removing it does not fail. The gateway starts,
logs

    WARNING gateway.run: API Server: aiohttp not installed
    WARNING gateway.run: No adapter available for api_server

creates no adapter, and listens on nothing — three healthy processes answering
no port while every agent reads as unreachable. The import that decides it lives
inside the adapter's constructor, so importing every module the gateway boots
proves nothing, and that is exactly the check that was run and reported as
verification.

What proves it is starting one and asking. This does that: a real gateway, the
same executable the container launches, on a free port with a generated key and
no provider credentials at all. It is slower than an import and it is the only
version of this that cannot be satisfied by a warning.
"""

from __future__ import annotations

import os
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from src.defaults import config_for, gateway_binary

# Generous, because CI is slower than a laptop. It is rarely reached: the
# gateway announces its own refusals and this stops on one, so a real failure
# costs a few seconds rather than the ceiling.
BOOT_TIMEOUT_SECONDS = 90

# What the gateway says when it has decided not to serve. It keeps running
# afterwards — queueing the platform for retry — so without these there is
# nothing to wait for except the timeout.
REFUSALS = (
    "Refusing to start",
    "No adapter available for api_server",
    "No adapter could be created",
    "failed to connect",
)


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _ask(port: int, key: str | None) -> int:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/sessions")
    if key:
        request.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return int(response.status)
    except urllib.error.HTTPError as refused:
        return int(refused.code)
    except OSError:
        return 0


def test_a_cold_gateway_serves_its_api(tmp_path: Path) -> None:
    binary = Path(gateway_binary())
    if not binary.exists():
        pytest.fail(
            f"no gateway at {binary} — run `uv sync` before the suite. This test "
            "launches the real executable on purpose; there is no version of it "
            "that can be mocked and still mean anything."
        )

    port = _free_port()
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(config_for(port, headline="Boot check."))

    # A locally-generated key, which is all the API server requires; it refuses
    # to start without one even on a loopback bind, and refuses again if it is
    # short enough to guess — this endpoint dispatches agent work, so a weak key
    # is remote code execution and upstream is right to say so. No provider
    # credentials are passed, and the ones on the developer's machine are
    # removed, so this can never reach a paid API.
    key = secrets.token_hex(32)
    env = {
        **os.environ,
        "HERMES_HOME": str(home),
        "HERMES_AGENT_NAME": "BootCheck",
        "API_SERVER_KEY": key,
    }
    for provider in ("OPENROUTER_API_KEY", "ELEVENLABS_API_KEY", "ANTHROPIC_API_KEY"):
        env.pop(provider, None)

    log = tmp_path / "gateway.log"
    with log.open("w") as sink:
        gateway = subprocess.Popen(
            [str(binary), "-v"], stdout=sink, stderr=sink, env=env, cwd=binary.parents[2]
        )
    try:
        deadline = time.monotonic() + BOOT_TIMEOUT_SECONDS
        status = 0
        while time.monotonic() < deadline:
            if gateway.poll() is not None:
                break
            status = _ask(port, None)
            if status:
                break
            if any(line in log.read_text(errors="replace") for line in REFUSALS):
                break
            time.sleep(0.5)

        # The whole point, in one assertion: it is listening. A gateway with no
        # adapter reaches this having logged a warning and nothing else, so the
        # log goes in the message — otherwise the failure reads as "port closed"
        # and the reason is in a file nobody opens.
        assert status, (
            f"the gateway never served :{port} within {BOOT_TIMEOUT_SECONDS}s "
            f"(exit={gateway.poll()}). Its log:\n"
            + "\n".join(log.read_text(errors="replace").splitlines()[-25:])
        )
        assert status == 401, f"expected an unauthenticated request to be refused, got {status}"
        assert _ask(port, key) == 200, "a request with the API key should be served"
    finally:
        gateway.terminate()
        try:
            gateway.wait(timeout=15)
        except subprocess.TimeoutExpired:
            gateway.kill()
            gateway.wait(timeout=15)
