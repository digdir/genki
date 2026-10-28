"""Paths and readers shared by the page-test scripts, on top of the ingestion benchmark's own."""
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent))

from common import DATA, RESULTS, SAMPLE  # noqa: E402

BENCHMARK = "ingestion/opb"
SIDES = ("marker", "kudos", "kudos-joined")
# The reference (committed): the pages, one test file per page, and how the tests were made and checked
REFERENCE = HERE / "reference"
PAGES = REFERENCE / "pages.json"
TESTS = REFERENCE / "tests"
REVIEW_LOG = REFERENCE / "review-log.jsonl"
CANARY = REFERENCE / "canary"
# What the scripts publish (committed): verdicts and run record per side, the report
PUBLISHED = HERE / "results"
OPB = DATA / "opb"
PNG = OPB / "png"
DATASET = OPB / "dataset"
RUNS = OPB / "runs"
# The pilot's Marker cache: one <sha256>.json per PDF, as the Marker service returns it
MARKER_CACHE = Path(os.environ.get(
    "MARKER_CACHE_DIR", HERE.parent.parent / "kudos-pilot" / ".data" / "marker-cache"))

# genki joins the service's pages with this separator (packages/ingest converter.ts) and splits the
# result on Marker's `{n}` marks, written before page n counted from 0 (chunk-document.ts)
MARKER_PAGE_SEPARATOR = "\n\n" + "-" * 48 + "\n\n"
MARKER_PAGE_MARK = re.compile(r"\{(\d+)\}\n+-{48}\n+")


def sample():
    return {s["doc_num"]: s for s in json.loads(SAMPLE.read_text())}


def pages():
    return json.loads(PAGES.read_text())


def pdf_path(doc_num):
    return DATA / "pdf" / f"{doc_num}.pdf"


def kudos_pages(uuid):
    """KUDOS's text for a document, split on its page breaks as genki would split it."""
    return (DATA / "kudos" / f"{uuid}.txt").read_text().split("\f")


def marker_pages(sha256):
    """Marker's markdown for each page of a file, split as genki's page chunker splits it."""
    path = MARKER_CACHE / f"{sha256}.json"
    if not path.exists():
        raise SystemExit(f"no Marker output for {sha256} in {MARKER_CACHE} (set MARKER_CACHE_DIR)")
    text = MARKER_PAGE_SEPARATOR.join(json.loads(path.read_text())["pages"])
    marks = list(MARKER_PAGE_MARK.finditer(text))
    out = [""] * len(marks)
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        out[int(m[1])] = text[m.end():end].strip()
    return out
