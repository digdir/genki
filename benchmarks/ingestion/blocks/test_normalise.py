"""Tests for normalise.py on small hand-made native outputs.  python3 -m unittest test_normalise"""
import unittest

from normalise import docling_blocks, finish, html_text, marker_blocks, markdown_table, mineru_blocks


class Finish(unittest.TestCase):
    def blocks(self, *raw):
        return finish([{"page": 1, "bbox": None, "level": None, "html": None, "native": "x", **r} for r in raw], {}, "1", "p")

    def test_every_offset_points_at_its_text_in_text_md(self):
        blocks, text, _ = self.blocks({"kind": "title", "text": "Tittel", "level": 0},
                                      {"kind": "paragraph", "text": "Første avsnitt."},
                                      {"kind": "list_item", "text": "punkt"})
        for b in blocks:
            self.assertEqual(text[b["start"]:b["end"]], b["text"])
        self.assertEqual(text, "# Tittel\n\nFørste avsnitt.\n\n- punkt")

    def test_page_furniture_is_kept_but_left_out_of_the_text(self):
        blocks, text, _ = self.blocks({"kind": "page_footer", "text": "Side 1"}, {"kind": "paragraph", "text": "Tekst"})
        self.assertTrue(blocks[0]["furniture"])
        self.assertIsNone(blocks[0]["start"])
        self.assertEqual(text, "Tekst")

    def test_a_heading_closes_headings_at_its_level_and_below(self):
        blocks, _, _ = self.blocks({"kind": "heading", "text": "A", "level": 1},
                                   {"kind": "heading", "text": "A.1", "level": 2},
                                   {"kind": "paragraph", "text": "under A.1"},
                                   {"kind": "heading", "text": "B", "level": 1},
                                   {"kind": "paragraph", "text": "under B"})
        self.assertEqual(blocks[1]["heading_path"], ["A"])
        self.assertEqual(blocks[2]["heading_path"], ["A", "A.1"])
        self.assertEqual(blocks[3]["heading_path"], [])
        self.assertEqual(blocks[4]["heading_path"], ["B"])

    def test_pages_give_the_span_of_text_their_blocks_cover(self):
        raw = [{"page": 1, "kind": "paragraph", "text": "en"}, {"page": 2, "kind": "paragraph", "text": "to"}]
        _, text, pages = finish([{"bbox": None, "level": None, "html": None, "native": "x", **r} for r in raw],
                                {1: {"width_pt": 100, "height_pt": 200}}, "1", "p")
        self.assertEqual(text[pages[1]["start"]:pages[1]["end"]], "to")
        self.assertEqual(pages[0]["width_pt"], 100)


class Docling(unittest.TestCase):
    def test_a_bottom_left_box_becomes_fractions_from_the_top_left(self):
        d = {"pages": {"1": {"size": {"width": 200, "height": 100}, "page_no": 1}},
             "body": {"self_ref": "#/body", "children": [{"$ref": "#/texts/0"}]}, "groups": [], "tables": [],
             "pictures": [], "texts": [{"self_ref": "#/texts/0", "label": "section_header", "level": 1, "text": "Hode",
                                        "children": [], "prov": [{"page_no": 1, "bbox": {"l": 20, "t": 90, "r": 100, "b": 80,
                                                                                         "coord_origin": "BOTTOMLEFT"}}]}]}
        raw, _ = docling_blocks(d)
        self.assertEqual(raw[0]["bbox"], [0.1, 0.1, 0.5, 0.2])
        self.assertEqual((raw[0]["kind"], raw[0]["level"]), ("heading", 1))

    def test_list_groups_are_walked_in_order(self):
        d = {"pages": {}, "body": {"self_ref": "#/body", "children": [{"$ref": "#/groups/0"}]}, "tables": [], "pictures": [],
             "groups": [{"self_ref": "#/groups/0", "children": [{"$ref": "#/texts/0"}, {"$ref": "#/texts/1"}]}],
             "texts": [{"self_ref": f"#/texts/{i}", "label": "list_item", "text": t, "children": [], "prov": []}
                       for i, t in enumerate(["a", "b"])]}
        raw, _ = docling_blocks(d)
        self.assertEqual([r["text"] for r in raw], ["a", "b"])


class MinerU(unittest.TestCase):
    def test_a_table_group_gives_its_caption_and_the_table_from_html(self):
        m = {"pages": [{"page_idx": 0, "blocks": [{"type": "table", "bbox": [0.1, 0.1, 0.9, 0.5], "content": [
            {"type": "table_caption", "bbox": [0.1, 0.05, 0.5, 0.09], "content": [{"type": "text", "content": "Tabell 1"}]},
            {"type": "table_body", "bbox": [0.1, 0.1, 0.9, 0.5],
             "content": "<table><tr><td>Kap.</td><td>Beløp</td></tr><tr><td>323</td><td>92 035 000</td></tr></table>"}]}]}]}
        raw, _ = mineru_blocks(m)
        self.assertEqual([r["kind"] for r in raw], ["caption", "table"])
        self.assertEqual(raw[1]["text"], "| Kap. | Beløp |\n| --- | --- |\n| 323 | 92 035 000 |")
        self.assertEqual(raw[0]["page"], 1)

    def test_paragraph_titles_keep_their_level(self):
        m = {"pages": [{"page_idx": 2, "blocks": [{"type": "paragraph_title", "level": 2, "bbox": [0, 0, 1, 0.1],
                                                    "content": [{"type": "text", "content": "1 Innledning"}]}]}]}
        raw, _ = mineru_blocks(m)
        self.assertEqual((raw[0]["kind"], raw[0]["level"], raw[0]["page"]), ("heading", 2, 3))


class Marker(unittest.TestCase):
    def test_headings_take_their_level_from_the_html_and_boxes_the_page_size(self):
        d = {"children": [{"id": "/page/0/Page/1", "bbox": [0, 0, 200, 100], "children": [
            {"block_type": "SectionHeader", "bbox": [20, 10, 100, 20], "html": "<h3><b>Utgifter</b></h3>"},
            {"block_type": "ListGroup", "bbox": [0, 0, 1, 1], "html": "", "children": [
                {"block_type": "ListItem", "bbox": [20, 30, 100, 40], "html": "<li>punkt</li>"}]}]}]}
        raw, sizes = marker_blocks(d)
        self.assertEqual((raw[0]["kind"], raw[0]["level"], raw[0]["text"]), ("heading", 3, "Utgifter"))
        self.assertEqual(raw[0]["bbox"], [0.1, 0.1, 0.5, 0.2])
        self.assertEqual((raw[1]["kind"], raw[1]["text"]), ("list_item", "punkt"))
        self.assertEqual(sizes[1], {"width_pt": 200, "height_pt": 100})


class Html(unittest.TestCase):
    def test_colspan_repeats_the_cell_and_br_becomes_a_space(self):
        _, rows = html_text("<table><tr><th colspan=2>Tildeling<br>2022</th></tr><tr><td>a</td><td>b</td></tr></table>")
        self.assertEqual(rows, [["Tildeling 2022", "Tildeling 2022"], ["a", "b"]])

    def test_a_pipe_in_a_cell_is_escaped(self):
        self.assertEqual(markdown_table([["a|b"], ["c"]]), "| a\\|b |\n| --- |\n| c |")


if __name__ == "__main__":
    unittest.main()
