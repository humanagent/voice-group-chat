"""Who is in the room.

There is no roster to read. A member is whoever has prefixed a line with their
name, which is also how the agent tells people apart — so deriving the list the
same way keeps every header honest about exactly what the agent can see, rather
than showing a list it does not have.

Shared by the group client and the log reader so the two cannot drift into
disagreeing about who is present.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request

SPEAKER = re.compile(r"^\s*([^\n:]{1,24}):\s")


def agent_name() -> str:
    return os.environ.get("HERMES_AGENT_NAME", "agent")


def speakers_in(text: str) -> list[str]:
    """Names prefixing the lines of one message, in order."""
    found: list[str] = []
    for line in str(text or "").split("\n"):
        match = SPEAKER.match(line)
        if match:
            name = match.group(1).strip()
            if name and name not in found:
                found.append(name)
    return found


# Somebody typing without putting a name on it. They are still in the room —
# leaving them out made the header disagree with the agent, which knew perfectly
# well who it was talking to.
#
# Only used when nobody has given a name at all. One person alternating between
# "Fabri: hey" and "hey" is one person, and listing them as two was the header
# describing the notation rather than the room.
UNNAMED = "you"


def members(host: str, chat: str, key: str) -> list[str]:
    """Everyone who has spoken in this room, in the order they first did.

    A message with no name prefix counts too, as ``you``: most messages arrive
    that way, and a roster that omits the person actually typing is worse than
    one with a placeholder in it.

    Fails open to an empty list: a header is not worth failing a session over.
    """
    req = urllib.request.Request(
        f"http://{host}/api/sessions/{chat}/messages",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
    except Exception:  # noqa: BLE001
        return []

    seen: list[str] = []
    anonymous = False
    for message in data.get("data") or []:
        if message.get("role") != "user":
            continue
        content = message.get("content")
        named = speakers_in(content)
        for name in named:
            if name not in seen:
                seen.append(name)
        if not named and str(content or "").strip():
            anonymous = True

    # A name only becomes a separate member when there is no name to attribute
    # the unprefixed messages to.
    if anonymous and not seen:
        seen.append(UNNAMED)
    return seen
