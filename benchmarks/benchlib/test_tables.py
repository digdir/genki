import json
import tempfile
import unittest
from pathlib import Path

from benchlib import stats, tables


class Tables(unittest.TestCase):
    def test_never_emits_an_em_dash(self):
        with self.assertRaises(ValueError):
            tables.table(["a"], [["x — y"]])
        with self.assertRaises(ValueError):
            tables.write_json(Path(tempfile.mkdtemp()) / "x.json", {"a": "x — y"})

    def test_never_shows_negative_zero(self):
        self.assertEqual(tables.number(-0.0001), "0.0")
        self.assertEqual(tables.signed(-0.0001), "0.0")
        self.assertEqual(tables.signed(-0.013), "−1.3")
        self.assertEqual(tables.signed(0.013), "+1.3")

    def test_difference_cell_shows_interval_and_verdict(self):
        d = stats.Difference("a", "b", 0.072, 0.03, 0.118, 0.001, 0.02, 1000, 0)
        self.assertEqual(tables.diff_cell(d, "better"), "+7.2 ✱ (+3.0 to +11.8), better")
        level = stats.Difference("a", "b", 0.012, -0.013, 0.04, 0.4, 0.02, 1000, 0)
        self.assertEqual(tables.diff_cell(level), "+1.2 (−1.3 to +4.0)")

    def test_notes_say_time_and_cost_are_not_part_of_the_ranking(self):
        self.assertIn("not part of the ranking", tables.notes(["4 seconds a page"]))

    def test_json_is_written_with_two_space_indent_and_newline(self):
        path = Path(tempfile.mkdtemp()) / "x.json"
        tables.write_json(path, {"b": 1, "a": [1, 2]})
        text = path.read_text()
        self.assertTrue(text.endswith("}\n"))
        self.assertEqual(text, json.dumps({"a": [1, 2], "b": 1}, indent=2) + "\n")


if __name__ == "__main__":
    unittest.main()
