"""Grade today's Azure runs (whole-document conversions) on the opb page tests that fall inside the 15 documents
here. Only these runs: no earlier conversion or grade (not the page tests' Mac or pilot sides) is read.
Exploratory: 33 pages with tests.

    ../opb/.venv/bin/python page_tests.py            # INGESTION_BENCHMARK_DATA set, as for opb/score.py
    ../opb/.venv/bin/python page_tests.py --report   # the report again from the saved grades

1. The tests: opb/reference/pages.json pages whose document is in documents.json and which have tests.
2. Each host and parser in .data/runs/azure-*: one Markdown per page (page_tests_extract.py, run with the
   parser's venv; its docstring says how each parser's page is cut out of the whole document).
3. Each page through the tool's own markdown converter into predictions, graded with `opb grade` against the
   opb dataset (the reference and the scorer of the page tests), in .data/page-tests/ (local, never published).
4. results/page-tests-azure.md: every Azure side against the reference side, Marker 1.10.2 on the A100, on the
   same tests, with document-resampled 95% intervals (benchlib.stats, opb report.py's seed): all tests, text,
   tables, and by page kind; then T4 against A100 and CPU against GPU for the same parser.
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPB = HERE.parent / "opb"
sys.path.insert(0, str(OPB))

from common_opb import DATASET, PAGES  # noqa: E402  (puts benchmarks/ on the path)
from benchlib import stats  # noqa: E402
from benchlib.tables import number, signed  # noqa: E402
from omni_parse_bench import markdown  # noqa: E402

import report as base  # noqa: E402

WORK = HERE / ".data" / "page-tests"
RUNS = HERE / ".data" / "runs"
OUT = HERE / "results" / "page-tests-azure.md"
VENVS = OPB / ".data" / "venvs"
HOSTS = {"azure-NC24ads_A100_v4-swedencentral": "a100", "azure-NC4as_T4_v3-francecentral": "t4",
         "azure-D8as_v6-swedencentral": "cpu"}
HOST_NAMES = {"a100": "A100", "t4": "T4", "cpu": "CPU"}
REFERENCE = "a100-marker"
PARSER_NAMES = {"marker": "Marker 1.10.2", "marker2": "Marker 2.1", "mineru": "MinerU 4.1.6",
                "mineru-noimg": "MinerU 4.1.6, no picture descriptions", "docling": "Docling, EasyOCR en",
                "docling-no": "Docling, EasyOCR no+en", "docling-tess": "Docling, Tesseract nor",
                "docling-rapid": "Docling, RapidOCR"}
FEW = 10  # a slice from fewer documents than this gets no trusted interval
KINDS = (("digital", "Digital (text layer)"), ("scan+text", "Scan with a text layer"), ("image-only", "Image-only scan"))

# Written by hand from the tables below (11 Nov 2026); rerunning the script doesn't change it
READING = """## Reading

- **The host doesn't change the text.** Docling gives identical verdicts on the A100, the T4 and the CPU for every OCR
  choice, and MinerU on the T4 and the A100. Marker 2.1 differs in 1 test between the GPUs, Marker 1.10.2 in 5 of
  287 (T4 −0.3 points, −2.1 to +1.0). The CPU Marker run matches the A100 on the 108 tests of its 5 documents.
  float16 on the T4 costs nothing measurable here.
- **On all tests no side is clearly ahead of or behind the reference** (Marker 1.10.2 on the A100, 251 of 287):
  every interval includes zero. Docling with Tesseract (Norwegian) passes the most, 266 (+5.2, −1.1 to +13.3), then
  MinerU 262 (+3.8), Marker 2.1 252 (+0.3), and Docling with EasyOCR in English, the default image's OCR, the
  fewest, 246 (−1.7).
- **Text tests:** Docling with Tesseract is ahead, +6.6 points (+1.2 to +14.6), the only interval here that leaves
  out zero. MinerU +6.2 and Marker 2.1 +3.5 lean the same way without a clear result.
