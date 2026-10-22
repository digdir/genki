"""Paths, settings and HTTP shared by the benchmark scripts."""
import os
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DATA = Path(os.environ.get("INGESTION_BENCHMARK_DATA", HERE / ".data"))
RESULTS = DATA / "results"
SAMPLE = HERE / "sample.json"
CHECKS = ["coverage", "similarity", "noise", "numbers", "language", "unicode", "glued_spaced", "duplicated"]

KUDOS_API = "https://kudos.dfo.no/api/v0/documents"
TS_DOCUMENTS = "KUDOS_preprod_v4_documents_ab897fbdedfa"
TS_CHUNKS = "KUDOS_preprod_v4_chunks_ab897fbdedfa"
DICTIONARIES = "https://raw.githubusercontent.com/LibreOffice/dictionaries/32b006a2c22a4ac7e8ed3f03346f7b3d85a970a4/no"


def setting(name):
    """From the environment, else from .env.local in the repo root, where the last assignment
    wins as it does when a shell sources the file. Never printed."""
    if os.environ.get(name):
        return os.environ[name]
    value = ""
    env = REPO / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            key, sep, rest = line.partition("=")
            if sep and key.strip() == name:
                value = rest.strip().strip("'\"")
    if not value:
        raise SystemExit(f"{name} is not set (environment or .env.local)")
    return value


def get(url, headers=None, waits=(0, 2, 10, 30, 60)):
    """GET with retries on any error; raises the last one."""
    for wait in waits:
        time.sleep(wait)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=300) as r:
                return r.read()
        except Exception as e:
            err = e
            print(f"  retry {url[:90]}: {e}")
    raise err
