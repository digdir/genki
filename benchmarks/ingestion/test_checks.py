"""Tests for the text heuristics in checks.py. Run: .venv/bin/python -m unittest -v"""
import unittest

from checks import (
    boilerplate,
    duplicates,
    glued_spaced,
    numbers,
    page_number_offset,
    rebuild_pages,
    shingle_f1,
    strip_lines,
)

MARK = "-" * 48


def chunk(i, text, meta="{}"):
    return {"chunk_index": i, "content_markdown": text, "metadata": meta}


class RebuildPages(unittest.TestCase):
    def test_splits_on_marker_page_markers(self):
        pages, marked = rebuild_pages([
            chunk(0, f"{{0}}\n\n{MARK}\n\nFirst page.\n\n{{1}}\n\n{MARK}"),
            chunk(1, f"Second page.\n\n{{2}}\n\n{MARK}\n\nThird page."),
        ])
        self.assertEqual(marked, {0, 1, 2})
        self.assertIn("First page.", pages[0])
        self.assertIn("Second page.", pages[1])
        self.assertIn("Third page.", pages[2])

    def test_puts_a_stripped_heading_back_once(self):
        meta = '{"Header 2" "Bakgrunn"}'
        pages, _ = rebuild_pages([
            chunk(0, f"{{0}}\n\n{MARK}\n\nTekst.", meta),
            chunk(1, "Mer tekst.", "{}"),
            chunk(2, "Enda mer.", meta),
        ])
        self.assertEqual(pages[0].count("## Bakgrunn"), 1)
        self.assertLess(pages[0].index("## Bakgrunn"), pages[0].index("Tekst."))

    def test_places_a_heading_on_the_page_its_anchor_names(self):
        pages, _ = rebuild_pages([
            chunk(0, f"{{0}}\n\n{MARK}\n\nA.\n\n{{1}}\n\n{MARK}\n\nB."),
            chunk(1, "C.", '{"Header 3" "<span id=\\"page-0-2\\"></span>3.3.3 Forslag"}'),
        ])
        self.assertIn("3.3.3 Forslag", pages[0])
        self.assertNotIn("3.3.3 Forslag", pages[1])


class Numbers(unittest.TestCase):
    def test_keeps_amounts_years_and_percentages_only(self):
        self.assertEqual(numbers(["Rammen er 1 500 kroner i 2024, 12 % mer, jf. note 3."], None),
                         {"1500", "2024", "12%"})

    def test_drops_the_printed_page_number_at_the_edge_only(self):
        lines = ["Tabell", "Post 21 driftsutgifter", "Side 120", "500"]
        self.assertEqual(numbers(lines, 120), {"500"})
        self.assertEqual(numbers(lines, None), {"120", "500"})

    def test_page_number_offset_follows_the_sequence(self):
        pages = [["Tekst", str(i + 3)] for i in range(10)]
        self.assertEqual(page_number_offset(pages), 2)
        self.assertIsNone(page_number_offset([["Tekst", "500"]] * 10))


class Boilerplate(unittest.TestCase):
    def test_strips_running_headers_at_the_edges_but_not_lone_numbers(self):
        pages = [f"Prop. 28 LS\n2025–2026\nTekst {'abcdef'[i]}\n{i}" for i in range(6)]
        share, rep = boilerplate(pages)
        self.assertEqual(share, 1.0)
        self.assertNotIn("#", rep)
        self.assertEqual(strip_lines(pages[0], rep), "Tekst a\n0")

    def test_leaves_a_repeated_line_in_the_middle_of_a_page(self):
        rep = {"prop. # ls"}
        body = "a\nb\nc\nd\nProp. 28 LS\ne\nf\ng\nh"
        self.assertIn("Prop. 28 LS", strip_lines(body, rep))


class Words(unittest.TestCase):
    def test_counts_split_words_and_letter_spaced_runs(self):
        lex = {"ekspertise": True, "bygget": True, "eksper": False, "tise": False}
        glued, spaced, split, total = glued_spaced("eksper tise bygget S A M L E T", lex)
        self.assertEqual((glued, spaced, split), (0, 1, 1))
        self.assertEqual(total, 9)

    def test_duplicates_ignore_table_of_contents_leaders(self):
        line = "Innledning ......................................... 5"
        self.assertEqual(duplicates([line, line]), 0)
        sentence = "Arbeidsgiver skal gi skriftlige opplysninger innen rimelig tid."
        self.assertEqual(duplicates([sentence, sentence]), 1)

    def test_5gram_overlap_survives_a_moved_block(self):
        a = [f"ord{i}" for i in range(40)]
        b = a[20:] + a[:20]
        self.assertGreater(shingle_f1(a, b), 0.85)
        self.assertLess(shingle_f1(a, list(reversed(a))), 0.1)


if __name__ == "__main__":
    unittest.main()
