"""Outbound length — hard cap on the final plain-text reply.

A deterministic cap on the user-visible chat text of a single outbound reply.
A non-exempt reply that exceeds the cap is brought under length right before it
is sent to the app — the sole enforcement point is ``channel._dispatch_response``,
on ``send_text`` only. SOUL/BREVITY guidance still biases the agent toward short
replies; this is the deterministic backstop underneath it so nothing plain-text
ever reaches the app over the cap.

Two ways the cap is applied, in order:

1. **Synthesize** (preferred) — a cheap aux model (gemini-flash) compresses the
   over-limit reply into a natural ≤cap message in the same language. This is a
   pure text→text transform of the already-produced reply; it does NOT re-enter
   the agent loop and does NOT touch session history, so it can't make the agent
   believe it sent text it never did. The aux call is wired in the channel; this
   module supplies the prompt (``synthesis_messages``).
2. **Trim** (``clamp``) — a flat word-boundary cut with an ellipsis. Always the
   final step: ``clamp`` is run on the synthesized candidate too, so the returned
   string is ``<= OUTBOUND_CHAR_LIMIT`` even if the aux model overshoots, errors,
   runs out of credit, or is disabled. This is what keeps the cap deterministic.

The cap touches ONLY the final plain-text bubble. It does not see internal
reasoning (that rides ``messages/thinking``), artifact generation, file writes,
or a subagent's internal output — none of those pass through the dispatch text
branch.

A turn that ships an artifact (an ``.html`` / ``.md`` / ``.pdf`` etc. ``MEDIA:``
attachment) is exempt: it is already the long-form channel, and the short note
riding with it is left intact. A bare image/video attachment does NOT exempt —
a photo riding a wall of text still gets trimmed.

This module owns the threshold, the exemption test, the synthesis prompt, and
the trim so they sit in one place.
"""

from __future__ import annotations

import html
import re
from pathlib import Path

from ..markers import ParsedResponse

# Image/video attachments are NOT the long-form channel. Any other media — an
# ``.html`` / ``.md`` / ``.pdf`` artifact — means the turn is already long-form.
_IMAGE_VIDEO_EXT = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".heic",
        ".heif",
        ".bmp",
        ".svg",
        ".tiff",
        ".mp4",
        ".mov",
        ".webm",
        ".m4v",
        ".avi",
        ".mkv",
    }
)

# Hard cap on a single reply's user-visible characters. The product guidance is
# two sentences max; a non-exempt plain-text reply is trimmed to this length
# before it reaches the app.
OUTBOUND_CHAR_LIMIT = 250

# Ellipsis appended when a reply is trimmed, so the cut is visible to the user
# rather than looking like the message ended mid-word by accident.
_ELLIPSIS = "…"


# Anchor rewriting, attribute-aware. The naive `href=["']...["']` form loses
# the URL whenever the markup deviates even slightly — whitespace around `=`
# and unquoted values both fall through to the generic tag remover, which emits
# the label alone. Worse, an unanchored `href` also matches the tail of
# `data-href`, so a tracking attribute preceding the real one wins and the
# emitted URL is the wrong destination entirely.
_ANCHOR_RE = re.compile(
    r"<a\b(?P<attrs>[^>]*)>(?P<label>.*?)</a\s*>",
    re.IGNORECASE | re.DOTALL,
)
# `href` must start at an attribute boundary (not `data-href`), may be
# surrounded by whitespace, and may be quoted or bare.
_HREF_RE = re.compile(
    r"(?:^|[\s\"'/])href\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'=<>`]+))",
    re.IGNORECASE,
)


def _anchor_replacement(match: re.Match[str]) -> str:
    """Render one anchor as ``label (url)``, or just the label when hrefless."""
    label = match.group("label")
    href_match = _HREF_RE.search(match.group("attrs"))
    if href_match is None:
        return label
    url = next((g for g in href_match.groups() if g is not None), "")
    return f"{label} ({url})" if url else label


def strip_markdown(text: str) -> str:
    """Strip heavy Markdown formatting and stray HTML for chat output.

    The gateway output plugin uses this normalization before delivery. Anchors
    retain their label and URL, while all other tags are removed before
    Markdown formatting and entities are unescaped.
    """
    text = _ANCHOR_RE.sub(_anchor_replacement, text)
    text = re.sub(r"</?[a-zA-Z][^>]*>", "", text)
    text = re.sub(r"```[^\n]*\n([\s\S]*?)```", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text)
    text = re.sub(r"\*{1,3}(.*?)\*{1,3}", r"\1", text)
    text = re.sub(r"~~(.*?)~~", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    return html.unescape(text)


def over_limit(text: str) -> bool:
    """True when the user-visible reply text exceeds the cap."""
    return len(text) > OUTBOUND_CHAR_LIMIT


def clamp(text: str) -> str:
    """Hard-trim ``text`` to the cap, appending an ellipsis when it cut.

    Deterministic: the returned string is always ``<= OUTBOUND_CHAR_LIMIT``.
    Trims on a word boundary when one exists in the tail so the cut reads
    cleanly; falls back to a hard slice otherwise. Caller is responsible for
    the exemption check (``is_exempt``) — this only enforces length.
    """
    if len(text) <= OUTBOUND_CHAR_LIMIT:
        return text
    budget = OUTBOUND_CHAR_LIMIT - len(_ELLIPSIS)
    head = text[:budget]
    cut = head.rsplit(" ", 1)[0] if " " in head[budget // 2 :] else head
    return cut.rstrip() + _ELLIPSIS


_SYNTH_SYSTEM = (
    "You compress one chat reply so it fits a hard character budget while keeping "
    "its meaning and tone. Output ONLY the compressed message — no preamble, no "
    "quotes, no markdown, no notes. It MUST be at most {limit} characters, read "
    "as a single natural, complete chat message, and stay in the SAME language as "
    "the input."
)


def synthesis_messages(text: str) -> tuple[str, str]:
    """Build the (system, user) pair for the aux model that compresses an
    over-limit reply to ``<= OUTBOUND_CHAR_LIMIT``. Pure (no I/O) so it's
    unit-testable; the channel runs the actual aux call and always passes the
    result through ``clamp`` as the deterministic backstop."""
    system = _SYNTH_SYSTEM.format(limit=OUTBOUND_CHAR_LIMIT)
    user = (
        f"Compress this reply to at most {OUTBOUND_CHAR_LIMIT} characters, "
        f"same language, no markdown:\n\n{text}"
    )
    return system, user


def is_exempt(parsed: ParsedResponse) -> bool:
    """True when the turn is exempt from the cap.

    A turn that ships a long-form artifact (an ``.html`` / ``.md`` / ``.pdf``
    etc. ``MEDIA:`` attachment) is exempt — the short note riding with it isn't
    capped. A bare image/video attachment is NOT long-form and does not exempt.
    """
    for item in parsed.media:
        # Strip any URL query/fragment before reading the extension.
        path = str(item).split("?", 1)[0].split("#", 1)[0]
        suffix = Path(path).suffix.lower()
        if suffix and suffix not in _IMAGE_VIDEO_EXT:
            return True
    return False