- **Tables (29 tests, 8 documents): the reference does best,** 72.4; Docling 65.5, MinerU 55.2, Marker 2.1 44.8.
  Too few documents for a trusted interval, but the order matches the 1,933-test page tests.
- **By page kind** (scanned slices from 4 or 5 documents, so hints only): on digital pages every side is within
  about 4 points of the reference. On scans with a text layer the reference is the weakest (79.2), Docling with
  Tesseract the strongest (100.0). On image-only scans the reference is the strongest (90.2); Docling with EasyOCR in
  English drops to 61.0, with Norwegian EasyOCR 78.0, RapidOCR 80.5, Tesseract 85.4.
- **MinerU with and without picture descriptions is the same** on every test: MinerU stored no picture descriptions
  in either run on these documents.
"""


def wanted_pages():
    docs = {str(d["doc_num"]) for d in json.loads((HERE / "documents.json").read_text())["documents"]}
    graded = {p.stem for p in (DATASET / "gold").glob("*.json")}
    return [p for p in json.loads(PAGES.read_text()) if str(p["doc_num"]) in docs and p["page_id"] in graded]


def python_for(parser):
    if parser.startswith("docling"):
        return VENVS / "docling" / "bin" / "python"
    if parser.startswith("mineru"):
        return VENVS / "mineru" / "bin" / "python"
    return Path(sys.executable)


def extract_and_grade(pages):
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "pages.json").write_text(json.dumps(pages))
    opb = OPB / ".venv" / "bin" / "opb"
    sides = {}
    for host, short in HOSTS.items():
        for run in sorted(p for p in (RUNS / host).iterdir() if p.is_dir() and p.name != "logs"):
            side = f"{short}-{run.name}"
            md_dir, run_dir = WORK / "md" / side, WORK / "runs" / side
            subprocess.run([python_for(run.name), HERE / "page_tests_extract.py", run, md_dir, WORK / "pages.json"],
                           check=True)
            preds = run_dir / "predictions"
            if run_dir.exists():
                subprocess.run(["rm", "-rf", run_dir], check=True)
            preds.mkdir(parents=True)
            for f in md_dir.glob("*.md"):
                (preds / f"{f.stem}.json").write_text(json.dumps({"html": markdown.to_html(f.read_text())},
                                                                 ensure_ascii=False))
            subprocess.run([opb, "grade", run_dir, "--dataset", DATASET, "--unsupported"], check=True,
                           stdout=subprocess.DEVNULL)
            sides[side] = {"host": short, "parser": run.name, "pages": sorted(f.stem for f in md_dir.glob("*.md")),
                           "verdicts": {r["test_id"]: r["result"] == "pass"
                                        for r in map(json.loads, open(run_dir / "scores.jsonl"))}}
    return sides


def saved():
    """The grades extract_and_grade() left in .data/page-tests/."""
    sides = {}
    for host, short in HOSTS.items():
        for run in sorted(p for p in (RUNS / host).iterdir() if p.is_dir() and p.name != "logs"):
            side = f"{short}-{run.name}"
            sides[side] = {"host": short, "parser": run.name,
                           "pages": sorted(f.stem for f in (WORK / "md" / side).glob("*.md")),
                           "verdicts": {r["test_id"]: r["result"] == "pass"
                                        for r in map(json.loads, open(WORK / "runs" / side / "scores.jsonl"))}}
    return sides


def rows_for(pages, sides):
    """One row per test on the chosen pages, from the reference side's grading today."""
    meta = {p["page_id"]: p for p in pages}
    rows = []
    for k in sorted(map(json.loads, open(WORK / "runs" / REFERENCE / "scores.jsonl")), key=lambda r: r["test_id"]):
        if k["page_id"] not in meta:
            continue
        row = {"test_id": k["test_id"], "page_id": k["page_id"], "doc": k["document"], "type": k["test_type"],
               "family": base.FAMILY[k["test_type"]], "kind": meta[k["page_id"]]["pdf_kind"]}
        for s, v in sides.items():
            # None where the run has no converted document for this page (the CPU Marker run was stopped)
            row[s] = v["verdicts"].get(k["test_id"], False) if k["page_id"] in set(v["pages"]) else None
        rows.append(row)
    return rows


