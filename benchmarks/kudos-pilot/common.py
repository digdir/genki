"""Paths and HTTP shared by the pilot scripts; puts benchmarks/ on sys.path for benchlib."""
import os
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE.parent))
DATA = Path(os.environ.get("KUDOS_PILOT_DATA", HERE / ".data"))
SAMPLE = HERE / "sample.json"
TESTSET = REPO / "packages" / "eval" / "testsets" / "ka-kudos-draft.yaml"
# The ingestion benchmark's sample.json and its .data (KUDOS listing, Typesense records, PDFs)
INGESTION = Path(os.environ.get("INGESTION_BENCHMARK_DIR", REPO / "benchmarks" / "ingestion"))
INGESTION_DATA = Path(os.environ.get("INGESTION_BENCHMARK_DATA", INGESTION / ".data"))
# genki's search without the planner taken apart, one step at a time, to find which step loses the pages the vectors
# alone find: setup_models.py writes a service per step and score_search.py --step runs it, for these pilot keys
SEARCH_STEPS = ("vector", "vector-colbert", "fusion", "fusion-colbert", "nocolbert")
STEP_KEYS = ("baseline", "pplx-0-6b")


def get(url, waits=(0, 2, 10, 30, 60)):
    """GET with retries on any error; raises the last one."""
    for wait in waits:
        time.sleep(wait)
        try:
            with urllib.request.urlopen(url, timeout=600) as r:
                return r.read()
        except Exception as e:
            err = e
            print(f"  retry {url[:90]}: {e}")
    raise err
