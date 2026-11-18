"""Heading quality against the PDFs' own outlines (bookmarks), for documents that have one.

For each outline entry, look for a heading block from the parser on the same page (or the next, since an outline
can point at the page before a heading) whose text matches the outline title (normalised, difflib ratio >= 0.85,
or one contains the other). Report per parser: outline headings found (recall), level exact match, and level
match after the best constant shift per document (a parser that calls chapters 2 and sections 3 is consistent,
just shifted), and how many of the parser's headings on those documents are in the outline.

    python headings_vs_outline.py <pdf dir> <run dir> [parsers...] [--numbering]

--numbering adds a row per parser with the level taken from the heading's own section number ("2" = 1,
"2.1" = 2, "2.1.3" = 3) instead of the parser's level; headings without a section number are left out of
that row, so its "found" counts numbered headings only.
"""
import difflib, json, re, sys, unicodedata
from pathlib import Path
import pypdfium2 as pdfium

def norm(t):
    t = unicodedata.normalize("NFKC", t or "").lower()
    t = re.sub(r"^[\s#*]*(\d+(\.\d+)*\.?|[ivx]+\.|[a-z]\))\s+", "", t)  # leading section numbers
    t = re.sub(r"[^\wæøå ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()

def similar(a, b):
    if not a or not b:
        return False
    if len(a) >= 6 and len(b) >= 6 and (a in b or b in a):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.85

NUMBERING = "--numbering" in sys.argv
if NUMBERING:
    sys.argv.remove("--numbering")
SECTION = re.compile(r"^[\s#*]*(\d+(?:\.\d+)*)\.?\s+\S")

def numbered_level(text):
    m = SECTION.match(unicodedata.normalize("NFKC", text or ""))
    return len(m[1].split(".")) if m else None

pdfs, run = Path(sys.argv[1]), Path(sys.argv[2])
parsers = sys.argv[3:] or ["docling", "docling-no", "docling-tess", "docling-rapid", "mineru", "mineru-noimg", "marker", "marker2"]
outlines = {}
for f in sorted(pdfs.glob("*.pdf")):
    doc = pdfium.PdfDocument(str(f))
    items = []
    for i in doc.get_toc(max_depth=10):
        dest = i.get_dest()
        items.append((norm(i.get_title()), i.level + 1, (dest.get_index() if dest else 0) + 1))
    items = [i for i in items if i[0]]
    if items:
        outlines[f.stem] = items
total = sum(len(v) for v in outlines.values())
print(f"{len(outlines)} documents with an outline, {total} entries\n")
import collections
print("Outline levels:", dict(sorted(collections.Counter(l for v in outlines.values() for _, l, _ in v).items())))
print("| Parser | Outline headings found | Level exact | Level after shift | Nesting steps right | Level changes followed | Same-level steps kept | Parser headings in the outline | Documents |")
print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
rows = [(p, False) for p in parsers] + ([(p, True) for p in parsers] if NUMBERING else [])
for p, by_number in rows:
    found = exact = shifted = 0; ph_total = ph_in = 0; ndocs = 0; total_p = 0; steps = steps_ok = 0; chg = chg_ok = 0; same = same_ok = 0
    for doc, items in outlines.items():
        f = run / p / doc / "blocks.jsonl"
        if not f.exists():
            continue
        ndocs += 1; total_p += len(items)
        heads = [json.loads(l) for l in open(f)]
        heads = [(norm(b["text"]), numbered_level(b["text"]) if by_number else b.get("level"), b["page"], i)
                 for i, b in enumerate(heads) if b["kind"] in ("heading", "title")]
        if by_number:
            heads = [h for h in heads if h[1] is not None]
        ph_total += len(heads)
        used, pairs = set(), []
        for title, level, page in items:
            for h in heads:
                if h[3] in used or not (page - 1 <= h[2] <= page + 1):
                    continue
                if similar(title, h[0]):
                    used.add(h[3]); pairs.append((level, h[1] if h[1] is not None else 0)); break
        found += len(pairs); ph_in += len(used)
        exact += sum(a == b for a, b in pairs)
        sign = lambda x: (x > 0) - (x < 0)
        for (a1, b1), (a2, b2) in zip(pairs, pairs[1:]):
            steps += 1; ok = sign(a2 - a1) == sign(b2 - b1); steps_ok += ok
            if a2 != a1: chg += 1; chg_ok += ok
            else: same += 1; same_ok += ok
        if pairs:
            best = max(sum(a == b + s for a, b in pairs) for s in range(-5, 6))
            shifted += best
    if not ndocs:
        continue
    pct = lambda a, b: f"{a} / {b} ({100 * a / b:.0f}%)" if b else "–"
    print(f"| {p}{' (levels from numbering)' if by_number else ''} | {pct(found, total_p)} | {pct(exact, found)} | {pct(shifted, found)} | {pct(steps_ok, steps)} | {pct(chg_ok, chg)} | {pct(same_ok, same)} | {pct(ph_in, ph_total)} | {ndocs} |")
