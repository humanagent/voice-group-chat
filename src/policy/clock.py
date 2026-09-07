"""The time, told rather than looked up.

An agent asked what time it is has no clock. The message arrives as text, and
nothing in the context says when "now" is, so the honest thing it can do is
shell out to `date` — which is exactly what it did: a tool call and a whole
second round, 6s of wall clock, for a fact the process it runs in already knew.

So the turn carries it. One line at the tail, where the per-turn note already
lives: that is after the cached prefix, so a value that changes every turn
cannot move the cache boundary and re-bill everything behind it.

Local time, with the offset spelled out. An agent that knows the hour but not
the zone will still guess wrong for whoever is reading.
"""

from __future__ import annotations

import re
from datetime import datetime

# "-03", "+0530", "UTC-03:00" — an offset wearing the name field.
_OFFSET_AS_ZONE = re.compile(r"^(?:UTC)?[+-]\d{2}:?\d{0,2}$")


def now_note(at: datetime | None = None) -> str:
    """The current local time, as one sentence for the turn note."""
    # `astimezone()` on an aware datetime CONVERTS it to the local zone, which
    # is right for a naive `now()` and wrong for a time handed in already
    # carrying one: a test pinning 17:08-03:00 read 20:08 on a UTC machine.
    now = at or datetime.now()
    if now.tzinfo is None:
        now = now.astimezone()
    # %Z is only worth printing when it is a NAME. Depending on the platform and
    # the tzinfo it can also come back as "-03" or "UTC-03:00", and pairing
    # either with the offset says one fact twice in two notations.
    zone = (now.strftime("%Z") or "").strip()
    offset = now.strftime("%z")
    if not zone or _OFFSET_AS_ZONE.match(zone):
        where = f"UTC{offset}"
    elif zone == "UTC":
        where = "UTC"
    else:
        where = f"{zone}, UTC{offset}"
    return f"\n\nRight now it is {now:%A %d %B %Y, %H:%M} ({where})."
