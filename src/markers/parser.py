"""Marker parser implementation.

Supported markers (one per line, stripped from output):
  REACT:messageId:emoji[:remove]
  REPLY:messageId
  PROFILE:New Name
  PROFILEIMAGE:https://url
  METADATA:key=value
  LINK:https://url [optional caption]  — URL sent as a separate message
  MEDIA:/path/to/file                  — can appear inline; accepts
                                         /abs, ./rel, ~/home, $VAR/${VAR} paths
  SEND:                                — block marker: everything after this
                                         line is the user-visible reply text,
                                         separating internal reasoning from the
                                         dispatch. If present, callers use ONLY
                                         this block as the outbound text and
                                         discard everything before it.

(The progress badge is driven in real time by the runtime — ProgressProducer +
explicit owners — not by a marker. There is no ``THINKING:`` marker.)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field


@dataclass
class ParsedMarker:
    type: str  # react, reply, media, profile, profileimage
    value: str  # emoji, path, name, url
    message_id: str | None = None
    action: str = "add"  # for react: add/remove


@dataclass
class ParsedLink:
    url: str
    caption: str | None = None
    reply_to: str | None = None


@dataclass
class ParsedResponse:
    """Result of parsing markers from agent response text."""

    text: str  # cleaned text (markers stripped)
    reply_to: str | None = None  # message ID to reply to
    reactions: list[ParsedMarker] = field(default_factory=list)
    media: list[str] = field(default_factory=list)
    links: list[ParsedLink] = field(default_factory=list)
    profile_name: str | None = None
    profile_image: str | None = None
    profile_metadata: dict[str, str] = field(default_factory=dict)
    # Explicit user-visible block from SEND: marker. When present, callers
    # dispatch this instead of `text` and discard everything the model wrote
    # before SEND:. None = no SEND: block found.
    send_text: str | None = None


def parse_response(raw: str) -> ParsedResponse:
    """Extract all markers from the agent's response text."""
    result = ParsedResponse(text="")
    lines = raw.split("\n")
    text_lines: list[str] = []
    # Once SEND: is encountered, remaining lines go here instead of text_lines.
    send_lines: list[str] | None = None

    for line in lines:
        stripped = line.strip()

        # SEND: — starts the user-visible block. Everything after it is the
        # outbound reply; everything before is internal. The taught form is the
        # marker alone on its own line, but models routinely inline the first
        # sentence after the colon (``SEND:Here's what I found…``) — and under
        # strict bare-line matching that deviation suppressed the entire reply
        # ("no SEND: block"). Parse leniently, mirroring REPLY / REACT: a line
        # *starting* with ``SEND:`` opens the block, and any same-line remainder
        # re-enters the per-line pipeline as the first reply line (so inline
        # markers on it still apply).
        if stripped.startswith("SEND:"):
            if send_lines is None:
                send_lines = []
            rest = stripped[len("SEND:") :].lstrip()
            if not rest:
                continue
            line = rest
            stripped = rest

        # Once inside the SEND: block, route lines to send_lines instead of
        # text_lines. Markers (MEDIA:, PROFILE:, etc.) still apply globally
        # regardless of which section they appear in.
        # REACT:messageId:emoji or REACT:messageId:emoji:remove
        # Searched anywhere on the line (not anchored), then stripped
        # from the residual text — mirrors the inline MEDIA handling
        # below. Strict ``^...$`` matching broke when the model emitted
        # the marker alongside other content on the same line
        # (e.g. ``👋 REACT:abc:👋`` — emoji prefix + marker),
        # leaking the literal ``REACT:`` string into chat. ``[^:\s]+``
        # on both groups keeps msgid + emoji bounded; the optional
        # ``:remove`` tail is the only other accepted suffix.
        react_match = re.search(r"REACT:([^:\s]+):([^:\s]+)(?::(remove))?", line)
        if react_match:
            result.reactions.append(
                ParsedMarker(
                    type="react",
                    value=react_match.group(2),
                    message_id=react_match.group(1),
                    action="remove" if react_match.group(3) else "add",
                )
            )
            line = (line[: react_match.start()] + line[react_match.end() :]).strip()
            if not line:
                continue
            stripped = line

        # REPLY:messageId — sets the reply target for the whole message.
        # The documented form is the marker alone on its own line, and that
        # stays the taught contract (MESSAGING.eta.md). The parse is lenient
        # anyway — searched anywhere on the line, optional whitespace after
        # the colon, then stripped from the residual text, mirroring REACT:
        # models deviate from the own-line form in practice, and under strict
        # ``^...$`` matching a deviation failed twice over — the message
        # didn't thread AND the literal ``REPLY:…`` string leaked into chat.
        # The id charset (hex / ULID / UUID) stops the capture at any
        # trailing prose or punctuation.
        reply_match = re.search(r"REPLY:\s*([A-Za-z0-9_-]+)", line)
        if reply_match:
            result.reply_to = reply_match.group(1)
            line = (line[: reply_match.start()] + line[reply_match.end() :]).strip()
            if not line:
                continue
            stripped = line

        # PROFILE:name
        m = re.match(r"^PROFILE:(.+)$", stripped)
        if m:
            result.profile_name = m.group(1).strip()
            continue

        # PROFILEIMAGE:url
        m = re.match(r"^PROFILEIMAGE:(https?://\S+)$", stripped)
        if m:
            result.profile_image = m.group(1).strip()
            continue

        # METADATA:key=value
        m = re.match(r"^METADATA:(\w+)=(.+)$", stripped)
        if m:
            result.profile_metadata[m.group(1)] = m.group(2).strip()
            continue

        # LINK:https://url [optional caption] — send URL as a separate message
        m = re.match(r"^LINK:(https?://\S+)(?:\s+(.+))?$", stripped)
        if m:
            result.links.append(
                ParsedLink(
                    url=m.group(1), caption=m.group(2).strip() if m.group(2) else None
                )
            )
            continue

        # MEDIA path — can be inline. Accepts:
        #   /abs, ./rel, ../rel, ~/home, $VAR/…, ${VAR}/…
        # $VAR / ${VAR} are expanded via os.path.expandvars; unset vars are
        # left literal so the downstream send_attachment failure surfaces a
        # legible path rather than silently swallowing the marker.
        media_match = re.search(
            r"MEDIA:(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/\S+|~?\.{0,2}/\S+)",
            line,
        )
        if media_match:
            result.media.append(os.path.expandvars(media_match.group(1)))
            line = line[: media_match.start()] + line[media_match.end() :]
            line = line.strip()
            if not line:
                continue

        if send_lines is not None:
            send_lines.append(line)
        else:
            text_lines.append(line)

    # Marker lines (LINK, REACT, REPLY, PROFILE, PROFILEIMAGE, METADATA, and
    # MEDIA-only) are dropped without consuming surrounding blank lines, so a
    # marker sandwiched between two paragraphs (paragraph\n\nLINK:\n\nparagraph)
    # would otherwise leave a doubled gap (\n\n\n) in the rendered chat.
    # Mirrors the post-collapse in strip_suppress_lines().
    result.text = re.sub(r"\n{3,}", "\n\n", "\n".join(text_lines)).strip()

    if send_lines is not None:
        result.send_text = re.sub(r"\n{3,}", "\n\n", "\n".join(send_lines)).strip()

    # REPLY applies to all outbound messages, including links.
    if result.reply_to and result.links:
        for link in result.links:
            link.reply_to = result.reply_to

    return result
