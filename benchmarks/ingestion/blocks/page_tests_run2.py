"""Grade the second Azure run (run 2) on both page-test sets, each on its own (never pooled):

- opb: the opb page tests on pages of the 15 documents of documents.json (as page_tests.py did for run 1);
- eras: the era test set's page tests (reference-eras/, 24 documents), scored by its rule: text = present and
  order tests on the first round's pages (reasons random, scan, table); tables = table_cell tests on all pages;
  text on the added table pages (table-more, scan-table) only as its own slice, "text around tables".

Only run 2's conversions are read, and the reference side is run 2's Marker 1.10.2 on the T4. No earlier
conversion or grade is used.

    ../opb/.venv/bin/python page_tests_run2.py            # extract pages, grade, report
    ../opb/.venv/bin/python page_tests_run2.py --report   # the report again from the saved grades

Grades go to .data/page-tests-run2/<set>/ (local); the report to results/page-tests-run2.md.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPB = HERE.parent / "opb"
sys.path.insert(0, str(OPB))

from common_opb import DATASET as OPB_DATASET, PAGES as OPB_PAGES  # noqa: E402
from benchlib import stats  # noqa: E402
from benchlib.tables import number, signed  # noqa: E402
from omni_parse_bench import markdown  # noqa: E402

import report as base  # noqa: E402

WORK = HERE / ".data" / "page-tests-run2"
RUNS = HERE / ".data" / "runs"
OUT = HERE / "results" / "page-tests-run2.md"
VENVS = OPB / ".data" / "venvs"
HOSTS = {"azure-NC4as_T4_v3-francecentral-run2": "t4", "azure-D32as_v6-swedencentral-run2": "cpu"}
REFERENCE = os.environ.get("RUN2_REFERENCE", "t4-marker")  # override only to smoke-test the script
PARSER_NAMES = {"marker": "Marker 1.10.2", "marker-strip": "Marker 1.10.2, strip_existing_ocr",
                "docling-tess": "Docling, Tesseract nor", "docling-tess-repair": "Docling, Tesseract nor, repair",
                "docling-tess-nocells": "Docling, Tesseract nor, no cell matching",
                "docling-tess-egret": "Docling, Tesseract nor, Egret large",
                "docling-tess-noreng": "Docling, Tesseract nor+eng",
                "docling-tess-best": "Docling, Tesseract nor, tessdata_best"}
FEW = 10
KINDS = (("digital", "Digital"), ("scan+text", "Scan + text"), ("image-only", "Image-only"))
ERAS = ("before 2000", "2000-2009", "2010-2019", "2020 on")
FIRST_ROUND = {"random", "scan", "table"}


def test_sets():
    docs = {str(d["doc_num"]) for d in json.loads((HERE / "documents.json").read_text())["documents"]}
    graded = {p.stem for p in (OPB_DATASET / "gold").glob("*.json")}
    opb_pages = [p for p in json.loads(OPB_PAGES.read_text()) if str(p["doc_num"]) in docs and p["page_id"] in graded]
    eras_dataset = HERE / ".data" / "eras" / "dataset"
    graded = {p.stem for p in (eras_dataset / "gold").glob("*.json")}
    eras_pages = [{**p, "doc_num": p["id"]} for p in json.loads((HERE / "reference-eras" / "pages.json").read_text())
                  if p["page_id"] in graded]
    return {"opb": (opb_pages, OPB_DATASET), "eras": (eras_pages, eras_dataset)}


def python_for(parser):
    if parser.startswith("docling"):
        return VENVS / "docling" / "bin" / "python"
    return Path(sys.executable)


def runs():
    for host, short in HOSTS.items():
        if not (RUNS / host).is_dir():
            continue
        for run in sorted(p for p in (RUNS / host).iterdir()
                          if p.is_dir() and p.name in PARSER_NAMES):
            yield short, run


def grade(name, pages, dataset):
    work = WORK / name
    work.mkdir(parents=True, exist_ok=True)
    (work / "pages.json").write_text(json.dumps([{k: p[k] for k in ("page_id", "doc_num", "page")} for p in pages]))
    opb = OPB / ".venv" / "bin" / "opb"
    for short, run in runs():
        side = f"{short}-{run.name}"
        md_dir, run_dir = work / "md" / side, work / "runs" / side
        subprocess.run([python_for(run.name), HERE / "page_tests_extract.py", run, md_dir, work / "pages.json"],
                       check=True)
        subprocess.run(["rm", "-rf", run_dir], check=True)
        preds = run_dir / "predictions"
        preds.mkdir(parents=True)
        for f in md_dir.glob("*.md"):
            (preds / f"{f.stem}.json").write_text(json.dumps({"html": markdown.to_html(f.read_text())},
                                                             ensure_ascii=False))
        subprocess.run([opb, "grade", run_dir, "--dataset", dataset, "--unsupported"], check=True,
                       stdout=subprocess.DEVNULL)


def load(name):
    work = WORK / name
    sides = {}
    for short, run in runs():
        side = f"{short}-{run.name}"
        sides[side] = {"host": short, "parser": run.name,
                       "pages": {f.stem for f in (work / "md" / side).glob("*.md")},
                       "verdicts": {r["test_id"]: r["result"] == "pass"
                                    for r in map(json.loads, open(work / "runs" / side / "scores.jsonl"))}}
    return sides


def rows_for(name, pages, sides):
    meta = {p["page_id"]: p for p in pages}
    rows = []
    ref = WORK / name / "runs" / REFERENCE / "scores.jsonl"
    for k in sorted(map(json.loads, open(ref)), key=lambda r: r["test_id"]):
        p = meta.get(k["page_id"])
        if p is None:
            continue
        row = {"test_id": k["test_id"], "page_id": k["page_id"], "doc": str(p["doc_num"]), "type": k["test_type"],
               "family": base.FAMILY[k["test_type"]], "kind": p["pdf_kind"], "reason": p.get("reason"),
               "era": p.get("era")}
        for s, v in sides.items():
            row[s] = v["verdicts"].get(k["test_id"], False) if k["page_id"] in v["pages"] else None
        rows.append(row)
    return rows


def slices(name):
    if name == "opb":
        return [("All", lambda r: True), ("Text", lambda r: r["family"] == "text"),
                ("Tables", lambda r: r["family"] == "tables")] + \
               [(label, (lambda k: lambda r: r["kind"] == k)(kind)) for kind, label in KINDS]
    scored = lambda r: r["family"] == "tables" or r["reason"] in FIRST_ROUND  # noqa: E731
    out = [("All (scored)", scored),
           ("Text", lambda r: r["family"] == "text" and r["reason"] in FIRST_ROUND),
           ("Tables", lambda r: r["family"] == "tables"),
           ("Text around tables", lambda r: r["family"] == "text" and r["reason"] not in FIRST_ROUND)]
    out += [(label, (lambda k: lambda r: scored(r) and r["kind"] == k)(kind)) for kind, label in KINDS]
    out += [(era, (lambda e: lambda r: scored(r) and r["era"] == e)(era)) for era in ERAS]
    return out


def compare(rows, a, b, keep):
    rs = [r for r in rows if r[a] is not None and r[b] is not None and keep(r)]
    if not rs:
        return None
    return stats.compare(base.units(rs, (a, b)), (a, b), base.all_tests, seed=base.SEED, label=f"run2:{a}:{b}")


def diff_text(c, a, b, trusted):
    if c is None or c.scores[a] is None or c.scores[b] is None:
        return "n/a"
    d = c.diff(a, b)
    star = " ✱" if d.significant and trusted else ""
    return f"{signed(d.point)}{star} ({signed(d.low)} to {signed(d.high)})"


def pct(rows, s, keep):
    rs = [r for r in rows if r[s] is not None and keep(r)]
    return number(sum(r[s] for r in rs) / len(rs), 1) if rs else "n/a"


def section(w, name, title, pages, sides):
    rows = rows_for(name, pages, sides)
    sl = slices(name)
    count = lambda keep: (len({r["page_id"] for r in rows if keep(r)}), sum(map(keep, rows)),  # noqa: E731
                          len({r["doc"] for r in rows if keep(r)}))
    order = sorted(sides, key=lambda s: list(PARSER_NAMES).index(sides[s]["parser"]))
    names = {s: PARSER_NAMES[v["parser"]] + (" (reference)" if s == REFERENCE else "") for s, v in sides.items()}
    few = {n for n, k in sl if count(k)[2] < FEW}
    w(f"## {title}\n")
    w("| Slice | Pages | Tests | Documents |")
    w("| --- | ---: | ---: | ---: |")
    for n, k in sl:
        w(f"| {n}{' †' if n in few else ''} | " + " | ".join(map(str, count(k))) + " |")
    w("")
    w("Pass rate in percent, ranked by the first column.\n")
    w("| Side | " + " | ".join(n + (" †" if n in few else "") for n, _ in sl) + " |")
    w("| --- | " + " | ".join("---:" for _ in sl) + " |")
    ranked = sorted(order, key=lambda s: -float(pct(rows, s, sl[0][1]).replace("n/a", "-1")))
    for s in ranked:
        bold = "**" if s == REFERENCE else ""
        w(f"| {bold}{names[s]}{bold} | " + " | ".join(pct(rows, s, k) for _, k in sl) + " |")
    w("")
    w("Side minus reference in points, 95% interval from resampling documents; ✱ = interval leaves out zero "
      f"(only marked on slices from {FEW}+ documents). † = fewer than {FEW} documents: a hint only.\n")
    w("| Side | " + " | ".join(n + (" †" if n in few else "") for n, _ in sl) + " |")
    w("| --- | " + " | ".join("---" for _ in sl) + " |")
    for s in ranked:
        if s == REFERENCE:
            continue
        w(f"| {names[s]} | " + " | ".join(diff_text(compare(rows, s, REFERENCE, k), s, REFERENCE, n not in few)
                                          for n, k in sl) + " |")
    w("")
    return rows


def main():
    sets = test_sets()
    if "--report" not in sys.argv:
        for name, (pages, dataset) in sets.items():
            grade(name, pages, dataset)
    lines = []
    w = lines.append
    w("# Page tests on run 2 (11 Nov 2026)\n")
    w("Run 2's whole-document conversions, one page cut out at a time (`page_tests_extract.py`), graded with the "
      "opb scorer. Two test sets, each scored on its own and never pooled. **Reference: run 2's Marker 1.10.2 on "
      "the T4.** Only run 2's conversions are used. Made by `page_tests_run2.py`.\n")
    all_rows = {}
    all_rows["opb"] = section(w, "opb", "opb page tests (15 documents of documents.json)", sets["opb"][0], load("opb"))
    all_rows["eras"] = section(w, "eras", "Era page tests (24 documents of the era test set)", sets["eras"][0],
                               load("eras"))
    w("Era set scoring (reference-eras/README.md): **Text** = present + order tests on the first round's pages; "
      "**Tables** = table_cell on all pages; **All (scored)** = both of those; **Text around tables** = text tests "
      "on the added table pages, shown alone. Page-kind and era slices use the scored tests.\n")
    w("No document text is in this file.")
    OUT.write_text("\n".join(lines) + "\n")
    for name, rows in all_rows.items():
        (WORK / name / "rows.json").write_text(json.dumps(rows))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
