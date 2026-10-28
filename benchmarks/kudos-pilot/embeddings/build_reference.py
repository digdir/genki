"""Write the reference: every question the embedding models are graded on, with its right documents (and, for
the generated questions, its right page), as the pilot's scoring reads them (score_vectors.questions).

    build_reference.py   # reference/questions.jsonl, and reference/generated-questions.json from .data

Each item also names its cluster (the document of its right page, or its first right document) and that
document's stratum in the pilot sample (test, benchmark or decoy), which report.py resamples by. No side's output
goes into it: gpt-4o wrote the generated questions from the page text, and the draft questions come from
Kunnskapsassistenten's test set.
"""
import json
import shutil

from common_embeddings import DATA, GENERATED, QUESTIONS, SAMPLE  # first: puts the pilot and benchmarks/ on the path
from benchlib import tables
from score_vectors import questions as pilot_questions


def main():
    if not GENERATED.exists():
        shutil.copyfile(DATA / "generated-questions.json", GENERATED)
    sample = json.loads(SAMPLE.read_text())["documents"]
    by_old = {d["old_id"]: d for d in sample if d["old_id"]}
    by_uuid = {d["uuid"]: d for d in sample}
    items, _ = pilot_questions()
    rows = []
    for q in items:
        doc = by_old.get(q["documents"][0]) or by_uuid.get(q["documents"][0])
        rows.append({
            "item": q["id"], "set": q["set"], "language": q.get("language"), "split": q.get("split"),
            "question": q["question"], "documents": q["documents"],
            "page": q["page"][1] if q.get("page") else None,
            "cluster": doc["uuid"] if doc else q["documents"][0],
            "stratum": doc["role"] if doc else "unknown",
            "title": doc["title"] if doc else None, "type": doc["type"] if doc else None,
        })
    tables.write_jsonl(QUESTIONS, sorted(rows, key=lambda r: r["item"]))
    sets = {s: sum(r["set"] == s for r in rows) for s in ("generated", "draft")}
    clusters = len({r["cluster"] for r in rows})
    print(f"wrote {QUESTIONS}: {sets['generated']} generated and {sets['draft']} draft questions, {clusters} documents")


if __name__ == "__main__":
    main()