SLICES = [("All tests", lambda r: True), ("Text tests", lambda r: r["family"] == "text"),
          ("Table tests", lambda r: r["family"] == "tables")] + \
         [(name, (lambda k: lambda r: r["kind"] == k)(kind)) for kind, name in KINDS]


def compare(rows, a, b, keep=lambda r: True):
    rs = [r for r in rows if r[a] is not None and r[b] is not None and keep(r)]
    if not rs:
        return None, rs
    us = base.units(rs, (a, b))
    return stats.compare(us, (a, b), base.all_tests, seed=base.SEED, label=f"azure:{a}:{b}"), rs


def diff_text(c, a, b, trusted=True):
    if c is None or c.scores[a] is None or c.scores[b] is None:
        return "n/a"
    d = c.diff(a, b)
    star = " ✱" if d.significant and trusted else ""
    return f"{signed(d.point)}{star} ({signed(d.low)} to {signed(d.high)})"


def pct(rows, s, keep=lambda r: True):
    rs = [r for r in rows if r[s] is not None and keep(r)]
    return (number(sum(r[s] for r in rs) / len(rs), 1) if rs else "n/a"), len(rs)


def main():
    pages = wanted_pages()
    sides = saved() if "--report" in sys.argv else extract_and_grade(pages)
    rows = rows_for(pages, sides)
    names = {s: f'{PARSER_NAMES[v["parser"]]}, {HOST_NAMES[v["host"]]}' for s, v in sides.items()}
    order = sorted(sides, key=lambda s: (list(PARSER_NAMES).index(sides[s]["parser"]),
                                         list(HOST_NAMES).index(sides[s]["host"])))
    count = lambda keep: (len({r["page_id"] for r in rows if keep(r)}), sum(map(keep, rows)),
                          len({r["doc"] for r in rows if keep(r)}))
    n_pages, n_tests, n_docs = count(lambda r: True)
    lines = []
    w = lines.append
    w("# Page tests on the Azure runs (exploratory)\n")
    w(f"Today's Azure runs (11 Nov 2026), graded on the opb page tests (`../opb`: the same reference, scorer and "
      f"statistics) on the pages that fall inside the 15 documents here: **{n_tests} tests on {n_pages} pages from "
      f"{n_docs} documents**. Only these runs are used: no earlier conversion or grade. The reference side is "
      f"**Marker 1.10.2 on the A100** (all 15 documents). Made by `page_tests.py`.\n")
    w(f"**Exploratory, because the sample is small:** {n_pages} pages (one more page of these documents is in the "
      f"page tests' sample but has no tests), and the scanned pages and the table tests each come from a few "
      f"documents, so one document can move a slice. Use it to compare hosts and to see whether a parser is clearly "
      f"ahead or behind; the 1,933-test ranking is `../opb/results/parsers.md`.\n")
    w("| Slice | Pages | Tests | Documents |")
    w("| --- | ---: | ---: | ---: |")
    for name, keep in SLICES:
        w(f"| {name} | " + " | ".join(str(x) for x in count(keep)) + " |")
    w("")
    w(READING)

    w("## Every side\n")
    w("Pass rate in percent. The CPU Marker run was stopped by hand after 5 documents; its row covers only their "
      "tests.\n")
    w("| Side | Passed | All | Text | Tables | Digital | Scan + text layer | Image-only |")
    w("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for s in order:
        cells = [pct(rows, s, keep)[0] for _, keep in SLICES]
        passed = sum(r[s] for r in rows if r[s] is not None)
        total = sum(r[s] is not None for r in rows)
        bold = "**" if s == REFERENCE else ""
        w(f"| {bold}{names[s]}{bold} | {passed}/{total} | " + " | ".join(cells) + " |")
    w("")

    w("## Against the reference (Marker 1.10.2 on the A100)\n")
    few = {name for name, keep in SLICES if count(keep)[2] < FEW}
    w("Side minus reference in points, on the tests both have, with the 95% interval from resampling documents; "
      "✱ marks an interval that leaves out zero. † marks a slice from fewer than "
      f"{FEW} documents ({', '.join(f'{n.lower()}: {count(k)[2]}' for n, k in SLICES if n in few)}): resampling so "
      "few documents gives intervals that can't be trusted, so read only the point difference there, and only as "
      "a hint.\n")
    w("| Side | " + " | ".join(name + (" †" if name in few else "") for name, _ in SLICES) + " |")
    w("| --- | " + " | ".join("---" for _ in SLICES) + " |")
    for s in order:
        if s == REFERENCE:
            continue
        cells = [diff_text(compare(rows, s, REFERENCE, keep)[0], s, REFERENCE, trusted=name not in few)
                 for name, keep in SLICES]
        w(f"| {names[s]} | " + " | ".join(cells) + " |")
    w("")

    def pair_table(title, note, pairs):
        w(f"## {title}\n")
        if note:
            w(note + "\n")
        w("| A | B | Tests | A | B | A − B, all | A − B, text | A − B, scans | Tests where they differ |")
        w("| --- | --- | ---: | ---: | ---: | --- | --- | --- | ---: |")
        for a, b in pairs:
            c, rs = compare(rows, a, b)
            ct, _ = compare(rows, a, b, lambda r: r["family"] == "text")
            cs, _ = compare(rows, a, b, lambda r: r["kind"] in base.SCANNED)
            w(f"| {names[a]} | {names[b]} | {len(rs)} | {number(c.scores[a], 1)} | {number(c.scores[b], 1)} | "
              f"{diff_text(c, a, b)} | {diff_text(ct, a, b)} | {diff_text(cs, a, b)} | "
              f"{sum(r[a] != r[b] for r in rs)} |")
        w("")

    have = lambda host, parser: f"{host}-{parser}" in sides
    pair_table("T4 (float16) against A100 (bfloat16)", "The same parser on both GPUs.",
               [(f"t4-{p}", f"a100-{p}") for p in PARSER_NAMES if have("t4", p) and have("a100", p)])
    pair_table("CPU against GPU", "The same parser on the CPU host and the A100; Marker only on the 5 documents "
               "its CPU run finished.",
               [(f"cpu-{p}", f"a100-{p}") for p in PARSER_NAMES if have("cpu", p) and have("a100", p)])

    w("## How each page was made\n")
    w("The Azure runs converted whole documents; the page tests grade one page at a time. Each page is cut out of "
      "the whole document (`page_tests_extract.py`):\n")
    w("- **Marker 1.10.2 and Marker 2.1:** `markdown.md` split on Marker's page marks `{n}`, the method the page "
      "tests' Marker side used (`opb/common_opb.marker_pages`, as genki's page chunker splits Marker's output). "
      "The page count matched every document.")
    w("- **Docling:** Docling's own `export_to_markdown(page_no=n)` on the stored document.")
    w("- **MinerU:** MinerU's own renderer on the stored middle JSON with only that page kept.\n")
    w("## Limits\n")
    w("- A small sample (above); slices by page kind rest on a few documents each.")
    w("- The tests check what is on the page; they don't check heading levels, text a parser adds, or page "
      "furniture.")
    w("- No document text is in this file.\n")
    w("Earlier runs, not used here: the page tests' Mac and pilot sides were graded on the same tests on 11 Nov and "
      "agree with these runs within about 1 point for Marker 1.10.2, MinerU and Docling (Marker 2.1 scored lower "
      "on the Mac); they are in `../opb/results/`.")
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
