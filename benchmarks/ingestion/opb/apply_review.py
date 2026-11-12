"""Apply the blind check's verdicts (.data/opb/verify/result-*.jsonl) to reference/tests/ and log them.

ok    the test stays as written
fix   the test's args are replaced and its derivation becomes model_review
drop  the test is removed

Every verdict is appended to reference/review-log.jsonl (committed), with the test before and after, so the
reference's history can be read. Verdicts already logged are skipped, so a rerun changes nothing.
"""
import json

from common_opb import OPB, REVIEW_LOG as LOG, TESTS


def main():
    logged = {json.loads(l)["test_id"] for l in open(LOG)} if LOG.exists() else set()
    results = [json.loads(l) for f in sorted((OPB / "verify").glob("result-*.jsonl"))
               for l in open(f) if l.strip()]
    todo = [r for r in results if r["test_id"] not in logged]
    by_page = {}
    for r in todo:
        by_page.setdefault(r["test_id"].rsplit("-t", 1)[0], []).append(r)
    counts = {"ok": 0, "fix": 0, "drop": 0}
    with open(LOG, "a") as log:
        for page_id, rs in sorted(by_page.items()):
            path = TESTS / f"{page_id}.json"
            doc = json.loads(path.read_text())
            tests = {t["id"]: t for t in doc["tests"]}
            for r in rs:
                if r["verdict"] not in counts:
                    raise SystemExit(f'{r["test_id"]}: unknown verdict {r["verdict"]!r}')
                before = tests.get(r["test_id"])
                if before is None:
                    raise SystemExit(f'{r["test_id"]}: not in {path.name}')
                after = None
                if r["verdict"] == "fix":
                    after = {**before, "args": r["args"], "derivation": "model_review"}
                    tests[r["test_id"]] = after
                elif r["verdict"] == "drop":
                    del tests[r["test_id"]]
                else:
                    after = before
                counts[r["verdict"]] += 1
                log.write(json.dumps({"test_id": r["test_id"], "verdict": r["verdict"], "note": r.get("note", ""),
                                      "before": before["args"], "after": after and after["args"]},
                                     ensure_ascii=False) + "\n")
            doc["tests"] = list(tests.values())
            if not doc["tests"]:
                doc["skipped"] = "every test was dropped in the blind check"
            path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    print(f"applied {len(todo)} verdicts: {counts}")


if __name__ == "__main__":
    main()
