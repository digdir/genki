"""Draw the pages the reference covers, from the ingestion sample, into reference/pages.json (committed).

random  one page per document, from its pages with text or a scan on them (not blank)
scan    one more page from each document that has scanned pages (scan+text or image-only)
table   one more page from TABLE_DOCS documents, a page where PyMuPDF finds a table

Page kinds come from the ingestion benchmark's checks (.data/results/pages.csv). The draw is
seeded, so a rerun gives the same pages.
"""
import collections
import csv
import json
import random

import pymupdf

from common_opb import PAGES, RESULTS, pdf_path, sample

SEED = 20261026
TABLE_DOCS = 30
SCANNED = ("scan+text", "image-only")


def has_table(page):
    """A table of at least 3 rows and 2 columns, ruled or aligned, on the page."""
    try:
        found = page.find_tables()
    except Exception:
        return False
    return any(t.row_count >= 3 and t.col_count >= 2 for t in found.tables)


def main():
    rng = random.Random(SEED)
    docs = sample()
    kinds = collections.defaultdict(dict)
    for r in csv.DictReader(open(RESULTS / "pages.csv")):
        kinds[r["doc_num"]][int(r["page"])] = r["pdf_kind"]

    picked = []

    def pick(doc_num, page, reason):
        picked.append({"page_id": f"kudos-{doc_num}-p{page}", "doc_num": doc_num, "page": page,
                       "reason": reason, "pdf_kind": kinds[doc_num][page], "type": docs[doc_num]["type"]})

    for doc_num in docs:
        pick(doc_num, rng.choice(sorted(p for p, k in kinds[doc_num].items() if k != "blank")), "random")
    taken = {(p["doc_num"], p["page"]) for p in picked}

    for doc_num in docs:
        scans = sorted(p for p, k in kinds[doc_num].items() if k in SCANNED and (doc_num, p) not in taken)
        if scans:
            pick(doc_num, rng.choice(scans), "scan")
    taken = {(p["doc_num"], p["page"]) for p in picked}

    order = list(docs)
    rng.shuffle(order)
    tables = 0
    for doc_num in order:
        if tables == TABLE_DOCS:
            break
        digital = [p for p, k in kinds[doc_num].items() if k == "digital" and (doc_num, p) not in taken]
        rng.shuffle(digital)
        with pymupdf.open(pdf_path(doc_num)) as pdf:
            # Note: at most 40 pages a document, so a long document without tables doesn't stall the draw
            hit = next((p for p in digital[:40] if has_table(pdf[p - 1])), None)
        if hit:
            pick(doc_num, hit, "table")
            tables += 1
        print(f"table pages: {tables}/{TABLE_DOCS}, looked at {doc_num}")

    PAGES.write_text(json.dumps(picked, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(picked)} pages:", dict(collections.Counter(p["reason"] for p in picked)),
          dict(collections.Counter(p["pdf_kind"] for p in picked)))


if __name__ == "__main__":
    main()
