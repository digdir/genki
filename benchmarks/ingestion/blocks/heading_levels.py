"""Heading levels after conversion, for parsers that find headings but flatten them (Docling gives every heading
level 1). A prototype: it rewrites `level` in a run's blocks and leaves everything else as it is, so
headings_vs_outline.py can score the result against the PDFs' own outlines.

    <python with pypdfium2> heading_levels.py <pdf dir> <run>/<parser> <out dir> [--mode number-size|full]

Writes <out dir>/<doc>/blocks.jsonl (and copies text.md, pages.json) with new heading levels and, per heading,
`level_source`: which rung set it.

The rungs, per document:
1. outline (only in --mode full): the PDF's own bookmarks, matched to headings as headings_vs_outline.py
   matches them (same or next page, normalised text). Not used in number-size mode, because the outline is the
   reference that mode is scored against.
2. number: a leading section number gives the level by its depth ("2" = 1, "2.1" = 2, "2.1.3" = 3). Used when
   at least 30% of the document's headings carry one (fewer: the numbers are more likely list items or years).
3. size: the heading's text size. On a page with a text layer, the median font size of the PDF's characters
   inside the heading's box (pdfium; font size times the text matrix scale); without one (scans), the box height, as headings are mostly one line.
   - In a numbered document, an unnumbered heading takes the level of the numbered level whose median size is
     nearest; bigger than every level-1 heading (by more than 1 pt) makes it level 1.
   - In an unnumbered document, sizes (bold counted as +0.4 pt) are rounded to 0.5 pt and ranked: the biggest size is level 1, the next 2,
     and so on, at most 4 levels; a size used by only one heading joins the nearest size used more.
Titles (level 0) keep their level.
"""
import ctypes
import difflib
import json
import re
import shutil
import statistics
import sys
import unicodedata
from pathlib import Path

import pypdfium2 as pdfium

SECTION = re.compile(r"^[\s#*]*(\d+(?:\.\d+)*)\.?\s+\S")
MIN_NUMBERED = 0.3
MAX_LEVELS = 4


def numbered_level(text):
    m = SECTION.match(unicodedata.normalize("NFKC", text or ""))
    if not m:
        return None
    parts = m[1].split(".")
    # A year or a long number is not a section number
    if len(parts) == 1 and (len(parts[0]) > 2):
        return None
    return len(parts)


def text_size(pdf, block):
    """Median font size (pt) of the text layer's characters in the block's box, or the box height (pt)."""
    page = pdf[block["page"] - 1]
    w, h = page.get_size()
    x0, y0, x1, y1 = block["bbox"]               # fractions, origin top left
    left, right, top, bottom = x0 * w, x1 * w, h - y0 * h, h - y1 * h
    tp = page.get_textpage()
    sizes, bold = [], []
    for i in range(tp.count_chars()):
        cx0, cy0, cx1, cy1 = tp.get_charbox(i)
        if cx0 >= left - 1 and cx1 <= right + 1 and cy0 >= bottom - 1 and cy1 <= top + 1:
            ch = tp.get_text_range(i, 1)
            if ch.strip():
                # The font size times the text matrix's scale: many PDFs set size 1 and scale the matrix
                m = pdfium.raw.FS_MATRIX()
                scale = 1.0
                if pdfium.raw.FPDFText_GetMatrix(tp.raw, i, ctypes.byref(m)):
                    scale = abs(m.a * m.d - m.b * m.c) ** 0.5 or 1.0
                size = pdfium.raw.FPDFText_GetFontSize(tp.raw, i) * scale
                if size > 0:
                    sizes.append(size)
                    bold.append(pdfium.raw.FPDFText_GetFontWeight(tp.raw, i) >= 600)
    if len(sizes) >= 3:
        # bold adds 0.4 pt, so equal sizes split by weight but never pass a size 0.5 pt bigger
        return round(statistics.median(sizes) + (0.4 if sum(bold) > len(bold) / 2 else 0), 1), "font"
    return round((y1 - y0) * h, 1), "box"


