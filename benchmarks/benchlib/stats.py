"""Paired comparisons: the bootstrap, decisions against a margin, and tiers.

Every side is scored on the same clusters (usually documents). Each replicate draws whole clusters with
replacement, within strata when given, and scores every side on that same draw, so differences are
paired. The draws depend only on the seed, the label and the cluster ids: adding a side, adding a slice
or reordering comparisons never moves another interval. Percentiles interpolate linearly, as
packages/eval/src/stats.ts does. Draws use only random() and sums use math.fsum, so Python 3.9 and
3.13 give the same numbers.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from itertools import combinations
from typing import Callable, Dict, Hashable, Iterator, List, Mapping, Optional, Sequence, Tuple

REPS = 10_000
LEVEL = 0.95
UNDEFINED_LIMIT = 0.05
SMALL = 20
# Note: z for a two-sided 5% test plus z for 80% power
POWER_Z = 1.959963984540054 + 0.8416212335729143

Metric = Callable[[Sequence[object], str], Optional[float]]


def percentile(sorted_values: Sequence[float], q: float) -> float:
    if not sorted_values:
        raise ValueError("percentile of no values")
    position = (len(sorted_values) - 1) * q
    low, high = math.floor(position), math.ceil(position)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (position - low)


def mean(values) -> float:
    values = list(values)
    if not values:
        raise ValueError("mean of no values")
    return math.fsum(values) / len(values)


def group(rows, key) -> Dict[Hashable, list]:
    """Rows by cluster, each cluster's rows in their given order."""
    out: Dict[Hashable, list] = {}
    for r in rows:
        out.setdefault(key(r), []).append(r)
    return out


def pair_items(runs: Mapping[str, Mapping[Hashable, object]]) -> List[Hashable]:
    """The item ids every side was graded on, sorted; refuses sides graded on different items."""
    sets = {side: set(items) for side, items in runs.items()}
    first_side, first = next(iter(sets.items()))
    for side, items in sets.items():
        if items != first:
            raise ValueError(f"{side} and {first_side} were graded on different items "
                             f"({len(items ^ first)} differ)")
    return sorted(first, key=str)


def draws(cluster_ids, *, seed, label: str, reps: int,
          strata: Optional[Mapping[Hashable, Hashable]] = None) -> Iterator[List[Hashable]]:
    """reps lists of cluster ids drawn with replacement; with strata, within each stratum at its size."""
    rng = random.Random(f"{seed}:{label}")
    ids = sorted(cluster_ids, key=str)
    if strata is None:
        groups = [ids]
    else:
        by: Dict[Hashable, list] = {}
        for c in ids:
            by.setdefault(strata[c], []).append(c)
        groups = [by[k] for k in sorted(by, key=str)]
    for _ in range(reps):
        drawn: List[Hashable] = []
        for g in groups:
            n = len(g)
            drawn.extend(g[int(rng.random() * n)] for _ in range(n))
        yield drawn


@dataclass(frozen=True)
class Difference:
    a: str
    b: str
    point: float
    low: float
    high: float
    p: float
    se: float
    used: int
    undefined: int

    @property
    def unreliable(self) -> bool:
        return self.undefined > UNDEFINED_LIMIT * (self.used + self.undefined)

    @property
    def significant(self) -> bool:
        return not self.unreliable and (self.low > 0 or self.high < 0)

    @property
    def detectable(self) -> float:
        """The smallest difference this sample detects with 80% power at the 5% level."""
        return POWER_Z * self.se


