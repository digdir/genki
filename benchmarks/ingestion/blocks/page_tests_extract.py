"""One page's Markdown from a whole-document conversion, for grading the Azure runs on the opb page tests
(page_tests.py). Run with the interpreter of the parser's venv, since Docling and MinerU render from their own
stored output:

    <python> page_tests_extract.py <run>/<parser> <out> <pages.json>

<pages.json> is a list of {"page_id", "doc_num", "page"} (page counted from 1). Writes <out>/<page_id>.md for
every page whose document the run converted, and nothing for the rest.

How a page is cut out of the whole document, per parser:
- marker, marker2: markdown.md split on Marker's page marks `{n}` (paginate_output), the text between mark n and
  mark n+1, stripped. This is how the page tests' Marker side was split (opb common_opb.marker_pages, as genki's
  page chunker splits it); the Azure converters wrote the marks without the separator line, so the mark alone
  is matched.
- docling*: DoclingDocument.export_to_markdown(page_no=n) on native.json.gz, the same export the page tests'
  Docling sides used on one-page PDFs.
- mineru*: MinerU's own renderer (ParseResult.markdown()) on native.json.gz with only page n kept, picture data
  URIs removed as on the page tests' MinerU side.
"""
import gzip
import json
import re
import sys
from pathlib import Path

MARK = re.compile(r"(?:^|\n\n)\{(\d+)\}\n")
DATA_URI = re.compile(r"(!\[[^\]]*\]\()data:[^)]*\)")


def marker_pages(markdown):
    marks = list(MARK.finditer(markdown))
    numbers = [int(m[1]) for m in marks]
    if numbers != list(range(len(marks))):
        raise ValueError(f"page marks out of order: {numbers[:20]}")
    return [markdown[m.end():(marks[i + 1].start() if i + 1 < len(marks) else len(markdown))].strip()
            for i, m in enumerate(marks)]


def main():
    run, out, wanted = Path(sys.argv[1]), Path(sys.argv[2]), json.loads(Path(sys.argv[3]).read_text())
    parser = run.name
    out.mkdir(parents=True, exist_ok=True)
    by_doc = {}
    for p in wanted:
        by_doc.setdefault(str(p["doc_num"]), []).append(p)
    written = missing = 0
    for doc, ps in sorted(by_doc.items()):
        folder = run / doc
        if not (folder / "native.json.gz").exists():
            missing += len(ps)
            continue
        if parser.startswith("marker"):
            pages = marker_pages((folder / "markdown.md").read_text())
            texts = {p["page_id"]: pages[p["page"] - 1] for p in ps}
        elif parser.startswith("docling"):
            from docling_core.types.doc import DoclingDocument
            document = DoclingDocument.model_validate(json.load(gzip.open(folder / "native.json.gz")))
            texts = {p["page_id"]: document.export_to_markdown(page_no=p["page"]) for p in ps}
        elif parser.startswith("mineru"):
            from mineru.parser.base import ParseResult
            native = json.load(gzip.open(folder / "native.json.gz"))
            texts = {}
            for p in ps:
                one = [page for page in native["pages"] if page["page_idx"] == p["page"] - 1]
                if len(one) != 1:
                    raise ValueError(f"{doc}: page {p['page']} not found once in MinerU's output")
                texts[p["page_id"]] = DATA_URI.sub(r"\1)", ParseResult.from_dict({**native, "pages": one}).markdown())
        else:
            raise SystemExit(f"unknown parser {parser}")
        for page_id, text in texts.items():
            (out / f"{page_id}.md").write_text(text)
            written += 1
    print(f"{run.parent.name}/{parser}: {written} pages written, {missing} without a converted document")


if __name__ == "__main__":
    main()
