import os
import tempfile
import time
import unittest
from pathlib import Path

from benchlib import record


def made(tmp: Path, folder: Path, **overrides) -> dict:
    args = dict(root=tmp, code=[folder], reference=[folder], items=[folder], side="s",
                side_settings={}, settings={"margin": 0.02})
    args.update(overrides)
    return record.make("test", **args)


class Record(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.ref = self.tmp / "reference"
        (self.ref / "tests").mkdir(parents=True)
        (self.ref / "tests" / "p1.json").write_text('{"tests": []}\n')

    def test_reference_hash_changes_when_a_file_changes_or_is_renamed(self):
        before = record.tree_hash(self.ref)
        (self.ref / "tests" / "p1.json").write_text('{"tests": [1]}\n')
        changed = record.tree_hash(self.ref)
        (self.ref / "tests" / "p1.json").rename(self.ref / "tests" / "p2.json")
        renamed = record.tree_hash(self.ref)
        self.assertEqual(len({before, changed, renamed}), 3)

    def test_reference_hash_ignores_modification_times(self):
        before = record.tree_hash(self.ref)
        later = time.time() + 3600
        os.utime(self.ref / "tests" / "p1.json", (later, later))
        self.assertEqual(record.tree_hash(self.ref), before)

    def test_refuses_to_compare_records_with_different_references(self):
        a = made(self.tmp, self.ref)
        (self.ref / "tests" / "p1.json").write_text('{"tests": [2]}\n')
        b = made(self.tmp, self.ref)
        with self.assertRaises(record.Incomparable):
            record.require_comparable({"a": a, "b": b})

    def test_allows_a_difference_only_when_it_is_named(self):
        a = made(self.tmp, self.ref)
        b = made(self.tmp, self.ref, settings={"margin": 0.03})
        with self.assertRaises(record.Incomparable):
            record.require_comparable({"a": a, "b": b})
        record.require_comparable({"a": a, "b": b}, allow=("settings",))

    def test_refuses_a_record_without_a_reference_hash(self):
        a = made(self.tmp, self.ref)
        with self.assertRaises(record.Incomparable):
            record.require_comparable({"a": a, "b": {**a, "reference": None}})

    def test_records_commit_dirty_state_python_and_package_versions(self):
        here = Path(__file__).resolve().parent
        r = made(self.tmp, self.ref, root=here, packages=["pip", "no-such-package-xyz"])
        self.assertRegex(r["git"]["commit"] or "", r"^[0-9a-f]{40}$")
        self.assertIn(r["git"]["dirty"], (True, False))
        self.assertTrue(r["python"])
        self.assertIsNone(r["packages"]["no-such-package-xyz"])

    def test_a_run_without_a_reference_records_none_and_compares_with_nothing(self):
        a = made(self.tmp, self.ref, reference=None)
        self.assertIsNone(a["reference"])
        with self.assertRaises(record.Incomparable):
            record.require_comparable({"a": a, "b": a})

    def test_records_no_commit_outside_git(self):
        self.assertEqual(record.git(self.tmp), {"commit": None, "dirty": None})


if __name__ == "__main__":
    unittest.main()
