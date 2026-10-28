"""List the tests a second, blind reader checks against the page image, in batches.

A test is checked when KUDOS and Marker disagree on it, or when both fail it: those are the tests
that decide the comparison, and where a copying slip in the test would show. Left out:
  - tests both pass: two independent extractions already agree with the test;
  - table tests KUDOS fails only because its plain text has no tables while Marker passes them;
  - tests on pages KUDOS doesn't serve at all (fewer pieces than pages), where Marker passes.

Writes .data/opb/verify/batch-NN.jsonl (one test per line, with its claim in words) and skips tests
already in reference/review-log.jsonl.
"""
import json
import sys

from common_opb import OPB, REVIEW_LOG as LOG, RUNS, TESTS

BATCHES = int(sys.argv[1]) if len(sys.argv) > 1 else 6


def verdicts(side):
    return {r["test_id"]: r for r in map(json.loads, open(RUNS / side / "scores.jsonl"))}


def structural(kudos, marker):
    """KUDOS fails for a reason the test's wording can't cause, and Marker confirms the test."""
    return marker["result"] == "pass" and kudos["why"] in ("no tables found", "no html output")


def claim(t):
    a = t["args"]
    q = lambda x: json.dumps(x["text"] if "text" in x else x.get("number"), ensure_ascii=False)
    if t["test_type"] == "present":
        return f'This text is printed on the page: {q(a["content"])}'
    if t["test_type"] == "order":
        return f'Reading the page as a person does, {q(a["before"])} comes before {q(a["after"])}'
    parts = [f'A table on the page has a cell {q(a["cell"])}']
    names = {"top_heading": "under the column heading", "left_heading": "with the row label",
             "left": "with the cell to its left", "right": "with the cell to its right",
             "up": "with the cell above it", "down": "with the cell below it"}
    parts += [f"{names[k]} {q(v)}" for k, v in a.items() if k in names]
    for k, label in (("headings", "under the headings, top down"), ("row_groups", "in the row groups")):
        if k in a:
            parts.append(f'{label} {", ".join(q(x) for x in a[k])}')
    if "section" in a:
        parts.append(f'in the section {q(a["section"])}')
    return ", ".join(parts)


def main():
    done = {json.loads(l)["test_id"] for l in open(LOG)} if LOG.exists() else set()
    kudos, marker = verdicts("kudos"), verdicts("marker")
    queue = []
    for tid, k in sorted(kudos.items()):
        m = marker[tid]
        if tid in done or (k["result"] == "pass" and m["result"] == "pass"):
            continue
        if k["result"] != m["result"] and structural(k, m):
            continue
        page_id = k["page_id"]
        t = next(x for x in json.loads((TESTS / f"{page_id}.json").read_text())["tests"] if x["id"] == tid)
        queue.append({"test_id": tid, "page_id": page_id, "test_type": t["test_type"],
                      "claim": claim(t), "args": t["args"]})
    out = OPB / "verify"
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("batch-*.jsonl"):
        old.unlink()
    # Note: a page's tests stay in one batch, so a reader opens each page once
    pages = sorted({q["page_id"] for q in queue})
    for i in range(BATCHES):
        mine = set(pages[i::BATCHES])
        lines = [json.dumps(q, ensure_ascii=False) for q in queue if q["page_id"] in mine]
        (out / f"batch-{i + 1:02d}.jsonl").write_text("\n".join(lines) + "\n" if lines else "")
        print(f"batch-{i + 1:02d}: {len(lines)} tests on {len(mine)} pages")
    print(f"{len(queue)} tests to check")


if __name__ == "__main__":
    main()
