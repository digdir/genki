"""Grade genki's page builder `doclingPages` (packages/ingest/src/docling-pages.ts, derivation `docling-pages` 1)
against Docling's own per-page Markdown, the acceptance check of issue 474: the pages pass the page tests at the
reference's score or above.

Both sides come from the same files of the Docling export (<export>/<sha256[:2]>/<sha256>/docling.json):
- the reference: DoclingDocument.export_to_markdown(page_no=n), as page_tests_extract.py cuts Docling pages;
- docling-pages: doclingPages(document)[n - 1], through docling_pages_export.ts.

The page tests are those of page_tests_run2.py, on the documents of documents-run2.json found in the export: the
opb page tests and the era page tests, each graded with the opb scorer and scored on its own, never pooled. A
page whose document is missing from the export is left out on both sides.

Rerun from benchmarks/ingestion/blocks, with the opb venv and the docling venv of the parser benchmark:

    INGESTION_BENCHMARK_DATA=<ingestion data> ERAS_DATASET=<blocks/.data/eras/dataset> \\
    DOCLING_PYTHON=<opb/.data/venvs/docling/bin/python> \\
      <opb/.venv/bin/python> page_tests_docling_pages.py            # cut both sides, grade, report
      <opb/.venv/bin/python> page_tests_docling_pages.py --report   # the report again from the saved grades

DOCLING_EXPORT overrides the export folder (default ~/kudos-docling/json/docling); it is only read. Pages and
grades go to .data/docling-pages/<set>/ (local); the report to results/docling-pages-check.md.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OPB = HERE.parent / "opb"
WORK = HERE / ".data" / "docling-pages"
OUT = HERE / "results" / "docling-pages-check.md"
EXPORT = Path(os.environ.get("DOCLING_EXPORT", Path.home() / "kudos-docling" / "json" / "docling"))
ERAS_DATASET = Path(os.environ.get("ERAS_DATASET", HERE / ".data" / "eras" / "dataset"))
DOCLING_PYTHON = Path(os.environ.get("DOCLING_PYTHON", OPB / ".data" / "venvs" / "docling" / "bin" / "python"))
REFERENCE, BUILDER = "reference", "docling-pages"
NAMES = {REFERENCE: "Docling export_to_markdown(page_no) (reference)", BUILDER: "docling-pages 1"}


def cut_reference(pages_file, out):
    """Run with the docling venv: the reference side, one export_to_markdown(page_no=n) per page."""
    from docling_core.types.doc import DoclingDocument
    out.mkdir(parents=True, exist_ok=True)
    by_file = {}
    for p in json.loads(pages_file.read_text()):
        by_file.setdefault(p["docling"], []).append(p)
    for file, ps in by_file.items():
        document = DoclingDocument.model_validate(json.loads(Path(file).read_text()))
        for p in ps:
            (out / f"{p['page_id']}.md").write_text(document.export_to_markdown(page_no=p["page"]))
    print(f"reference: {sum(map(len, by_file.values()))} pages written from {len(by_file)} documents")


def test_sets():
    """page_tests_run2.test_sets, with the era dataset from ERAS_DATASET, kept to documents in the export."""
    import page_tests_run2 as run2
    docs = {str(d["doc_num"]): d for d in json.loads((HERE / "documents-run2.json").read_text())["documents"]}
    run1 = {str(d["doc_num"]) for d in json.loads((HERE / "documents.json").read_text())["documents"]}
    graded = {p.stem for p in (run2.OPB_DATASET / "gold").glob("*.json")}
    opb_pages = [p for p in json.loads(run2.OPB_PAGES.read_text())
                 if str(p["doc_num"]) in run1 and p["page_id"] in graded]
    graded = {p.stem for p in (ERAS_DATASET / "gold").glob("*.json")}
    eras_pages = [{**p, "doc_num": p["id"]} for p in json.loads((HERE / "reference-eras" / "pages.json").read_text())
                  if p["page_id"] in graded]
    sets = {}
    for name, pages, dataset in (("opb", opb_pages, run2.OPB_DATASET), ("eras", eras_pages, ERAS_DATASET)):
        kept, missing = [], set()
        for p in pages:
            sha = docs[str(p["doc_num"])]["sha256"]
            file = EXPORT / sha[:2] / sha / "docling.json"
            if file.exists():
                kept.append({**p, "docling": str(file)})
            else:
                missing.add(str(p["doc_num"]))
        sets[name] = (kept, dataset, sorted(missing))
    return sets


def grade(name, pages, dataset):
    from omni_parse_bench import markdown
    work = WORK / name
    work.mkdir(parents=True, exist_ok=True)
    pages_file = work / "pages.json"
    pages_file.write_text(json.dumps([{k: p[k] for k in ("page_id", "docling", "page")} for p in pages]))
    timings = {}
    for side in (REFERENCE, BUILDER):
        md_dir, run_dir = work / "md" / side, work / "runs" / side
        subprocess.run(["rm", "-rf", md_dir, run_dir], check=True)
        start = time.monotonic()
        if side == REFERENCE:
            subprocess.run([DOCLING_PYTHON, __file__, "--cut-reference", pages_file, md_dir], check=True)
        else:
            subprocess.run(["npx", "tsx", "--conditions=source", HERE / "docling_pages_export.ts", pages_file, md_dir],
                           check=True, cwd=ROOT)
        timings[side] = time.monotonic() - start
        preds = run_dir / "predictions"
        preds.mkdir(parents=True)
        for f in md_dir.glob("*.md"):
            (preds / f"{f.stem}.json").write_text(json.dumps({"html": markdown.to_html(f.read_text())},
                                                             ensure_ascii=False))
        subprocess.run([Path(sys.executable).parent / "opb", "grade", run_dir, "--dataset", dataset, "--unsupported"],
                       check=True, stdout=subprocess.DEVNULL)
    (work / "timings.json").write_text(json.dumps(timings))


def load(name):
    work = WORK / name
    return {side: {"parser": side, "pages": {f.stem for f in (work / "md" / side).glob("*.md")},
                   "verdicts": {r["test_id"]: r["result"] == "pass"
                                for r in map(json.loads, open(work / "runs" / side / "scores.jsonl"))}}
            for side in (REFERENCE, BUILDER)}


def section(w, name, title, pages, missing):
    import page_tests_run2 as run2
    from benchlib.tables import signed
    # page_tests_run2's row and slice helpers read the reference side's grades from WORK/<set>/runs/REFERENCE.
    run2.WORK, run2.REFERENCE = WORK, REFERENCE
    rows = run2.rows_for(name, pages, load(name))
    sl = run2.slices(name)
    count = lambda keep: (len({r["page_id"] for r in rows if keep(r)}), sum(map(keep, rows)),  # noqa: E731
                          len({r["doc"] for r in rows if keep(r)}))
    few = {n for n, k in sl if count(k)[2] < run2.FEW}
    label = lambda n: n + (" †" if n in few else "")  # noqa: E731
    w(f"## {title}\n")
    if missing:
        w(f"Left out, not in the export: {len(missing)} document(s) ({', '.join(missing)}).\n")
    w("| Slice | Pages | Tests | Documents |")
    w("| --- | ---: | ---: | ---: |")
    for n, k in sl:
        w(f"| {label(n)} | " + " | ".join(map(str, count(k))) + " |")
    w("")
    w("Pass rate in percent, ranked by the first column.\n")
    w("| Side | " + " | ".join(label(n) for n, _ in sl) + " |")
    w("| --- | " + " | ".join("---:" for _ in sl) + " |")
    ranked = sorted((REFERENCE, BUILDER), key=lambda s: -float(run2.pct(rows, s, sl[0][1]).replace("n/a", "-1")))
    for s in ranked:
        bold = "**" if s == REFERENCE else ""
        w(f"| {bold}{NAMES[s]}{bold} | " + " | ".join(run2.pct(rows, s, k) for _, k in sl) + " |")
    w("")
    w("docling-pages minus the reference in points, 95% interval from resampling documents; ✱ = interval leaves out "
      f"zero (only marked on slices from {run2.FEW}+ documents). † = fewer than {run2.FEW} documents: a hint only.\n")
    w("| Side | " + " | ".join(label(n) for n, _ in sl) + " |")
    w("| --- | " + " | ".join("---" for _ in sl) + " |")
    w(f"| {NAMES[BUILDER]} | " + " | ".join(
        run2.diff_text(run2.compare(rows, BUILDER, REFERENCE, k), BUILDER, REFERENCE, n not in few)
        for n, k in sl) + " |")
    w("")
    head, keep = sl[0]
    scored = [r for r in rows if keep(r) and r[BUILDER] is not None and r[REFERENCE] is not None]
    a, b = sum(r[REFERENCE] for r in scored), sum(r[BUILDER] for r in scored)
    w(f"**Verdict:** docling-pages is {'at or above' if b >= a else 'below'} the reference on {head.lower()}: "
      f"{b} of {len(scored)} tests passed against {a}.\n")
    differ = {}
    for r in scored:
        if r[BUILDER] != r[REFERENCE]:
            lost, won = differ.get(r["page_id"], (0, 0))
            differ[r["page_id"]] = (lost + r[REFERENCE], won + r[BUILDER])
    if differ:
        w(f"Pages where the sides differ on {head.lower()} (tests the reference passes and docling-pages fails, and "
          "the other way round):\n")
        w("| Page | Lost | Won |")
        w("| --- | ---: | ---: |")
        for page, (lost, won) in sorted(differ.items(), key=lambda kv: (-kv[1][0], kv[0])):
            w(f"| {page} | {lost} | {won} |")
        w("")
    return rows


def main():
    if sys.argv[1:2] == ["--cut-reference"]:
        cut_reference(Path(sys.argv[2]), Path(sys.argv[3]))
        return
    if not os.environ.get("INGESTION_BENCHMARK_DATA"):
        raise SystemExit("set INGESTION_BENCHMARK_DATA (the opb page tests live there), as for page_tests_run2.py")
    sys.path.insert(0, str(OPB))
    sys.path.insert(0, str(HERE))
    sets = test_sets()
    if "--report" not in sys.argv:
        for name, (pages, dataset, _) in sets.items():
            grade(name, pages, dataset)
    lines = []
    w = lines.append
    w("# docling-pages against Docling's own pages\n")
    w("Each page's Markdown from genki's page builder `doclingPages` (derivation `docling-pages` 1) and from "
      "Docling's `export_to_markdown(page_no=n)` (**the reference**), both from the same DoclingDocument JSON of "
      "the Docling export, graded with the opb scorer on the page tests of `page_tests_run2.py`. Two test sets, "
      "each scored on its own and never pooled. Only this run's pages and grades are used. Made by "
      "`page_tests_docling_pages.py`.\n")
    section(w, "opb", "opb page tests (documents of documents.json)", *[sets["opb"][i] for i in (0, 2)])
    section(w, "eras", "Era page tests (documents of the era test set)", *[sets["eras"][i] for i in (0, 2)])
    w("Slices: **All** = every test on the set's pages; **Text** = tests that a phrase is on the page (present) or "
      "that two phrases come in order (order); **Tables** = tests that a cell sits in the right row and column "
      "(table_cell); **Digital**, **Scan + text**, **Image-only** = pages by how the PDF holds their text (text "
      "layer, scanned image with a text layer, image without one); era slices = by publishing year. Era set "
      "(reference-eras/README.md): **Text** = present + order tests on the first round's pages; **Tables** = "
      "table_cell on all pages; **All (scored)** = both of those; **Text around tables** = text tests on the added "
      "table pages, shown alone. Page-kind and era slices use the scored tests.\n")
    w("No document text is in this file.")
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
