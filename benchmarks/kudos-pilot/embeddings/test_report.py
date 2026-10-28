import json
import shutil
import tempfile
import unittest
from pathlib import Path

import report
from benchlib import record
from common_embeddings import GENERATED, PUBLISHED, QUESTIONS, REFERENCE, SIDES, questions


def records():
    return {s: record.read(PUBLISHED / "sides" / s / "record.json") for s in SIDES
            if (PUBLISHED / "sides" / s / "record.json").exists()}


class Report(unittest.TestCase):
    def test_refuses_verdicts_graded_on_an_older_reference(self):
        report.require_current(records())
        reference = Path(tempfile.mkdtemp()) / "reference"
        shutil.copytree(REFERENCE, reference)
        changed = reference / QUESTIONS.name
        changed.write_text("".join(changed.read_text().splitlines(keepends=True)[1:]))
        with self.assertRaises(record.Incomparable):
            report.require_current(records(), questions_file=changed, reference=reference)

    def test_every_side_is_graded_on_every_question_of_each_view(self):
        sides, _, verdicts = report.load()
        items = {q["item"] for q in questions()}
        draft = {q["item"] for q in questions() if q["set"] == "draft"}
        for s in sides:
            for view in ("vectors", "search"):
                self.assertEqual(set(verdicts[s][view]), items, f"{s} {view}")
            for view in report.STEP_VIEWS:
                if verdicts[s][view]:
                    self.assertEqual(set(verdicts[s][view]), items, f"{s} {view}")
            if verdicts[s]["full"]:
                self.assertEqual(set(verdicts[s]["full"]), draft, f"{s} full")

    def test_no_reference_question_comes_from_a_side(self):
        generated = json.loads(GENERATED.read_text())
        self.assertTrue(generated["model"].startswith("gpt-4o"))
        self.assertEqual({q["set"] for q in questions()}, {"generated", "draft"})


if __name__ == "__main__":
    unittest.main()
