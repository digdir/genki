"""Paths and HTTP shared by the pilot scripts."""
import os
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DATA = Path(os.environ.get("KUDOS_PILOT_DATA", HERE / ".data"))
SAMPLE = HERE / "sample.json"
TESTSET = REPO / "packages" / "eval" / "testsets" / "ka-kudos-draft.yaml"
# The ingestion benchmark's sample.json and its .data (KUDOS listing, Typesense records, PDFs)
INGESTION = Path(os.environ.get("INGESTION_BENCHMARK_DIR", REPO / "benchmarks" / "ingestion"))
INGESTION_DATA = Path(os.environ.get("INGESTION_BENCHMARK_DATA", INGESTION / ".data"))


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