def norm(t):  # as headings_vs_outline.py
    t = unicodedata.normalize("NFKC", t or "").lower()
    t = re.sub(r"^[\s#*]*(\d+(\.\d+)*\.?|[ivx]+\.|[a-z]\))\s+", "", t)
    t = re.sub(r"[^\wæøå ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def similar(a, b):  # as headings_vs_outline.py
    if not a or not b:
        return False
    if len(a) >= 6 and len(b) >= 6 and (a in b or b in a):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.85


def outline_levels(pdf, headings):
    items = []
    for i in pdf.get_toc(max_depth=10):
        dest = i.get_dest()
        title = norm(i.get_title())
        if title:
            items.append((title, i.level + 1, (dest.get_index() if dest else 0) + 1))
    found = {}
    for title, level, page in items:
        for idx, b in headings:
            if idx in found or not (page - 1 <= b["page"] <= page + 1):
                continue
            if similar(title, norm(b["text"])):
                found[idx] = level
                break
    return found, len(items)


def assign(blocks, pdf, mode):
    heads = [(i, b) for i, b in enumerate(blocks) if b["kind"] == "heading"]
    if not heads:
        return blocks
    levels, source = {}, {}
    if mode == "full":
        found, n_items = outline_levels(pdf, heads)
        if n_items:
            for i, lv in found.items():
                levels[i], source[i] = lv, "outline"
    rest = [(i, b) for i, b in heads if i not in levels]
    sizes = {i: text_size(pdf, b) for i, b in rest}
    numbers = {i: numbered_level(b["text"]) for i, b in rest}
    numbered = [i for i, _ in rest if numbers[i]]
    if rest and len(numbered) / len(rest) >= MIN_NUMBERED:
        by_level = {}
        for i in numbered:
            levels[i], source[i] = numbers[i], "number"
            by_level.setdefault(numbers[i], []).append(sizes[i][0])
        med = {lv: statistics.median(v) for lv, v in by_level.items()}
        for i, _ in rest:
            if i in levels:
                continue
            s = sizes[i][0]
            if 1 in med and s > med[1] + 1:
                lv = 1
            else:
                lv = min(med, key=lambda k: (abs(med[k] - s), k))
            levels[i], source[i] = lv, f"size-{sizes[i][1]}"
    elif rest:
        rounded = {i: round(sizes[i][0] * 2) / 2 for i, _ in rest}
        counts = {}
        for s in rounded.values():
            counts[s] = counts.get(s, 0) + 1
        common = [s for s, c in counts.items() if c > 1] or list(counts)
        snap = {s: (s if s in common else min(common, key=lambda c: abs(c - s))) for s in counts}
        ranked = sorted(set(snap.values()), reverse=True)
        for i, _ in rest:
            levels[i] = min(ranked.index(snap[rounded[i]]) + 1, MAX_LEVELS)
            source[i] = f"size-{sizes[i][1]}"
    out = []
    for i, b in enumerate(blocks):
        if i in levels:
            b = {**b, "level": levels[i], "level_source": source[i]}
        out.append(b)
    return out


def main():
    pdfs, run, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    mode = sys.argv[sys.argv.index("--mode") + 1] if "--mode" in sys.argv else "number-size"
    for folder in sorted(p for p in run.iterdir() if (p / "blocks.jsonl").exists()):
        blocks = [json.loads(line) for line in open(folder / "blocks.jsonl")]
        pdf = pdfium.PdfDocument(str(pdfs / f"{folder.name}.pdf"))
        new = assign(blocks, pdf, mode)
        target = out / folder.name
        target.mkdir(parents=True, exist_ok=True)
        with open(target / "blocks.jsonl", "w") as f:
            for b in new:
                f.write(json.dumps(b, ensure_ascii=False) + "\n")
        for name in ("pages.json",):
            if (folder / name).exists():
                shutil.copy(folder / name, target / name)
        src = {}
        for b in new:
            if b.get("level_source"):
                src[b["level_source"]] = src.get(b["level_source"], 0) + 1
        print(folder.name, src, flush=True)


if __name__ == "__main__":
    main()
