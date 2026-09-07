"""Unit tests for strip_suppress_lines."""

from __future__ import annotations

import unittest

from src.policy.suppress_tokens import (
    has_standalone_suppress_line,
    has_suppress_token,
    strip_suppress_lines,
)


class TestStripSuppressLines(unittest.TestCase):
    def test_preserves_single_blank_line(self):
        text = (
            "Booked 7pm at Don Julio.\n"
            "\n"
            "Charles asked if we should add anyone else — what do you think?"
        )
        self.assertEqual(strip_suppress_lines(text), text)

    def test_collapses_runs_of_3_plus_newlines(self):
        self.assertEqual(strip_suppress_lines("A\n\n\nB"), "A\n\nB")
        self.assertEqual(strip_suppress_lines("A\n\n\n\n\nB"), "A\n\nB")

    def test_preserves_blank_lines_without_any_tokens(self):
        text = "Line 1\n\nLine 2\n\nLine 3"
        self.assertEqual(strip_suppress_lines(text), text)

    def test_drops_silent_only_line(self):
        text = "Hello\nSILENT\nworld"
        self.assertEqual(strip_suppress_lines(text), "Hello\nworld")

    def test_drops_silent_only_without_doubling_gap(self):
        text = "A\n\nSILENT\n\nB"
        self.assertEqual(strip_suppress_lines(text), "A\n\nB")

    def test_strips_inline_silent_preserves_content(self):
        text = "SILENT Apr 2, 2026 weather check"
        self.assertEqual(strip_suppress_lines(text), "Apr 2, 2026 weather check")

    def test_strips_inline_silent_preserves_indentation(self):
        text = "    some code SILENT here"
        self.assertEqual(strip_suppress_lines(text), "    some code  here")

    def test_strips_markdown_wrapped_inline_silent_preserves_content(self):
        text = "Something **SILENT** here"
        self.assertEqual(strip_suppress_lines(text), "Something  here")

    def test_strips_heartbeat_ok_lines(self):
        text = "ok\nHEARTBEAT_OK\nmore"
        self.assertEqual(strip_suppress_lines(text), "ok\nmore")

    def test_returns_empty_for_token_only_input(self):
        self.assertEqual(strip_suppress_lines("SILENT"), "")

    def test_does_not_strip_empty_word_inline(self):
        # ``(empty)`` is a real English word, NOT a control token to strip from
        # the middle of prose. Whole-message ``(empty)`` suppression is handled
        # by has_standalone_suppress_line; inline stripping must leave it alone.
        text = "the result set is (empty) today"
        self.assertEqual(strip_suppress_lines(text), text)

    def test_returns_input_unchanged_without_tokens(self):
        text = "Just a normal message."
        self.assertEqual(strip_suppress_lines(text), text)

    def test_handles_empty_input(self):
        self.assertEqual(strip_suppress_lines(""), "")


class TestHasStandaloneSuppressLine(unittest.TestCase):
    def test_token_only(self):
        self.assertTrue(has_standalone_suppress_line("SILENT"))

    def test_narration_then_token_on_own_line(self):
        # The observed monitor-fire bug: machinery narration, then a bare SILENT.
        text = "All 10 results already in seen.json. Nothing new this cycle.\n\nSILENT"
        self.assertTrue(has_standalone_suppress_line(text))

    def test_markdown_and_bracket_wrapped_standalone(self):
        self.assertTrue(has_standalone_suppress_line("**SILENT**"))
        self.assertTrue(has_standalone_suppress_line("done\n[SILENT]"))

    def test_inline_token_is_not_standalone(self):
        # A token mixed with real content on the same line is NOT the silence
        # signal — strip_suppress_lines handles that, the message still ships.
        self.assertFalse(
            has_standalone_suppress_line("SILENT Apr 2, 2026 weather check")
        )

    def test_plain_message_is_not_standalone(self):
        self.assertFalse(
            has_standalone_suppress_line("Booked 7pm at Don Julio. All set!")
        )

    def test_upstream_empty_sentinel_standalone(self):
        # The whole-message suppression path (outbound policy) must treat a
        # standalone ``(empty)`` — and narration followed by it — as silence.
        self.assertTrue(has_standalone_suppress_line("(empty)"))
        self.assertTrue(has_standalone_suppress_line("wrote the file\n\n(empty)"))

    def test_prose_mentioning_empty_word_is_not_standalone(self):
        self.assertFalse(has_standalone_suppress_line("the result set is (empty)"))

    def test_empty_input(self):
        self.assertFalse(has_standalone_suppress_line(""))


class TestHasSuppressToken(unittest.TestCase):
    """A word-edged token in ANY position suppresses the whole message."""

    def test_token_only(self):
        self.assertTrue(has_suppress_token("SILENT"))

    def test_trailing_on_same_line_as_prose(self):
        # A token closing a line of prose is the silence signal exactly as a
        # bare token line is — the prose goes with it.
        self.assertTrue(
            has_suppress_token(
                "Pollen has dropped to low overall in the Sunset now "
                "— no more heads-up needed. SILENT"
            )
        )
        self.assertTrue(
            has_suppress_token("Still Extreme tree pollen, unchanged. SILENT")
        )
        self.assertTrue(has_suppress_token('Base iPad still "Don\'t Buy". SILENT'))

    def test_leading_and_mid_sentence(self):
        self.assertTrue(has_suppress_token("SILENT Apr 2, 2026 weather check"))
        self.assertTrue(has_suppress_token("some code SILENT here"))

    def test_markdown_wrapped_inline(self):
        self.assertTrue(has_suppress_token("Something **SILENT** here"))

    def test_other_word_edged_tokens(self):
        self.assertTrue(has_suppress_token("all good HEARTBEAT_OK"))
        self.assertTrue(has_suppress_token("nothing for you NO_REPLY"))

    def test_standalone_non_word_edged_sentinel(self):
        self.assertTrue(has_suppress_token("(empty)"))
        self.assertTrue(has_suppress_token("wrote the file\n\n(empty)"))

    def test_inline_empty_word_is_ordinary_prose(self):
        # ``(empty)`` is not word-edged, so it keeps the standalone-line rule —
        # real English must survive.
        self.assertFalse(has_suppress_token("the result set is (empty) today"))

    def test_lowercase_prose_is_not_a_token(self):
        # Case-sensitive on purpose: SHOUTY_SNAKE is the sentinel, not the word.
        self.assertFalse(
            has_suppress_token("I'll stay silent unless the forecast changes.")
        )
        self.assertFalse(has_suppress_token("no reply came back from the vendor"))

    def test_token_as_substring_of_a_longer_word(self):
        # ``\b`` boundaries: a token buried inside another identifier is not it.
        self.assertFalse(has_suppress_token("the SILENTLY flag was set"))
        self.assertFalse(has_suppress_token("PRESILENT"))

    def test_plain_message(self):
        self.assertFalse(has_suppress_token("Booked 7pm at Don Julio. All set!"))

    def test_empty_input(self):
        self.assertFalse(has_suppress_token(""))


if __name__ == "__main__":
    unittest.main()
