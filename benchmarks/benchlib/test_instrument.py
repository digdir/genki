import unittest

from benchlib import instrument


def rate(units, side):
    passed = sum(u[side][0] for u in units)
    total = sum(u[side][1] for u in units)
    return passed / total if total else None


class Instrument(unittest.TestCase):
    def test_null_runs_swap_sides_within_a_cluster_only(self):
        unit = {"a": [1, 2], "b": [2, 2], "c": [0, 2]}
        swapped = instrument.swap(unit, "a", "b")
        self.assertEqual(swapped, {"a": [2, 2], "b": [1, 2], "c": [0, 2]})
        self.assertEqual(unit["a"], [1, 2])

    def test_null_runs_leave_out_zero_about_five_percent_of_the_time(self):
        units = {f"d{i}": {"a": [i % 3, 3], "b": [(i + 1) % 3, 3]} for i in range(60)}
        share = instrument.null_runs(units, "a", "b", rate, seed=3, n=200, reps=400)
        self.assertLess(share, 0.12)

    def test_damage_fails_exactly_the_chosen_share_of_clusters(self):
        rows = [{"page": p, "ok": True} for p in range(100) for _ in range(3)]
        out = instrument.damage(rows, 0.05, seed=1, key=lambda r: r["page"], fail=lambda r: {**r, "ok": False})
        failed_pages = {r["page"] for r in out if not r["ok"]}
        self.assertEqual(len(failed_pages), 5)
        self.assertTrue(all(not r["ok"] for r in out if r["page"] in failed_pages))
        self.assertTrue(all(r["ok"] for r in rows))

    def test_damage_chooses_the_same_keys_for_the_same_seed(self):
        keys = list(range(50))
        self.assertEqual(instrument.choose(keys, 0.1, seed=4), instrument.choose(list(reversed(keys)), 0.1, seed=4))


if __name__ == "__main__":
    unittest.main()
