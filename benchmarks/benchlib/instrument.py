"""Checks on the instrument itself, before its verdicts are trusted.

null_runs is an A/A check: it swaps two sides' results at random within each cluster, so there is no
real difference, and counts how often the interval still leaves out zero. About 5% is right; much
more means the intervals are too narrow (often because clustered items were treated as independent).
damage fails a chosen share of one side's items, to see that the benchmark notices a known loss.
Both draw only with random(), so they give the same result on every Python version.
"""
from __future__ import annotations

import random
from typing import Callable, Dict, Hashable, List, Mapping, Sequence

from benchlib.stats import LEVEL, Metric, compare


def swap(unit: Mapping[str, object], a: str, b: str) -> Dict[str, object]:
    out = dict(unit)
    out[a], out[b] = unit[b], unit[a]
    return out


def null_runs(units: Mapping[Hashable, Mapping[str, object]], a: str, b: str, metric: Metric, *, seed,
              n: int = 1000, reps: int = 1000, level: float = LEVEL) -> float:
    """The share of n null comparisons whose interval leaves out zero."""
    ids = sorted(units, key=str)
    hits = 0
    for i in range(n):
        rng = random.Random(f"{seed}:null:{i}")
        shuffled = {c: (swap(units[c], a, b) if rng.random() < 0.5 else units[c]) for c in ids}
        d = compare(shuffled, (a, b), metric, seed=seed, label=f"null:{i}", reps=reps, level=level).diff(a, b)
        hits += d.low > 0 or d.high < 0
    return hits / n


def choose(keys: Sequence[Hashable], share: float, *, seed, label: str = "damage") -> List[Hashable]:
    """round(share * len(keys)) keys, chosen with random() alone."""
    rng = random.Random(f"{seed}:{label}")
    ordered = sorted(keys, key=str)
    ranked = sorted(ordered, key=lambda k: rng.random())
    return sorted(ranked[:round(share * len(ordered))], key=str)


def damage(rows: Sequence[dict], share: float, *, seed, key: Callable[[dict], Hashable],
           fail: Callable[[dict], dict]) -> List[dict]:
    """A copy of rows where every row of a chosen share of keys (pages, say) is replaced by fail(row)."""
    chosen = set(choose(sorted({key(r) for r in rows}, key=str), share, seed=seed))
    return [fail(dict(r)) if key(r) in chosen else r for r in rows]
