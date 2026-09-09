"""What the gateway needs in the environment but does not declare.

This project runs exactly one platform, `api_server`, and upstream builds it
with aiohttp while declaring aiohttp only under extras — messaging, slack,
matrix and friends — that this project does not install. So the dependency is
declared here instead, and nothing in this repo imports it, which makes it look
removable.

It is not, and removing it does not fail. The gateway boots, logs "API Server:
aiohttp not installed", creates no adapter and listens on nothing, so three
healthy processes sit there answering no port while every agent reads as
unreachable. The import that decides this lives inside the adapter's
constructor (`gateway/platforms/api_server.py`, `from aiohttp import web`), so
importing modules proves nothing about it.

This is the cheap version of the expensive check: it costs an import, and it
fails in CI the moment the dependency is dropped again.
"""

from __future__ import annotations

import importlib.util


def test_the_api_server_platform_can_be_built() -> None:
    """aiohttp is present. Without it the gateway serves no HTTP API at all."""
    assert importlib.util.find_spec("aiohttp") is not None, (
        "aiohttp is missing, so the gateway will start and listen on nothing. "
        "It is a real dependency of the api_server platform; see this module's "
        "docstring before removing it from pyproject.toml again."
    )


def test_the_adapter_upstream_still_builds_on_aiohttp() -> None:
    """If upstream ever stops needing it, this is the test that says so — and
    the dependency can go with it rather than on the evidence that no source
    file here mentions it."""
    spec = importlib.util.find_spec("gateway.platforms.api_server")
    assert spec is not None and spec.origin
    source = open(spec.origin, encoding="utf-8").read()
    assert "aiohttp" in source
