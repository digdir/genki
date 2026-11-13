"""Facts about conversion parts on a sample of a Docling export (ADR 0055).

    python3 -I stats.py <export root> [files] [seed]

The export root holds `<2 hex>/<sha256>/docling.json` (DoclingDocument JSON). Parts are made by `docling_blocks` and
`finish` in `../normalise.py` (format genki.blocks/1). Prints one JSON object; reads the export only and prints no
document text.
"""
import json
import random
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import normalise  # noqa: E402

LABEL = re.compile(r"^(?:s\.|side|page|sida)?\s*(\d{1,4})(?:\s*(?:av|of|/)\s*\d{1,4})?$", re.I)


def item(doc, ref):
    _, collection, index = ref.split("/")
    return doc[collection][int(index)]


def main(root, count, seed):
    random.seed(seed)
    files = random.sample(sorted(Path(root).glob("*/*/docling.json")), count)
    n = dict(files=len(files), pages=0, parts=0, furniture=0, crossing=0, json_bytes=0, astral_pages=0,
             astral_files=0, not_nfc=0, tables=0, merged_tables=0, html_bytes=0, labelled_pages=0, label_differs=0)
    for path in files:
        doc = json.loads(path.read_text())
        raw, sizes = normalise.docling_blocks(doc)
        blocks, _, _ = normalise.finish(raw, sizes, "x", "docling")
        n["pages"] += len(doc.get("pages") or {})
        n["parts"] += len(blocks)
        astral = set()
        for b in blocks:
            n["json_bytes"] += len(json.dumps(b, ensure_ascii=False).encode()) + 1
            n["furniture"] += b["furniture"]
            native = item(doc, b["native"])
            if len({p["page_no"] for p in native.get("prov") or []}) > 1:
                n["crossing"] += 1
            if any(ord(c) > 0xFFFF for c in b["text"] or ""):
                astral.add(b["page"])
            if b["html"]:
                n["tables"] += 1
                n["html_bytes"] += len(b["html"].encode())
                cells = (native.get("data") or {}).get("table_cells") or []
                n["merged_tables"] += any(c.get("row_span", 1) > 1 or c.get("col_span", 1) > 1 for c in cells)
        n["astral_pages"] += len(astral)
        n["astral_files"] += bool(astral)
        n["not_nfc"] += sum(1 for t in doc["texts"] if unicodedata.normalize("NFC", t.get("text") or "") != (t.get("text") or ""))
        labels = {}
        for t in doc["texts"]:
            furniture = t.get("content_layer") == "furniture" or t["label"] in ("page_footer", "page_header", "page_number")
            match = LABEL.match((t.get("text") or "").strip()) if furniture and t.get("prov") else None
            if match:
                labels.setdefault(t["prov"][0]["page_no"], int(match.group(1)))
        n["labelled_pages"] += len(labels)
        n["label_differs"] += sum(1 for page, label in labels.items() if label != page)
    share = lambda a, b: round(100 * a / b, 2) if b else None
    print(json.dumps({**n,
        "parts_a_page": round(n["parts"] / n["pages"], 1),
        "json_bytes_a_page": round(n["json_bytes"] / n["pages"]),
        "furniture_pct": share(n["furniture"], n["parts"]),
        "crossing_pct": share(n["crossing"], n["parts"]),
        "astral_pages_pct": share(n["astral_pages"], n["pages"]),
        "merged_tables_pct": share(n["merged_tables"], n["tables"]),
        "html_pct_of_json": share(n["html_bytes"], n["json_bytes"]),
        "labelled_pages_pct": share(n["labelled_pages"], n["pages"]),
        "label_differs_pct": share(n["label_differs"], n["labelled_pages"])}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 200, int(sys.argv[3]) if len(sys.argv) > 3 else 7)
