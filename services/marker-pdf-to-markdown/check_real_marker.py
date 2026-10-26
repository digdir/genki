"""
Converts real PDFs with real Marker through the service's own conversion code, and checks the result.

CI tests the service against a fake Marker; run this by hand when Marker or its settings change.
It prints one line of JSON per PDF and exits with 1 if any check fails. In the image:

    docker run --rm --network none \
      -v "$PWD/main.py:/app/main.py:ro" -v "$PWD/check_real_marker.py:/app/check_real_marker.py:ro" \
      -v /path/to/pdfs:/in:ro marker-pdf-to-markdown python check_real_marker.py /in/report.pdf
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("MARKER_PDF_TO_MARKDOWN_API_KEY", "check-real-marker")
os.environ.setdefault("CACHE_DIR", tempfile.mkdtemp(prefix="marker-check-"))

import main  # noqa: E402


def blocks_in(blocks):
    for block in blocks or []:
        yield block
        yield from blocks_in(block.get("children"))


def check(conv, path: Path) -> dict:
    task = main.ConversionTask(pdf_path=path, pdf_content=b"", file_hash="", cache=False, future=None)
    started = time.monotonic()
    result = main.process_conversion(conv, task)
    seconds = time.monotonic() - started
    pages = len(result["json"]["children"])
    stats = result["metadata"].get("page_stats", [])
    problems = []
    if len(result["pages"]) != pages + 1:
        problems.append(f"{len(result['pages'])} markdown entries for {pages} JSON pages, expected {pages + 1}")
    if len(stats) != pages:
        problems.append(f"page_stats has {len(stats)} pages, the JSON {pages}")
    if any("images" in block for block in blocks_in(result["json"]["children"])):
        problems.append("images left in the JSON")
    if result["settings"] != main.MARKER_SETTINGS:
        problems.append("settings differ from MARKER_SETTINGS")
    size = len(json.dumps(result["json"]))
    return {
        "file": path.name,
        "pages": pages,
        "seconds_per_page": round(seconds / max(pages, 1), 2),
        "json_kb_per_page": round(size / 1024 / max(pages, 1), 1),
        "ocr_pages": sum(1 for s in stats if s.get("text_extraction_method") != "pdftext"),
        "marker_version": result["marker_version"],
        "problems": problems,
    }


def run(paths: list[str]) -> int:
    conv = main.create_converter()
    failed = False
    for path in paths:
        report = check(conv, Path(path))
        failed = failed or bool(report["problems"])
        print(json.dumps(report), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python check_real_marker.py FILE.pdf [FILE.pdf ...]")
    sys.exit(run(sys.argv[1:]))
