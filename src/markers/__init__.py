"""Marker parser for agent response text.

Strips inline control markers (REACT/REPLY/PROFILE/PROFILEIMAGE/METADATA/
LINK/MEDIA) out of the model's response and returns a structured
:class:`ParsedResponse`.

Public surface re-exported here; implementation in :mod:`parser`.
"""

from .parser import (
    ParsedLink,
    ParsedMarker,
    ParsedResponse,
    parse_response,
)

__all__ = [
    "ParsedLink",
    "ParsedMarker",
    "ParsedResponse",
    "parse_response",
]
