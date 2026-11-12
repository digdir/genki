"""Shared by the converter scripts. Each script runs in its own venv with one parser and the standard
library, converts every single-page PDF that build_dataset.py cut (.data/opb/dataset/pages/) and writes:

<out>/<page_id>.md      the parser's Markdown for the page
<out>/<page_id>.error   instead, when the parser failed on the page (the side then has no text there)
<out>/timings.jsonl     seconds per page, a note only, never part of the ranking
<out>/meta.json         parser, version, settings, models and machine, copied into the side's run record

A page that already has a .md is skipped, so a stopped run resumes where it stopped.
"""
import argparse
import json
import platform
import subprocess
import time
import traceback
from pathlib import Path


def arguments():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument("pages", type=Path, help="folder of <page_id>.pdf")
    a.add_argument("out", type=Path, help="folder for <page_id>.md, timings.jsonl and meta.json")
    a.add_argument("--only", nargs="*", help="page ids to convert, for a trial run")
    return a.parse_args()


def machine():
    chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
    return {"system": platform.system(), "machine": platform.machine(), "chip": chip or platform.processor(),
            "python": platform.python_version()}


def todo(pages, out, only=None):
    out.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(pages.glob("*.pdf"))
    if only:
        pdfs = [p for p in pdfs if p.stem in set(only)]
    return [p for p in pdfs if not (out / f"{p.stem}.md").exists()]


def run(convert, pages, out, meta, only=None):
    """Convert each page with convert(pdf_path) -> markdown, one at a time."""
    pdfs = todo(pages, out, only)
    write_meta(out, meta)
    for i, pdf in enumerate(pdfs, 1):
        started = time.monotonic()
        try:
            text = convert(pdf)
        except Exception:
            (out / f"{pdf.stem}.error").write_text(traceback.format_exc())
            print(f"[{i}/{len(pdfs)}] {pdf.stem}: failed", flush=True)
            continue
        seconds = time.monotonic() - started
        (out / f"{pdf.stem}.md").write_text(text)
        (out / f"{pdf.stem}.error").unlink(missing_ok=True)
        with open(out / "timings.jsonl", "a") as f:
            f.write(json.dumps({"page_id": pdf.stem, "seconds": round(seconds, 3)}) + "\n")
        print(f"[{i}/{len(pdfs)}] {pdf.stem}: {seconds:.1f} s, {len(text)} chars", flush=True)


def write_meta(out, meta):
    out.mkdir(parents=True, exist_ok=True)
    (out / "meta.json").write_text(json.dumps({**meta, "machine": machine()}, indent=2, ensure_ascii=False) + "\n")
