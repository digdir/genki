"""Paths of the index benchmark, on top of the Kudos pilot's own (../common.py)."""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent))

from common import DATA  # noqa: E402

BENCHMARK = "kudos-pilot/indexes"
# What the scripts publish (committed): one line per measurement, and the report built from them
PUBLISHED = HERE / "results"
MEASUREMENTS = PUBLISHED / "measurements.jsonl"