@dataclass
class Comparison:
    label: str
    sides: Tuple[str, ...]
    scores: Dict[str, Optional[float]]
    intervals: Dict[str, Tuple[float, float]]
    clusters: int
    reps: int
    level: float
    replicates: Dict[str, List[Optional[float]]] = field(repr=False)

    @property
    def small(self) -> bool:
        return self.clusters < SMALL

    def diff(self, a: str, b: str) -> Difference:
        """a minus b, over the replicates where both are defined."""
        sa, sb = self.scores[a], self.scores[b]
        if sa is None or sb is None:
            raise ValueError(f"{self.label}: no score for {a if sa is None else b}")
        pairs = list(zip(self.replicates[a], self.replicates[b]))
        diffs = sorted(x - y for x, y in pairs if x is not None and y is not None)
        undefined = len(pairs) - len(diffs)
        if not diffs:
            raise ValueError(f"{self.label}: {a} and {b} are never both defined")
        tail = (1 - self.level) / 2
        below = sum(1 for d in diffs if d <= 0)
        above = sum(1 for d in diffs if d >= 0)
        p = min(1.0, 2 * (min(below, above) + 1) / (len(diffs) + 1))
        m = mean(diffs)
        se = math.sqrt(math.fsum((d - m) ** 2 for d in diffs) / max(1, len(diffs) - 1))
        return Difference(a, b, sa - sb, percentile(diffs, tail), percentile(diffs, 1 - tail), p, se,
                          len(diffs), undefined)

    def pairs(self) -> List[Difference]:
        return [self.diff(a, b) for a, b in combinations(self.sides, 2)]


def compare(units: Mapping[Hashable, object], sides: Sequence[str], metric: Metric, *, seed,
            label: str, strata: Optional[Mapping[Hashable, Hashable]] = None, reps: int = REPS,
            level: float = LEVEL) -> Comparison:
    """Scores every side on all clusters and on reps resamples of them.

    units maps a cluster id to whatever the metric needs from it (its rows, or totals per side);
    metric(units, side) returns the side's score, or None when a resample leaves it undefined."""
    ids = sorted(units, key=str)
    scores = {s: metric([units[c] for c in ids], s) for s in sides}
    replicates: Dict[str, List[Optional[float]]] = {s: [] for s in sides}
    for drawn in draws(ids, seed=seed, label=label, reps=reps, strata=strata):
        sample = [units[c] for c in drawn]
        for s in sides:
            replicates[s].append(metric(sample, s))
    tail = (1 - level) / 2
    intervals = {}
    for s in sides:
        values = sorted(v for v in replicates[s] if v is not None)
        intervals[s] = (percentile(values, tail), percentile(values, 1 - tail)) if values else (math.nan, math.nan)
    return Comparison(label, tuple(sides), scores, intervals, len(ids), reps, level, replicates)


def decide(d: Difference, max_regression: float) -> str:
    """The verdict on a candidate (a) against current (b), with the margin set before the run.

    Stricter than a service's no-regression gate: "not worse" has to be shown by the whole interval."""
    if d.unreliable:
        return "unreliable"
    if d.low > 0:
        return "better"
    if d.high < -max_regression:
        return "worse"
    if d.low > -max_regression:
        return "not worse"
    return "inconclusive"


def holm(pvalues: Mapping[Hashable, float]) -> Dict[Hashable, float]:
    """Holm-adjusted p-values: the i-th smallest times (m - i), never below the one before."""
    order = sorted(pvalues, key=lambda k: (pvalues[k], str(k)))
    m = len(order)
    out: Dict[Hashable, float] = {}
    running = 0.0
    for i, k in enumerate(order):
        running = max(running, min(1.0, (m - i) * pvalues[k]))
        out[k] = running
    return out


def tiers(c: Comparison, alpha: float = 1 - LEVEL) -> List[List[str]]:
    """Sides by score; a side starts a new tier only when it is significantly worse than its tier's top
    side, after Holm correction over every pair."""
    order = sorted((s for s in c.sides if c.scores[s] is not None),
                   key=lambda s: (-(c.scores[s] or 0.0), c.sides.index(s)))
    if not order:
        return []
    diffs = {(a, b): c.diff(a, b) for a, b in combinations(order, 2)}
    adjusted = holm({k: d.p for k, d in diffs.items()})
    out = [[order[0]]]
    for s in order[1:]:
        top = out[-1][0]
        d = diffs[(top, s)]
        if adjusted[(top, s)] < alpha and d.low > 0 and not d.unreliable:
            out.append([s])
        else:
            out[-1].append(s)
    return out


def latency(values: Sequence[float]) -> Dict[str, float]:
    if not values:
        raise ValueError("latency of no values")
    v = sorted(values)
    return {"n": len(v), "p50": percentile(v, 0.5), "p95": percentile(v, 0.95), "max": v[-1]}
