"""Unit tests for strip_markdown — chat output must never carry raw HTML."""

from __future__ import annotations

import unittest

from src.policy.outbound_length import strip_markdown


class TestStripMarkdownHtml(unittest.TestCase):
    def test_anchor_becomes_label_and_url(self):
        self.assertEqual(
            strip_markdown('See <a href="https://example.com">the docs</a> now.'),
            "See the docs (https://example.com) now.",
        )

    def test_monitor_fire_leak_case(self):
        # The exact shape that leaked: a 2-item monitor summary citing sources
        # as <a> anchors, dispatched as a plain chat message.
        raw = (
            'NVIDIA launched <a href="https://engtechnica.com/cosmos-3/">'
            "Cosmos 3</a>, an open omnimodel. Microsoft Research released "
            '<a href="https://the-decoder.com/lens/">Lens</a>, a 3.8B model.'
        )
        self.assertEqual(
            strip_markdown(raw),
            "NVIDIA launched Cosmos 3 (https://engtechnica.com/cosmos-3/), an "
            "open omnimodel. Microsoft Research released Lens "
            "(https://the-decoder.com/lens/), a 3.8B model.",
        )

    def test_single_quoted_href(self):
        self.assertEqual(
            strip_markdown("<a href='https://x.io'>X</a>"),
            "X (https://x.io)",
        )

    def test_residual_tags_dropped(self):
        self.assertEqual(
            strip_markdown("<b>Bold</b> and <br/>line<p>para</p>"),
            "Bold and linepara",
        )

    def test_less_than_with_space_survives(self):
        self.assertEqual(strip_markdown("x < y and 2<3"), "x < y and 2<3")

    def test_entities_unescaped(self):
        self.assertEqual(
            strip_markdown("Tom &amp; Jerry &lt;3"),
            "Tom & Jerry <3",
        )

    def test_markdown_link_still_collapses(self):
        self.assertEqual(
            strip_markdown("Read [the docs](https://example.com)."),
            "Read the docs (https://example.com).",
        )

    def test_anchor_url_survives_whitespace_and_unquoted_href(self):
        """Slightly-off markup must not silently drop the URL.

        Both shapes previously failed the anchor regex and fell through to the
        generic tag remover, which emits the label alone — the docstring
        promises the URL is retained.
        """
        self.assertEqual(
            strip_markdown('<a href = "https://sp.example">Docs</a>'),
            "Docs (https://sp.example)",
        )
        self.assertEqual(
            strip_markdown("<a href=https://uq.example>Docs</a>"),
            "Docs (https://uq.example)",
        )

    def test_data_href_does_not_shadow_the_real_destination(self):
        """`href` must match at an attribute boundary, not inside `data-href`.

        An unanchored match took the tracking attribute and emitted it as the
        destination — worse than dropping the URL, since the output looked
        correct while pointing somewhere else.
        """
        self.assertEqual(
            strip_markdown(
                '<a data-href="https://track.example" '
                'href="https://dest.example">Docs</a>'
            ),
            "Docs (https://dest.example)",
        )

    def test_anchor_without_href_keeps_its_label(self):
        self.assertEqual(strip_markdown('<a name="x">Docs</a>'), "Docs")

    def test_plain_text_untouched(self):
        self.assertEqual(
            strip_markdown("Just a plain sentence."), "Just a plain sentence."
        )


if __name__ == "__main__":
    unittest.main()
