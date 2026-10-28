"""Write the reference: the 76 questions of Kunnskapsassistenten's draft test set that name the documents that
answer them, as kudos-pilot-compare.ts scores them (by old Typesense id), with each question's cluster (its first
document) for report.py's resampling.

    build_reference.py   # reference/questions.jsonl
"""
import json

from common_engines import QUESTIONS, SAMPLE  # first: puts the pilot and benchmarks/ on the path
from benchlib import tables
from score_vectors import questions as pilot_questions


def main():
    by_old = {d["old_id"]: d for d in json.loads(SAMPLE.read_text())["documents"] if d["old_id"]}
    items, _ = pilot_questions()
    rows = []
    for q in items:
        if q["set"] != "draft":
            continue
        doc = by_old.get(q["documents"][0])
        rows.append({"item": q["id"], "split": q["split"], "question": q["question"], "documents": q["documents"],
                     "cluster": doc["uuid"] if doc else q["documents"][0], "title": doc["title"] if doc else None})
    tables.write_jsonl(QUESTIONS, sorted(rows, key=lambda r: r["item"]))
    print(f"wrote {QUESTIONS}: {len(rows)} questions, {len({r['cluster'] for r in rows})} documents")


if __name__ == "__main__":
    main()
