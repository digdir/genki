"""Grade every side against the reference and publish what report.py needs into results/.

    score.py      # then report.py

Rebuilds the scoring tool's dataset from reference/, writes each side's text per page and grades it
with the tool (.data/opb/runs/<side>/, from scratch). Then publishes, committed:

results/sides/<side>/verdicts.jsonl   one line per test: pass or fail, and why
results/sides/<side>/record.json      what the run used: commit, code, reference and items hashes,
                                       the side's settings, scorer and package versions
results/coverage.json                 the whole-sample counts that need the downloads in .data/
"""
import collections
import csv
import json
import re
import shutil
import subprocess
import sys

from omni_parse_bench import markdown, views

import build_dataset
import predict
from benchlib import record, tables
from common_opb import (BENCHMARK, CONVERSIONS, DATA, DATASET, HERE, MARKER_CACHE, PAGES, PARSER_CODE, PARSERS,
                        PUBLISHED, RESULTS, RUNS, SIDES, TESTS, dataset_pages, kudos_pages, marker_pages, pages,
                        parsers_done, sample)

PACKAGES = ("omni-parse-bench", "pymupdf", "markdown-it-py")
LOST_MIN = 200
WHY_MAX = 200
# A "why" can quote a side's text; benchlib refuses em-dashes in published text, so a quoted one becomes "--"
EM_DASH = "\u2014"


def marker_settings(docs):
    seen = set()
    for d in docs:
        data = json.loads((MARKER_CACHE / f'{d["sha256"]}.json').read_text())
        seen.add(json.dumps({"marker_version": data["marker_version"], "settings": data["settings"]}, sort_keys=True))
    if len(seen) != 1:
        raise SystemExit(f"the Marker cache mixes {len(seen)} versions or settings")
    return json.loads(seen.pop())


def side_settings(docs):
    used = sorted({d["doc_num"] for d in docs.values()})
    kudos_text = {"source": "KUDOS /documents/{uuid}/contents",
                  "text": record.tree_hash([DATA / "kudos" / f'{docs[n]["uuid"]}.txt' for n in used])}
    return {
        "marker": {**marker_settings(docs[n] for n in used),
                   "pages": "split as genki's page chunker splits Marker's output",
                   "conversions": record.tree_hash([MARKER_CACHE / f'{docs[n]["sha256"]}.json' for n in used])},
        "kudos": {**kudos_text, "pages": "split on page breaks; no text where a document has fewer pieces than pages"},
        "kudos-joined": {**kudos_text, "pages": "split on page breaks; a document whose pieces don't match its "
                                                "pages gives its whole text on each page"},
        **{side: parser_settings(side) for side in parsers_done()},
    }


