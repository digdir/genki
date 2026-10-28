import shutil
import tempfile
import unittest
from pathlib import Path

import report
from benchlib import record
from common_engines import PUBLISHED, QUESTIONS, REFERENCE, SIDES, questions


def records():
    return {s: record.read(PUBLISHED / "sides" / s / "record.json") for s in SIDES}


class Report(unittest.TestCase):
    def test_refuses_verdicts_graded_on_an_older_reference(self):
        report.require_current(records())
        reference = Path(tempfile.mkdtemp()) / "reference"
        shutil.copytree(REFERENCE, reference)
        changed = reference / QUESTIONS.name
        changed.write_text("".join(changed.read_text().splitlines(keepends=True)[1:]))
        with self.assertRaises(record.Incomparable):
            report.require_current(records(), questions_file=changed, reference=reference)

    def test_every_side_is_graded_on_every_question(self):
        _, verdicts = report.load()
        items = {q["item"] for q in questions()}
        for s in SIDES:
            self.assertEqual(set(verdicts[s]), items, s)


if __name__ == "__main__":
    unittest.main()
