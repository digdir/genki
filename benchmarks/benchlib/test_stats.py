import unittest

from benchlib import stats


def rate(units, side):
    passed = sum(u[side][0] for u in units)
    total = sum(u[side][1] for u in units)
    return passed / total if total else None


UNITS = {f"d{i:02d}": {"a": [8 + (i % 3), 10], "b": [6 + (i % 4), 10], "c": [7, 10]} for i in range(30)}


class Stats(unittest.TestCase):
    def test_percentile_interpolates_linearly_like_stats_ts(self):
        self.assertEqual(stats.percentile([1, 2, 3, 4], 0.25), 1.75)
        self.assertEqual(stats.percentile([1, 2, 3, 4], 0.5), 2.5)

    def test_percentile_refuses_no_values(self):
        with self.assertRaises(ValueError):
            stats.percentile([], 0.5)

    def test_same_seed_and_label_give_the_same_interval(self):
        one = stats.compare(UNITS, ("a", "b"), rate, seed=7, label="x", reps=500).diff("a", "b")
        two = stats.compare(UNITS, ("a", "b"), rate, seed=7, label="x", reps=500).diff("a", "b")
        self.assertEqual(one, two)

    def test_known_values_match_on_python_3_9_and_3_13(self):
        d = stats.compare(UNITS, ("a", "b"), rate, seed=20261026, label="known", reps=1000).diff("a", "b")
        self.assertEqual(round(d.point, 12), round(0.15666666666666673, 12))
        self.assertEqual((round(d.low, 9), round(d.high, 9)), (0.109916667, 0.206666667))
        self.assertEqual(round(d.se, 12), 0.025044752737)

    def test_interval_does_not_depend_on_the_order_comparisons_run(self):
        first = stats.compare(UNITS, ("a", "b"), rate, seed=1, label="x", reps=300).diff("a", "b")
        stats.compare(UNITS, ("a", "c"), rate, seed=1, label="y", reps=300)
        again = stats.compare(UNITS, ("a", "b"), rate, seed=1, label="x", reps=300).diff("a", "b")
        self.assertEqual(first, again)

    def test_adding_a_side_leaves_existing_intervals_unchanged(self):
        two = stats.compare(UNITS, ("a", "b"), rate, seed=1, label="x", reps=300).diff("a", "b")
        three = stats.compare(UNITS, ("a", "b", "c"), rate, seed=1, label="x", reps=300).diff("a", "b")
        self.assertEqual(two, three)

    def test_interval_does_not_depend_on_the_order_of_clusters(self):
        reordered = dict(reversed(list(UNITS.items())))
        one = stats.compare(UNITS, ("a", "b"), rate, seed=1, label="x", reps=300).diff("a", "b")
        two = stats.compare(reordered, ("a", "b"), rate, seed=1, label="x", reps=300).diff("a", "b")
        self.assertEqual(one, two)

    def test_resamples_whole_clusters_never_part_of_one(self):
        seen = []

        def metric(units, side):
            seen.extend(units)
            return 0.0

        stats.compare(UNITS, ("a",), metric, seed=1, label="x", reps=20)
        self.assertTrue(all(any(u is v for v in UNITS.values()) for u in seen))

    def test_resamples_within_strata_keeping_each_stratum_size(self):
        strata = {c: ("s1" if i < 10 else "s2") for i, c in enumerate(sorted(UNITS))}
        for drawn in stats.draws(sorted(UNITS), seed=1, label="x", reps=50, strata=strata):
            self.assertEqual(sum(1 for c in drawn if strata[c] == "s1"), 10)
            self.assertEqual(sum(1 for c in drawn if strata[c] == "s2"), 20)

    def test_refuses_to_pair_sides_graded_on_different_items(self):
        with self.assertRaises(ValueError):
            stats.pair_items({"a": {"t1": 1, "t2": 1}, "b": {"t1": 1}})
        self.assertEqual(stats.pair_items({"a": {"t2": 1, "t1": 1}, "b": {"t1": 0, "t2": 0}}), ["t1", "t2"])

    def test_skips_and_counts_undefined_replicates(self):
        units = {"d1": {"a": [1, 1], "b": [0, 1]}, "d2": {"a": [0, 0], "b": [0, 0]}}
        d = stats.compare(units, ("a", "b"), rate, seed=1, label="x", reps=400).diff("a", "b")
        self.assertEqual(d.used + d.undefined, 400)
        self.assertGreater(d.undefined, 0)

    def test_marks_unreliable_over_5_percent_undefined(self):
        d = stats.Difference("a", "b", 0.1, 0.05, 0.15, 0.01, 0.02, used=90, undefined=10)
        self.assertTrue(d.unreliable)
        self.assertFalse(d.significant)
        self.assertFalse(stats.Difference("a", "b", 0.1, 0.05, 0.15, 0.01, 0.02, 96, 4).unreliable)

    def test_difference_is_significant_only_when_the_interval_leaves_out_zero(self):
        self.assertTrue(stats.Difference("a", "b", 0.1, 0.01, 0.2, 0.01, 0.05, 100, 0).significant)
        self.assertFalse(stats.Difference("a", "b", 0.1, -0.01, 0.2, 0.2, 0.05, 100, 0).significant)

    def test_not_worse_needs_the_whole_interval_above_minus_margin(self):
        d = lambda low, high: stats.Difference("a", "b", (low + high) / 2, low, high, 0.5, 0.01, 100, 0)
        self.assertEqual(stats.decide(d(0.01, 0.05), 0.02), "better")
        self.assertEqual(stats.decide(d(-0.015, 0.03), 0.02), "not worse")
        self.assertEqual(stats.decide(d(-0.03, 0.01), 0.02), "inconclusive")
        self.assertEqual(stats.decide(d(-0.08, -0.03), 0.02), "worse")

    def test_holm_multiplies_by_remaining_count_and_never_decreases(self):
        adjusted = stats.holm({"x": 0.01, "y": 0.04, "z": 0.03})
        self.assertAlmostEqual(adjusted["x"], 0.03)
        self.assertAlmostEqual(adjusted["z"], 0.06)
        self.assertAlmostEqual(adjusted["y"], 0.06)

    def test_tiers_split_only_where_holm_corrected_difference_is_significant(self):
        units = {f"d{i}": {"a": [9, 10], "b": [10, 10] if i % 2 else [8, 10], "c": [3, 10]} for i in range(40)}
        c = stats.compare(units, ("c", "b", "a"), rate, seed=1, label="x", reps=1000)
        self.assertEqual([sorted(t) for t in stats.tiers(c)], [["a", "b"], ["c"]])

    def test_tiers_keep_sides_together_when_no_difference_is_significant(self):
        units = {f"d{i}": {"a": [i % 2, 1], "b": [(i + 1) % 2, 1]} for i in range(10)}
        c = stats.compare(units, ("a", "b"), rate, seed=1, label="x", reps=500)
        self.assertEqual(len(stats.tiers(c)), 1)

    def test_latency_p50_of_an_even_count_interpolates(self):
        self.assertEqual(stats.latency([4, 1, 3, 2])["p50"], 2.5)


if __name__ == "__main__":
    unittest.main()
