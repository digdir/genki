"""Assemble the reference as a dataset the scoring tool reads, in .data/opb/dataset/.

manifest.parquet       one row per page with tests; the suite is why the page was drawn
pages/<page_id>.pdf    the page, cut out of its document
gold/<page_id>.json    its tests, copied from reference/tests/ (the tool calls this folder gold/)

Pages whose test file is skipped (no tests) are left out. The folder is rebuilt from scratch.
"""
import json
import shutil

import pyarrow as pa
import pyarrow.parquet as pq
import pymupdf

from common_opb import DATASET, TESTS, pages, pdf_path


def main():
    if DATASET.exists():
        shutil.rmtree(DATASET)
    (DATASET / "pages").mkdir(parents=True)
    (DATASET / "gold").mkdir()
    rows, skipped, missing = [], 0, 0
    for p in pages():
        src = TESTS / f'{p["page_id"]}.json'
        if not src.exists():
            missing += 1
            continue
        if not json.loads(src.read_text())["tests"]:
            skipped += 1
            continue
        with pymupdf.open(pdf_path(p["doc_num"])) as doc, pymupdf.open() as one:
            one.insert_pdf(doc, from_page=p["page"] - 1, to_page=p["page"] - 1)
            one.save(DATASET / "pages" / f'{p["page_id"]}.pdf')
        shutil.copy(src, DATASET / "gold" / src.name)
        rows.append({"page_id": p["page_id"], "document": p["doc_num"], "suite": p["reason"],
                     "doc_path": f'pages/{p["page_id"]}.pdf', "gt_path": f'gold/{p["page_id"]}.json',
                     "outputs": ["html"]})
    pq.write_table(pa.Table.from_pylist(rows), DATASET / "manifest.parquet")
    print(f"{len(rows)} pages in {DATASET}; {skipped} skipped, {missing} without a test file yet")


if __name__ == "__main__":
    main()