def parser_settings(side):
    """What a parser side used: its meta.json (parser, version, settings, models, machine), the hashes of its
    pages' Markdown and of the converter script, and the pages it failed on."""
    out = CONVERSIONS / side
    ids = dataset_pages()
    converted = [i for i in ids if (out / f"{i}.md").exists()]
    # Note: the last timing per page, so a resumed run counts each page once; a note only, never ranked
    timed = {t["page_id"]: t["seconds"] for t in map(json.loads, open(out / "timings.jsonl")) if t["page_id"] in ids}
    seconds = sorted(timed.values())
    return {**json.loads((out / "meta.json").read_text()),
            "seconds_per_page": {"median": seconds[len(seconds) // 2], "p90": seconds[int(len(seconds) * 0.9)],
                                 "pages": len(seconds)} if seconds else None,
            "pages": "each page converted on its own, as a one-page PDF",
            "conversions": record.tree_hash([out / f"{i}.md" for i in converted]),
            "converter_code": record.tree_hash([PARSER_CODE / "convert_common.py", PARSER_CODE / PARSERS[side]]),
            "failed_pages": sorted(set(ids) - set(converted))}


def coverage():
    """Over every page of the 150 sampled documents, no reference: pages whose text layer holds at least
    LOST_MIN characters where Marker keeps under a tenth of that, and scanned pages without a text layer
    where each side gives text (at least 50 characters) on the right page."""
    docs = sample()
    by_doc = collections.defaultdict(list)
    for r in csv.DictReader(open(RESULTS / "pages.csv")):
        by_doc[r["doc_num"]].append(r)
    c, w = collections.Counter(), collections.Counter()
    for dn, rs in sorted(by_doc.items()):
        mp, kp, wt = marker_pages(docs[dn]["sha256"]), kudos_pages(docs[dn]["uuid"]), docs[dn]["weight"]
        tree = json.loads((MARKER_CACHE / f'{docs[dn]["sha256"]}.json').read_text())["json"]["children"]
        aligned = len(kp) == len(rs)
        for r in rs:
            if r["pdf_kind"] == "blank":
                continue
            i = int(r["page"]) - 1
            layer = int(r["text_layer_chars"] or 0)
            m = len(re.sub(r"\s", "", views.text(markdown.to_html(mp[i]))))
            k = len(re.sub(r"\s", "", kp[i])) if aligned else 0
            c["pages"] += 1
            w["pages"] += wt
            if layer >= LOST_MIN and m < 0.1 * layer:
                c["marker_lost"] += 1
                w["marker_lost"] += wt
                top = {b["block_type"] for b in tree[i].get("children") or []}
                c["marker_lost_picture"] += top <= {"Figure", "Picture", "FigureGroup", "PictureGroup",
                                                     "PageHeader", "PageFooter"}
            if r["pdf_kind"] == "image-only":
                c["image_only"] += 1
                c["image_only_marker"] += m >= 50
                c["image_only_kudos"] += k >= 50
                c["image_only_kudos_misaligned"] += not aligned
    return {**dict(sorted(c.items())), "marker_lost_share": w["marker_lost"] / w["pages"],
            "lost_min_chars": LOST_MIN}


def publish(docs):
    settings = {"scorer": f'omni-parse-bench {record.package_versions(["omni-parse-bench"])["omni-parse-bench"]}',
                "outputs": "html; no layout tests", "markdown_to_html": "omni_parse_bench.markdown.to_html"}
    code = sorted(HERE.glob("*.py")) + [HERE.parent.parent / "benchlib"]
    per_side = side_settings(docs)
    for side in SIDES + parsers_done():
        rows = sorted(map(json.loads, open(RUNS / side / "scores.jsonl")), key=lambda r: r["test_id"])
        out = PUBLISHED / "sides" / side
        tables.write_jsonl(out / "verdicts.jsonl", (
            {"test_id": r["test_id"], "page_id": r["page_id"], "document": r["document"], "suite": r["suite"],
             "test_type": r["test_type"], "tags": r["tags"], "result": r["result"], "why": r["why"][:WHY_MAX].replace(EM_DASH, "--")}
            for r in rows))
        record.write(out / "record.json", record.make(
            BENCHMARK, root=HERE, code=code, reference=[TESTS], items=[PAGES], side=side,
            side_settings=per_side[side], settings=settings, packages=PACKAGES))
    tables.write_json(PUBLISHED / "coverage.json", coverage())


def main():
    build_dataset.main()
    graded = SIDES + parsers_done()
    for side in graded:
        shutil.rmtree(RUNS / side, ignore_errors=True)
    predict.main()
    opb = HERE / ".venv" / "bin" / "opb"
    for side in graded:
        # Note: `--unsupported` with no value: every side gives html, and no test reads layout blocks
        done = subprocess.run([opb, "grade", RUNS / side, "--dataset", DATASET, "--unsupported"])
        if done.returncode:
            sys.exit(done.returncode)
    docs = sample()
    publish({p["doc_num"]: docs[p["doc_num"]] for p in pages()})
    print(f"published verdicts and records for {', '.join(graded)} in {PUBLISHED}")


if __name__ == "__main__":
    main()
