"""Level changes followed, against the PDFs' outlines (the reference), split by numbered and unnumbered documents,
as in issue 516's check of 14 Nov 2026. Matching is headings_vs_outline.py's: each outline entry takes the first
unused heading on its page or next to it whose normalised text is similar.

    <python with pypdfium2> heading_levels_score.py <pdf dir> <run dir> <variant>... [--titles-zero] [--pairs <out.json>]

<run dir>/<variant>/<doc>/blocks.jsonl as written by heading_levels_parts.ts or heading_levels.py. A document
counts as numbered when at least 30% of its headings (kind heading) carry a section number, as heading_levels.py
reads one. An outline entry whose destination has no page index is skipped (headings_vs_outline.py would stop).
--titles-zero scores titles at level 0, as the prototype's blocks have them. --pairs writes every matched pair.
"""
import json
import sys
from pathlib import Path

import pypdfium2 as pdfium

sys.path.insert(0, str(Path(__file__).resolve().parent))
from heading_levels import norm, numbered_level, similar  # noqa: E402

args = sys.argv[1:]
titles_zero = "--titles-zero" in args
if titles_zero:
    args.remove("--titles-zero")
pairs_out = None
if "--pairs" in args:
    k = args.index("--pairs")
    pairs_out = args[k + 1]
    del args[k:k + 2]
pdfs, run, variants = Path(args[0]), Path(args[1]), args[2:]

outlines, skipped = {}, 0
for f in sorted(pdfs.glob("*.pdf")):
    doc = pdfium.PdfDocument(str(f))
    items = []
    for i in doc.get_toc(max_depth=10):
        dest = i.get_dest()
        index = dest.get_index() if dest else 0
        if index is None:
            skipped += 1
            continue
        title = norm(i.get_title())
        if title:
            items.append((title, i.level + 1, index + 1))
    if items:
        outlines[f.stem] = items
    doc.close()
print(f"{len(list(pdfs.glob('*.pdf')))} PDFs, {len(outlines)} with an outline, "
      f"{sum(len(v) for v in outlines.values())} entries, {skipped} entries skipped (no page index)\n")

sign = lambda x: (x > 0) - (x < 0)
pct = lambda a, b: f"{a} / {b} ({100 * a / b:.0f}%)" if b else "–"
all_pairs = {}
print("| Variant | Documents | Entries | Matched | Level changes followed | Numbered docs | Unnumbered docs | Same-level steps kept |")
print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
for v in variants:
    t = {"docs": 0, "entries": 0, "found": 0, "chg": 0, "ok": 0, "same": 0, "same_ok": 0}
    split = {True: [0, 0, 0], False: [0, 0, 0]}  # documents, changes, followed
    for doc, items in outlines.items():
        f = run / v / doc / "blocks.jsonl"
        if not f.exists():
            continue
        blocks = [json.loads(line) for line in open(f)]
        heads = []
        for i, b in enumerate(blocks):
            if b["kind"] not in ("heading", "title"):
                continue
            level = 0 if (titles_zero and b["kind"] == "title") else b.get("level")
            heads.append((norm(b["text"]), level, b["page"], i, b["text"]))
        section = [b for b in blocks if b["kind"] == "heading"]
        numbered = bool(section) and sum(numbered_level(b["text"]) is not None for b in section) / len(section) >= 0.3
        used, pairs = set(), []
        for title, level, page in items:
            for h in heads:
                if h[3] in used or not (page - 1 <= h[2] <= page + 1):
                    continue
                if similar(title, h[0]):
                    used.add(h[3])
                    pairs.append((level, h[1] if h[1] is not None else 0, h[4], h[2]))
                    break
        t["docs"] += 1; t["entries"] += len(items); t["found"] += len(pairs)
        split[numbered][0] += 1
        for (a1, b1, *_), (a2, b2, *_) in zip(pairs, pairs[1:]):
            ok = sign(a2 - a1) == sign(b2 - b1)
            if a2 != a1:
                t["chg"] += 1; t["ok"] += ok; split[numbered][1] += 1; split[numbered][2] += ok
            else:
                t["same"] += 1; t["same_ok"] += ok
        all_pairs.setdefault(v, {})[doc] = {"numbered": numbered, "pairs": pairs}
    print(f"| {v}{' (titles 0)' if titles_zero else ''} | {t['docs']} | {t['entries']} | {pct(t['found'], t['entries'])} | "
          f"{pct(t['ok'], t['chg'])} | {pct(split[True][2], split[True][1])} ({split[True][0]} docs) | "
          f"{pct(split[False][2], split[False][1])} ({split[False][0]} docs) | {pct(t['same_ok'], t['same'])} |")
if pairs_out:
    Path(pairs_out).write_text(json.dumps(all_pairs, ensure_ascii=False))
