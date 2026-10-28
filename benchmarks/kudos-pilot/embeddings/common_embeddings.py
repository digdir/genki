"""Paths and sides of the embedding-model benchmark, on top of the Kudos pilot's own (../common.py)."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent))

from common import DATA, REPO, SAMPLE, TESTSET  # noqa: E402

BENCHMARK = "kudos-pilot/embeddings"
PILOT = HERE.parent
MODELS = json.loads((PILOT / "models.json").read_text())["models"]
# The current side: text-embedding-3-large shortened to 1,536 dimensions, as Kudos on pgvector stores it. The pilot's
# scripts call it `baseline` (score_vectors.py, score_search.py) and `pgvector` (kudos-pilot-compare.ts)
CURRENT = "te3-large"
SIDES = (CURRENT, *(m["key"] for m in MODELS))
# The reference (committed): every question with its right page or documents, and the questions gpt-4o wrote
REFERENCE = HERE / "reference"
QUESTIONS = REFERENCE / "questions.jsonl"
GENERATED = REFERENCE / "generated-questions.json"
# What the scripts publish (committed): verdicts and run record per side, the full-search runs, the report
PUBLISHED = HERE / "results"
RUNS = PUBLISHED / "runs"


def model(side):
    return next((m for m in MODELS if m["key"] == side), None)


def name(side):
    """The side as the report names it: the model without its organisation, with its length when shortened."""
    if side == CURRENT:
        return "text-embedding-3-large"
    m = model(side)
    base = m["hf"].split("/")[-1]
    return f"{base} @{m['dimensions']:,}" if m.get("shortenedFrom") else base


def dimensions(side):
    return 1536 if side == CURRENT else model(side)["dimensions"]


def pilot_key(side):
    """The side's key in the pilot's own result files (.data/vectors-<key>.json, search-<key>.json)."""
    return "baseline" if side == CURRENT else side


def compare_side(side):
    """The side's name in kudos-pilot-compare.ts's run files."""
    return "pgvector" if side == CURRENT else side


def questions():
    return [json.loads(line) for line in QUESTIONS.read_text().splitlines() if line.strip()]
