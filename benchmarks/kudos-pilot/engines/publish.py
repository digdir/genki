"""Publish each side's verdicts and run record to results/, from the run files in results/runs/
(kudos-pilot-compare.ts `verdicts`: each draft question's document scores averaged over its three rounds, as
served and with Typesense credited for every pilot document that holds a returned chunk).

    publish.py   # then report.py

results/sides/<side>/verdicts.jsonl   one line per question: document scores as served and credited, latencies
results/sides/<side>/record.json      what the run used: commit, code, reference and items hashes, the service
"""
import json
import shutil
import subprocess

from common_engines import BENCHMARK, DATA, PILOT, PUBLISHED, QUESTIONS, REFERENCE, REPO, RUNS, SIDES, questions
from benchlib import record, tables

COMPARE = REPO / "packages" / "eval" / "src" / "scripts" / "kudos-pilot-compare.ts"
CODE = [COMPARE, PILOT / "copy_typesense.py", PILOT / "run_ingest.py"]
SETTINGS = {
    "documents": 299, "rounds": 3, "reranker": "ColBERT",
    "service": "Kunnskapsassistenten's retrieve-only service (rag-single-shot, no answer), gpt-4o planner",
}
SERVICES = {
    "typesense": {"service": "kudos-pilot-typesense-retrieve-only",
                  "engine": "Typesense 30.1, local, holding only the pilot's documents, chunks and phrases",
                  "planner": "corpus-aware: looks up stored phrases, then rewords them (two model calls)"},
    "pgvector": {"service": "kudos-pilot-retrieve-only",
                 "engine": "pgvector 0.8.2: digdir/kudos-next, page passages, text-embedding-3-large at 1,536",
                 "planner": "blind: writes its searches in one model call"},
    "typesense-blind": {"service": "kudos-pilot-typesense-blind-retrieve-only",
                        "engine": "as typesense", "planner": "blind (planner.expansionMode: blind)"},
}
METRICS = {"Recall@10": "recall@10", "Recall@5": "recall@5", "MRR": "mrr", "nDCG@10": "ndcg@10"}


def main():
    items = {q["item"] for q in questions()}
    out = DATA / "engines-verdicts"
    if out.exists():
        shutil.rmtree(out)
    files = [str(f) for f in sorted(RUNS.glob("*.json"))]
    subprocess.run(["npx", "tsx", "--conditions=source", str(COMPARE), "verdicts", str(out), *files, ",".join(SIDES)],
                   cwd=REPO, check=True, capture_output=True, text=True)
    run_of = {s: f.name for f in sorted(RUNS.glob("*.json")) for r in json.loads(f.read_text())["rounds"] for s in r}
    for side in SIDES:
        lines = [json.loads(line) for line in (out / f"{side}.jsonl").read_text().splitlines() if line.strip()]
        if {v["item"] for v in lines} != items:
            raise SystemExit(f"{side}: graded on other questions than the reference")
        rows = []
        for v in lines:
            if v["served"] is None:
                raise SystemExit(f"{side}: {v['item']} failed in a round")
            rows.append({"item": v["item"], "rounds": v["rounds"], "latency_ms": v["latencyMs"],
                         "served": {METRICS[k]: x for k, x in v["served"].items()},
                         "credited": {METRICS[k]: x for k, x in v["credited"].items()}})
        target = PUBLISHED / "sides" / side
        tables.write_jsonl(target / "verdicts.jsonl", sorted(rows, key=lambda r: r["item"]))
        record.write(target / "record.json", record.make(
            BENCHMARK, root=REPO, code=CODE, reference=[REFERENCE], items=[QUESTIONS], side=side,
            side_settings={**SERVICES[side], "run": run_of[side]}, settings=SETTINGS))
    print(f"published {', '.join(SIDES)}")


if __name__ == "__main__":
    main()
