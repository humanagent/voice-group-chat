"""Transport-neutral silence-token detection and cleanup."""

from __future__ import annotations

import re

_SUPPRESS_TOKENS = {"SILENT", "NO_REPLY", "HEARTBEAT_OK", "(empty)"}
_MULTI_NEWLINE = re.compile(r"\n{3,}")


def _word_edged_pattern(tokens: set[str]) -> re.Pattern[str] | None:
    """Case-sensitive pattern for the word-edged control tokens in ``tokens``.

    Word-edged means alphanumeric at both ends (``SILENT``, ``NO_REPLY``,
    ``HEARTBEAT_OK``) so a ``\\b`` boundary is meaningful. Non-word-edged
    sentinels like ``(empty)`` are excluded — see :func:`has_suppress_token`.
    Matching stays case-sensitive on purpose: these are SHOUTY_SNAKE
    sentinels, and lowercase prose ("I'll stay silent unless it changes")
    must pass through untouched.
    """
    word_edged = [
        re.escape(t) for t in sorted(tokens) if t[:1].isalnum() and t[-1:].isalnum()
    ]
    if not word_edged:
        return None
    return re.compile(r"[\*_`~]*\b(?:" + "|".join(word_edged) + r")\b[\*_`~]*")


def has_suppress_token(text: str, tokens: set[str] | None = None) -> bool:
    """Whether ``text`` carries a suppress token in ANY position — in which case
    the WHOLE message is suppressed.

    A word-edged control token is the model's "nothing to deliver" signal
    wherever it lands. Position carries no meaning: a trailing
    ``"… no more heads-up needed. SILENT"`` means exactly what a bare
    ``SILENT`` line means, so the prose around the token goes with it rather
    than shipping as a message of its own.

    Non-word-edged sentinels (``(empty)``) are ordinary English and only ever
    mean silence as a whole line, so they keep the standalone-line rule.
    """
    if tokens is None:
        tokens = _SUPPRESS_TOKENS
    if not tokens:
        return False
    pattern = _word_edged_pattern(tokens)
    if pattern is not None and pattern.search(text):
        return True
    return has_standalone_suppress_line(text, tokens)


def has_standalone_suppress_line(text: str, tokens: set[str] | None = None) -> bool:
    """Whether any line of ``text`` is JUST a suppress token (modulo surrounding
    markdown emphasis / brackets / whitespace).

    A bare ``SILENT`` line is the worker's explicit "nothing to deliver" control
    signal. When the worker wraps it in machinery narration on separate lines
    ("All 10 results already in seen.json.\\n\\nSILENT"), ``strip_suppress_lines``
    removes only the token line and the narration leaks to the user. Callers use
    this to suppress the WHOLE message instead — if the worker emitted the
    sentinel at all, it meant to stay silent."""
    if tokens is None:
        tokens = _SUPPRESS_TOKENS
    if not tokens:
        return False
    line_pattern = re.compile(
        r"^[\s\*_`~\[\]]*(?:"
        + "|".join(re.escape(t) for t in tokens)
        + r")[\s\*_`~\[\]]*$"
    )
    return any(line_pattern.match(line) for line in text.split("\n"))


def strip_suppress_lines(text: str, tokens: set[str] | None = None) -> str:
    """Strip suppress tokens from text."""
    if tokens is None:
        tokens = _SUPPRESS_TOKENS
    if not tokens:
        return text

    # Inline stripping is for word-edged control tokens (SILENT, NO_REPLY,
    # HEARTBEAT_OK) that a worker may prefix to real content. The ``\b``
    # boundary keeps a legitimate message intact (e.g. "the result set is
    # (empty)" must NOT be mutated). Non-word-edged sentinels like ``(empty)``
    # are deliberately NOT stripped inline — they only ever appear as the WHOLE
    # response, and that case is caught by :func:`has_standalone_suppress_line`.
    #
    # NOTE: on the outbound path a word-edged token anywhere already suppressed
    # the whole message (:func:`has_suppress_token`), so this runs only where a
    # caller wants the text cleaned rather than dropped.
    token_pattern = _word_edged_pattern(tokens)
    if token_pattern is None:
        return text

    kept: list[str] = []
    for line in text.split("\n"):
        match = token_pattern.search(line)
        cleaned = token_pattern.sub("", line)
        if cleaned == line:
            kept.append(line)
            continue
        trimmed_cleaned = cleaned.strip()
        if trimmed_cleaned:
            prefix = line[: match.start()] if match is not None else ""
            kept.append(cleaned if prefix.strip() else cleaned.lstrip())

    return _MULTI_NEWLINE.sub("\n\n", "\n".join(kept))
