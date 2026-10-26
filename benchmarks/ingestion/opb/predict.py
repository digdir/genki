"""Write each side's output for every dataset page, as predictions/<page_id>.json the tool grades.

kudos         KUDOS /contents split on its page breaks, page n as served; null where the
              document has fewer pieces than pages
kudos-joined  the same, but a document whose pieces don't match its page count gives its whole
              text for each of its pages: the best KUDOS can do if page numbers didn't matter
marker        Marker 1.10.2's markdown for the page (the pilot's stored conversion, as genki chunks
              it), converted to HTML by the tool's own markdown converter

KUDOS's plain text goes in a <pre>, which the tool reads as plain text.
"""
import html
import json

import pymupdf
from omni_parse_bench import markdown

from common_opb import DATASET, RUNS, kudos_pages, marker_pages, pages, pdf_path, sample


def page_count(doc_num):
    with pymupdf.open(pdf_path(doc_num)) as pdf:
        return pdf.page_count


def plain(text):
    return f"<pre>{html.escape(text)}</pre>"


def main():
    docs = sample()
    in_dataset = {p.stem for p in (DATASET / "gold").glob("*.json")}
    outputs = {"kudos": {}, "kudos-joined": {}, "marker": {}}
    for p in pages():
        if p["page_id"] not in in_dataset:
            continue
        s = docs[p["doc_num"]]
        pieces, n = kudos_pages(s["uuid"]), page_count(p["doc_num"])
        served = pieces[p["page"] - 1] if p["page"] <= len(pieces) else None
        outputs["kudos"][p["page_id"]] = None if served is None else plain(served)
        joined = served if len(pieces) == n else "\n".join(pieces)
        outputs["kudos-joined"][p["page_id"]] = None if joined is None else plain(joined)
        mp = marker_pages(s["sha256"])
        if len(mp) != n:
            raise SystemExit(f'{p["doc_num"]}: Marker has {len(mp)} pages, the PDF {n}')
        outputs["marker"][p["page_id"]] = markdown.to_html(mp[p["page"] - 1])
    for side, preds in outputs.items():
        out = RUNS / side / "predictions"
        out.mkdir(parents=True, exist_ok=True)
        for page_id, h in preds.items():
            (out / f"{page_id}.json").write_text(json.dumps({"html": h}, ensure_ascii=False))
        print(f"{side}: {len(preds)} pages, {sum(h is None for h in preds.values())} without text")


if __name__ == "__main__":
    main()
