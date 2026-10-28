"""Paths and sides of the search-engine benchmark, on top of the Kudos pilot's own (../common.py)."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent))

from common import DATA, REPO, SAMPLE, TESTSET  # noqa: E402

BENCHMARK = "kudos-pilot/engines"
PILOT = HERE.parent
CURRENT, CANDIDATE = "typesense", "pgvector"
# The sides, as kudos-pilot-compare.ts names them in its run files
SIDES = (CURRENT, CANDIDATE, "typesense-blind")
NAMES = {"typesense": "Typesense", "pgvector": "pgvector", "typesense-blind": "Typesense, phrase step off"}
# The reference (committed): the draft questions with the documents that answer them
REFERENCE = HERE / "reference"
QUESTIONS = REFERENCE / "questions.jsonl"
# What the scripts publish (committed): the runs, verdicts and run record per side, the report
PUBLISHED = HERE / "results"
RUNS = PUBLISHED / "runs"


def questions():
    return [json.loads(line) for line in QUESTIONS.read_text().splitlines() if line.strip()]
