"""Unit tests for parse_response().

Run from the repository root:
  uv run --frozen pytest src/markers/test_markers.py -v
"""

import os
import sys
import unittest
from pathlib import Path

# This test file lives INSIDE the markers package. Add the parent
# (src/) to sys.path so `from markers import ...` resolves to
# the sibling package — keeps the test free of the full hermes import
# graph (httpx, agent runner, etc.).
sys.path.insert(0, str(Path(__file__).parent.parent))
from markers import parse_response, ParsedLink  # noqa: E402


class TestParseResponse(unittest.TestCase):
    # ---- REACT ----

    def test_react_add(self):
        r = parse_response("REACT:msg123:👍\nHello")
        self.assertEqual(len(r.reactions), 1)
        self.assertEqual(r.reactions[0].message_id, "msg123")
        self.assertEqual(r.reactions[0].value, "👍")
        self.assertEqual(r.reactions[0].action, "add")
        self.assertEqual(r.text, "Hello")

    def test_react_remove(self):
        r = parse_response("REACT:msg123:👍:remove")
        self.assertEqual(r.reactions[0].action, "remove")
        self.assertEqual(r.text, "")

    def test_multiple_reacts(self):
        r = parse_response("REACT:a:👍\nREACT:b:❤️\nDone")
        self.assertEqual(len(r.reactions), 2)
        self.assertEqual(r.text, "Done")

    def test_react_inline_with_prefix(self):
        # Model occasionally emits the marker on the same line as
        # other text (e.g. an emoji it also wants visible). Make sure
        # the marker still parses and the residual text survives.
        r = parse_response("👋 REACT:msg123:👍")
        self.assertEqual(len(r.reactions), 1)
        self.assertEqual(r.reactions[0].message_id, "msg123")
        self.assertEqual(r.reactions[0].value, "👍")
        self.assertEqual(r.text, "👋")

    def test_react_inline_marker_only_line(self):
        # No surrounding text → line drops cleanly, no leaked literal.
        r = parse_response("REACT:msg123:👍")
        self.assertEqual(len(r.reactions), 1)
        self.assertEqual(r.text, "")

    def test_react_inline_with_suffix(self):
        # Trailing text after the marker also stays in chat.
        r = parse_response("REACT:msg123:👍 thanks!")
        self.assertEqual(len(r.reactions), 1)
        self.assertEqual(r.text, "thanks!")

    # ---- REPLY ----

    def test_reply(self):
        r = parse_response("REPLY:msg456\nHere is my reply")
        self.assertEqual(r.reply_to, "msg456")
        self.assertEqual(r.text, "Here is my reply")

    def test_last_reply_wins(self):
        r = parse_response("REPLY:first\nREPLY:second\nText")
        self.assertEqual(r.reply_to, "second")

    def test_reply_lenient_space_after_colon(self):
        # Own-line with the marker alone is the documented form; a space
        # after the colon is the most common model deviation. It must still
        # thread instead of leaking the literal marker into chat.
        r = parse_response("REPLY: msg456\nHere is my reply")
        self.assertEqual(r.reply_to, "msg456")
        self.assertEqual(r.text, "Here is my reply")

    def test_reply_inline_with_text_threads_and_does_not_leak(self):
        r = parse_response("REPLY:msg456 Here is my reply")
        self.assertEqual(r.reply_to, "msg456")
        self.assertEqual(r.text, "Here is my reply")
        self.assertNotIn("REPLY", r.text)

    def test_reply_id_capture_stops_at_punctuation(self):
        r = parse_response("REPLY:8c2f04b3, see above\nok")
        self.assertEqual(r.reply_to, "8c2f04b3")
        self.assertNotIn("REPLY", r.text)

    # ---- PROFILE ----

    def test_profile_name(self):
        r = parse_response("PROFILE:QA Bot Alpha\nHello")
        self.assertEqual(r.profile_name, "QA Bot Alpha")
        self.assertEqual(r.text, "Hello")

    def test_profile_not_confused_with_image(self):
        r = parse_response("PROFILEIMAGE:https://example.com/img.png")
        self.assertIsNone(r.profile_name)
        self.assertEqual(r.profile_image, "https://example.com/img.png")

    # ---- PROFILEIMAGE ----

    def test_profile_image(self):
        r = parse_response("PROFILEIMAGE:https://example.com/avatar.png\nHi")
        self.assertEqual(r.profile_image, "https://example.com/avatar.png")
        self.assertEqual(r.text, "Hi")

    # ---- METADATA ----

    def test_metadata(self):
        r = parse_response("METADATA:credits=100\nOk")
        self.assertEqual(r.profile_metadata, {"credits": "100"})
        self.assertEqual(r.text, "Ok")

    def test_multiple_metadata(self):
        r = parse_response("METADATA:a=1\nMETADATA:b=2\nDone")
        self.assertEqual(r.profile_metadata, {"a": "1", "b": "2"})
        self.assertEqual(r.text, "Done")

    def test_metadata_value_with_equals(self):
        r = parse_response("METADATA:url=https://x.com?a=1")
        self.assertEqual(r.profile_metadata, {"url": "https://x.com?a=1"})

    # ---- LINK ----

    def test_link_https(self):
        r = parse_response("LINK:https://example.com/dashboard\nCheck it out")
        self.assertEqual(r.links, [ParsedLink(url="https://example.com/dashboard")])
        self.assertEqual(r.text, "Check it out")

    def test_link_http(self):
        r = parse_response("LINK:http://localhost:3000/logs\nHere are your logs")
        self.assertEqual(r.links, [ParsedLink(url="http://localhost:3000/logs")])
        self.assertEqual(r.text, "Here are your logs")

    def test_link_with_caption(self):
        r = parse_response(
            "LINK:https://simonwillison.net Simon Willison — practical LLM takes\nCheck these out"
        )
        self.assertEqual(
            r.links,
            [
                ParsedLink(
                    url="https://simonwillison.net",
                    caption="Simon Willison — practical LLM takes",
                )
            ],
        )
        self.assertEqual(r.text, "Check these out")

    def test_multiple_links_with_and_without_captions(self):
        r = parse_response("LINK:https://a.com Blog A\nLINK:https://b.com\nTwo links")
        self.assertEqual(len(r.links), 2)
        self.assertEqual(
            r.links,
            [
                ParsedLink(url="https://a.com", caption="Blog A"),
                ParsedLink(url="https://b.com"),
            ],
        )
        self.assertEqual(r.text, "Two links")

    def test_link_without_protocol_ignored(self):
        r = parse_response("LINK:example.com\nText")
        self.assertEqual(r.links, [])
        self.assertEqual(r.text, "LINK:example.com\nText")

    def test_link_inline_ignored(self):
        r = parse_response("Check this LINK:https://example.com please")
        self.assertEqual(r.links, [])
        self.assertIn("LINK:https://example.com", r.text)

    def test_link_between_blank_paragraphs_does_not_double_gap(self):
        # Without the post-collapse, dropping the LINK: line preserves the two
        # surrounding blanks back-to-back and the chat renders \n\n\n (two
        # blank lines) between paragraphs. Verify the fix collapses to one.
        r = parse_response("para 1\n\nLINK:https://example.com\n\npara 2")
        self.assertEqual(r.links, [ParsedLink(url="https://example.com")])
        self.assertEqual(r.text, "para 1\n\npara 2")

    def test_other_marker_drops_also_collapse_gap(self):
        # Same shape, different markers — the post-collapse is marker-agnostic.
        self.assertEqual(
            parse_response("para 1\n\nREACT:msg1:👍\n\npara 2").text,
            "para 1\n\npara 2",
        )
        self.assertEqual(
            parse_response("para 1\n\nREPLY:msg1\n\npara 2").text,
            "para 1\n\npara 2",
        )
        self.assertEqual(
            parse_response("para 1\n\nMETADATA:role=admin\n\npara 2").text,
            "para 1\n\npara 2",
        )
        self.assertEqual(
            parse_response("para 1\n\nMEDIA:/tmp/x.png\n\npara 2").text,
            "para 1\n\npara 2",
        )

    # ---- MEDIA ----

    def test_media_standalone(self):
        r = parse_response("MEDIA:/tmp/image.png\nHere you go")
        self.assertEqual(r.media, ["/tmp/image.png"])
        self.assertEqual(r.text, "Here you go")

    def test_media_inline(self):
        r = parse_response("Check this out MEDIA:/tmp/file.pdf please")
        self.assertEqual(r.media, ["/tmp/file.pdf"])
        self.assertIn("Check this out", r.text)

    def test_multiple_media(self):
        r = parse_response("MEDIA:/a.png\nMEDIA:/b.png\nFiles attached")
        self.assertEqual(len(r.media), 2)
        self.assertEqual(r.text, "Files attached")

    def test_media_relative_dot_slash(self):
        r = parse_response("MEDIA:./zoom1.jpg\nHere you go")
        self.assertEqual(r.media, ["./zoom1.jpg"])
        self.assertEqual(r.text, "Here you go")

    def test_media_relative_dot_dot_slash(self):
        r = parse_response("MEDIA:../output/chart.png\nChart attached")
        self.assertEqual(r.media, ["../output/chart.png"])
        self.assertEqual(r.text, "Chart attached")

    def test_media_home_tilde(self):
        r = parse_response("MEDIA:~/barcelona_spots.md\nHere you go")
        self.assertEqual(r.media, ["~/barcelona_spots.md"])
        self.assertEqual(r.text, "Here you go")

    def test_media_mixed_absolute_and_relative(self):
        r = parse_response("MEDIA:/tmp/a.png\nMEDIA:./b.png\nDone")
        self.assertEqual(len(r.media), 2)
        self.assertEqual(r.media, ["/tmp/a.png", "./b.png"])
        self.assertEqual(r.text, "Done")

    def test_media_env_var_expansion(self):
        prev = os.environ.get("STATE_DIR")
        os.environ["STATE_DIR"] = "/wksp"
        try:
            r = parse_response(
                "MEDIA:$STATE_DIR/workspace/skills/generated/launchpad/SKILL.md\nHere's the skill"
            )
            self.assertEqual(
                r.media, ["/wksp/workspace/skills/generated/launchpad/SKILL.md"]
            )
            self.assertEqual(r.text, "Here's the skill")
        finally:
            if prev is None:
                os.environ.pop("STATE_DIR", None)
            else:
                os.environ["STATE_DIR"] = prev

    def test_media_braced_env_var_expansion(self):
        prev = os.environ.get("STATE_DIR")
        os.environ["STATE_DIR"] = "/wksp"
        try:
            r = parse_response(
                "MEDIA:${STATE_DIR}/workspace/skills/generated/foo/SKILL.md"
            )
            self.assertEqual(r.media, ["/wksp/workspace/skills/generated/foo/SKILL.md"])
        finally:
            if prev is None:
                os.environ.pop("STATE_DIR", None)
            else:
                os.environ["STATE_DIR"] = prev

    def test_media_unset_env_var_left_literal(self):
        os.environ.pop("DEFINITELY_UNSET_VAR_XYZ", None)
        r = parse_response("MEDIA:$DEFINITELY_UNSET_VAR_XYZ/foo.md\nok")
        self.assertEqual(r.media, ["$DEFINITELY_UNSET_VAR_XYZ/foo.md"])
        self.assertEqual(r.text, "ok")

    # ---- Combined ----

    def test_all_markers(self):
        raw = "\n".join(
            [
                "REACT:msg1:👀",
                "REPLY:msg2",
                "PROFILE:Test Bot 🤖",
                "METADATA:status=active",
                "LINK:https://example.com/report",
                "MEDIA:/tmp/report.pdf",
                "Here is your report!",
            ]
        )
        r = parse_response(raw)
        self.assertEqual(len(r.reactions), 1)
        self.assertEqual(r.reply_to, "msg2")
        self.assertEqual(r.profile_name, "Test Bot 🤖")
        self.assertEqual(r.profile_metadata, {"status": "active"})
        self.assertEqual(
            r.links, [ParsedLink(url="https://example.com/report", reply_to="msg2")]
        )
        self.assertEqual(r.media, ["/tmp/report.pdf"])
        self.assertEqual(r.text, "Here is your report!")

    def test_plain_text(self):
        r = parse_response("Just a normal message\nWith two lines")
        self.assertEqual(r.text, "Just a normal message\nWith two lines")
        self.assertEqual(r.reactions, [])
        self.assertEqual(r.media, [])
        self.assertIsNone(r.reply_to)
        self.assertIsNone(r.profile_name)
        self.assertIsNone(r.profile_image)
        self.assertEqual(r.profile_metadata, {})

    def test_only_markers(self):
        r = parse_response("REACT:m:👍\nPROFILE:Bot")
        self.assertEqual(r.text, "")

    # ---- SEND: ----

    def test_send_block_extracted(self):
        r = parse_response("internal reasoning\n\nSEND:\nHello user")
        self.assertEqual(r.send_text, "Hello user")
        self.assertEqual(r.text, "internal reasoning")

    def test_send_block_multiline(self):
        r = parse_response("preamble\nSEND:\nLine one\nLine two")
        self.assertEqual(r.send_text, "Line one\nLine two")
        self.assertEqual(r.text, "preamble")

    def test_no_send_block_gives_none(self):
        r = parse_response("just a normal reply")
        self.assertIsNone(r.send_text)
        self.assertEqual(r.text, "just a normal reply")

    def test_send_block_empty_suppresses_text(self):
        r = parse_response("preamble\nSEND:\n")
        self.assertEqual(r.send_text, "")
        self.assertEqual(r.text, "preamble")

    def test_send_block_discards_preamble_from_text(self):
        # text should only contain lines before SEND:
        r = parse_response("orchestration noise\nSEND:\nclean reply")
        self.assertEqual(r.text, "orchestration noise")
        self.assertEqual(r.send_text, "clean reply")

    def test_send_block_with_media_marker_before(self):
        # MEDIA: before SEND: still applies; text preamble is whatever's left
        r = parse_response("MEDIA:/tmp/file.png\nSEND:\nHere is your file")
        self.assertEqual(r.media, ["/tmp/file.png"])
        self.assertEqual(r.send_text, "Here is your file")
        self.assertEqual(r.text, "")

    def test_send_block_with_media_marker_after(self):
        # MEDIA: after SEND: still applies globally
        r = parse_response("SEND:\nHere is your file\nMEDIA:/tmp/file.png")
        self.assertEqual(r.media, ["/tmp/file.png"])
        self.assertEqual(r.send_text, "Here is your file")

    def test_send_block_alone(self):
        r = parse_response("SEND:\nOnly this")
        self.assertEqual(r.send_text, "Only this")
        self.assertEqual(r.text, "")

    def test_send_inline_text_same_line(self):
        # Models routinely inline the first sentence after the colon instead
        # of the taught bare-line form. Strict matching used to suppress the
        # whole synthesis reply ("no SEND: block") on this deviation.
        r = parse_response("internal reasoning\nSEND:I've checked your calendar.")
        self.assertEqual(r.send_text, "I've checked your calendar.")
        self.assertEqual(r.text, "internal reasoning")

    def test_send_inline_with_following_lines(self):
        r = parse_response("preamble\nSEND: Line one\nLine two")
        self.assertEqual(r.send_text, "Line one\nLine two")
        self.assertEqual(r.text, "preamble")

    def test_send_inline_with_media_marker_on_same_line(self):
        # The inline remainder re-enters the per-line pipeline, so markers
        # riding the SEND: line still apply.
        r = parse_response("SEND:Here is your file MEDIA:/tmp/file.png")
        self.assertEqual(r.media, ["/tmp/file.png"])
        self.assertEqual(r.send_text, "Here is your file")

    def test_send_midline_mention_stays_literal(self):
        # Only a line *starting* with SEND: opens the block; prose that
        # mentions the marker mid-line is left untouched.
        r = parse_response("I will SEND: the file later")
        self.assertIsNone(r.send_text)
        self.assertEqual(r.text, "I will SEND: the file later")


if __name__ == "__main__":
    unittest.main()
