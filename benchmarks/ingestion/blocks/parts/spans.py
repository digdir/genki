"""How parts spread over pages in a sample of a Docling export (ADR 0055).

    python3 -I spans.py <export root> [files] [seed]

The export root holds `<2 hex>/<sha256>/docling.json` (DoclingDocument JSON). Pages come from every `prov` entry of
an item, not only the first, and reading order from `docling_blocks` and `finish` in `../normalise.py`. Prints one
JSON object; reads the export only and prints no document text.
"""
import collections
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import normalise  # noqa: E402


def main(root, count, seed):
    random.seed(seed)
    files = random.sample(sorted(Path(root).glob("*/*/docling.json")), count)
    n = collections.Counter()
    span = collections.Counter()
    long_labels = collections.Counter()
    labels = collections.Counter()
    layers = collections.Counter()
    for path in files:
        doc = json.loads(path.read_text())
        pages = len(doc.get("pages") or {})
        n["pages"] += pages
        raw, sizes = normalise.docling_blocks(doc)
        blocks, _, _ = normalise.finish(raw, sizes, "x", "docling")
        started = set()
        previous = None
        late = False
        order = []
        for block in blocks:
            _, collection, index = block["native"].split("/")
            item = doc[collection][int(index)]
            label = item.get("label")
            labels[label] += 1
            layers[item.get("content_layer")] += 1
            on = [p["page_no"] for p in item.get("prov") or []]
            if not on:
                n["parts_without_a_page"] += 1
                continue
            n["parts"] += 1
            first, last = min(on), max(on)
            started.add(first)
            width = last - first + 1
            span[min(width, 5)] += 1
            n["widest"] = max(n["widest"], width)
            if width >= 3:
                long_labels[label] += 1
                if len(set(on)) < width:
                    n["three_or_more_with_a_gap"] += 1
            if item.get("content_layer") == "furniture" or block["furniture"]:
                continue
            if previous is not None and first < previous:
                n["body_parts_starting_before_the_one_before"] += 1
                late = True
            previous = first
            order.append((label, first, last, (item.get("data") or {}).get("num_cols")))
        n["files_with_one"] += late
        n["pages_where_no_part_starts"] += pages - len(started)
        for k, (label, first, last, columns) in enumerate(order):
            if label != "table":
                continue
            n["tables"] += 1
            n["tables_on_more_than_one_page"] += last > first
            if k + 1 < len(order):
                after = order[k + 1]
                if after[0] == "table" and after[1] == last + 1:
                    n["tables_followed_by_a_table_on_the_next_page"] += 1
                    n["of_those_with_the_same_columns"] += after[3] == columns
    print(json.dumps({
        "seed": seed,
        **n,
        "parts_by_pages_covered": {("5+" if k == 5 else str(k)): span[k] for k in sorted(span)},
        "three_or_more_by_label": dict(long_labels),
        "labels": dict(labels.most_common()),
        "layers": dict(layers),
    }, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 200, int(sys.argv[3]) if len(sys.argv) > 3 else 7)
