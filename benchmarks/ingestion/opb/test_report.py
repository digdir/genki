import json
import shutil
import tempfile
import unittest
from pathlib import Path

import report
from benchlib import record
from common_opb import PAGES, PUBLISHED, SIDES, TESTS


def records():
    return {s: record.read(PUBLISHED / "sides" / s / "record.json") for s in SIDES}


class Report(unittest.TestCase):
    def test_refuses_verdicts_graded_on_an_older_reference(self):
        report.require_current(records())
        tests = Path(tempfile.mkdtemp()) / "tests"
        shutil.copytree(TESTS, tests)
        changed = sorted(tests.glob("*.json"))[0]
        doc = json.loads(changed.read_text())
        doc["tests"] = doc["tests"][1:]
        changed.write_text(json.dumps(doc))
        with self.assertRaises(record.Incomparable):
            report.require_current(records(), tests=tests, pages=PAGES)

    def test_no_reference_test_is_derived_from_a_side_output(self):
        derivations = {t["derivation"] for f in TESTS.glob("*.json") for t in json.loads(f.read_text())["tests"]}
        self.assertLessEqual(derivations, {"model_panel", "model_review"})


if __name__ == "__main__":
    unittest.main()
