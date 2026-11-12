"""Tests for cite.py.  python3 -m unittest test_cite"""
import unittest

from cite import extract, quote, sentence
from normalise import finish

PARAGRAPH = ("Vi viser til brev av 5. januar 2022. Stortinget fattet 10. juni 2022 vedtak om endringer i "
             "inneværende års statsbudsjett (Revidert nasjonalbudsjett), jf. Innst. 450 (2021–2022), Prop. 115 S "
             "(2021–2022). Med hjemmel i dette gjøres følgende korrigeringer.")


def blocks_and_text():
    raw = [{"page": 1, "bbox": [0.1, 0.1, 0.9, 0.12], "kind": "heading", "level": 4, "text": "1. Korrigert tildeling"},
           {"page": 1, "bbox": [0.1, 0.13, 0.9, 0.2], "kind": "paragraph", "level": None, "text": PARAGRAPH},
           {"page": 1, "bbox": [0.1, 0.21, 0.9, 0.22], "kind": "list_item", "level": None, "text": "fastsatte mål"}]
    blocks, text, _ = finish([{"html": None, "native": "x", **r} for r in raw], {}, "33245", "marker")
    return blocks, text


class Extract(unittest.TestCase):
    def test_a_phrase_comes_out_as_its_words_only(self):
        blocks, text = blocks_and_text()
        start = text.index("Revidert nasjonalbudsjett")
        self.assertEqual(extract(blocks, start, start + 25), "Revidert nasjonalbudsjett")

    def test_a_span_over_several_blocks_leaves_out_the_markdown_between_them(self):
        blocks, text = blocks_and_text()
        passage = extract(blocks, 0, len(text))
        self.assertTrue(passage.startswith("1. Korrigert tildeling\n\nVi viser til"))
        self.assertTrue(passage.endswith("\n\nfastsatte mål"))
        self.assertNotIn("#", passage)
        self.assertNotIn("- fastsatte", passage)


class Sentence(unittest.TestCase):
    def test_the_sentence_runs_past_abbreviations_and_numbered_dates(self):
        blocks, text = blocks_and_text()
        start = text.index("Revidert nasjonalbudsjett")
        s, e = sentence(blocks, start, start + 25)
        self.assertEqual(text[s:e], "Stortinget fattet 10. juni 2022 vedtak om endringer i inneværende års statsbudsjett "
                                    "(Revidert nasjonalbudsjett), jf. Innst. 450 (2021–2022), Prop. 115 S (2021–2022).")

    def test_a_quote_names_its_pages_and_boxes(self):
        blocks, text = blocks_and_text()
        start = text.index("Revidert")
        q = quote(blocks, start, start + 8, document="kudos:33245")
        self.assertEqual((q["phrase"], q["pages"]), ("Revidert", [1]))
        self.assertEqual(q["boxes"], [{"page": 1, "bbox": [0.1, 0.13, 0.9, 0.2]}])


if __name__ == "__main__":
    unittest.main()
