"""Turn each parser's native output into one block format, the same for every parser, so any chunking can be
run from it without converting again, and every chunk can be cited back to the page and the place it came from.

    python3 normalise.py <run folder>          # every <parser>/<doc_num>/native.json.gz under it

Writes, next to each native.json.gz:

blocks.jsonl   one block per line, in reading order (the format below)
text.md        the document's text: every block that is not page furniture, as Markdown, two newlines apart
pages.json     per page: its size in points and the span of text.md its blocks cover

A block (schema genki.blocks/1):

    id            "<doc_num>:<parser>:<seq>", stable for one conversion
    seq           position in reading order, from 0
    page          page number, from 1
    bbox          [x0, y0, x1, y1] as fractions of the page, origin top left; null when the parser gave none
    kind          title, heading, paragraph, list_item, table, figure, caption, footnote, formula, code,
                  page_header, page_footer, page_number or other
    furniture     true for page headers, footers and numbers: kept, but left out of text.md and of chunks
    level         heading level (title 0, headings from 1), else null
    heading_path  the texts of the headings this block sits under, outermost first
    text          the block's text: plain text, a table as a Markdown table
    html          a table's HTML, else null
    start, end    where text sits in text.md, so a cited phrase can be shown in its context; null for furniture
    native        where the block came from in native.json.gz

A chunker reads blocks.jsonl and groups blocks (by heading, by size, a table on its own); a chunk then carries
its blocks' ids, its pages and boxes, and its span of text.md. Standard library only.
"""
import gzip
import html as htmllib
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

SCHEMA = "genki.blocks/1"
FURNITURE = {"page_header", "page_footer", "page_number"}


# ---------------------------------------------------------------- shared helpers

def clean(text):
    return re.sub(r"[ \t]+", " ", (text or "").replace(" ", " ")).strip()


def cell(text):
    return clean(text).replace("\n", " ").replace("|", "\\|")


def markdown_table(rows):
    """rows: list of lists of cell texts, the first row the header."""
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [[cell(c) for c in r] + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


class HtmlText(HTMLParser):
    """HTML of one block to plain text; tables to rows of cells. Enough for the HTML Marker and MinerU emit."""

    BREAK = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "blockquote", "pre"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.rows, self.row, self.cell, self.spans = [], [], None, None, []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th"):
            self.cell = []
            self.spans.append(int(attrs.get("colspan") or 1))
        elif tag == "br":
            (self.cell if self.cell is not None else self.parts).append("\n" if self.cell is None else " ")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in self.BREAK:
            self.parts.append("\n")
        elif tag == "math":
            (self.cell if self.cell is not None else self.parts).append("$")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            text = clean("".join(self.cell))
            self.row += [text] * (self.spans.pop() if self.spans else 1)
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None
        elif tag in self.BREAK:
            self.parts.append("\n")
        elif tag == "math":
            (self.cell if self.cell is not None else self.parts).append("$")

    def handle_data(self, data):
        (self.cell if self.cell is not None else self.parts).append(data)


def html_text(fragment):
    """(plain text, table rows or None) of an HTML fragment."""
    fragment = re.sub(r"<content-ref[^>]*>(</content-ref>)?", "", fragment or "")
    parser = HtmlText()
    parser.feed(fragment)
    parser.close()
    text = "\n".join(clean(line) for line in "".join(parser.parts).split("\n"))
    text = re.sub(r"\n{2,}", "\n", text).strip()
    return text, (parser.rows or None)


def table_html(rows):
    body = "".join("<tr>" + "".join(f"<td>{htmllib.escape(c)}</td>" for c in r) + "</tr>" for r in rows)
    return f"<table>{body}</table>"


def fraction_box(left, top, right, bottom, width, height):
    if not width or not height:
        return None
    box = [left / width, top / height, right / width, bottom / height]
    return [round(min(max(v, 0.0), 1.0), 4) for v in box]


def raw(page, bbox, kind, text, native, level=None, html=None):
    return {"page": page, "bbox": bbox, "kind": kind, "level": level, "text": text, "html": html, "native": native}


# ---------------------------------------------------------------- Docling (DoclingDocument JSON)

DOCLING_KINDS = {
    "title": "title", "section_header": "heading", "text": "paragraph", "paragraph": "paragraph",
    "list_item": "list_item", "caption": "caption", "footnote": "footnote", "formula": "formula", "code": "code",
    "page_header": "page_header", "page_footer": "page_footer", "reference": "paragraph",
    "checkbox_selected": "paragraph", "checkbox_unselected": "paragraph", "handwritten_text": "paragraph",
}


def docling_grid(data):
    """Rows of cell texts from a Docling table; a spanning cell repeats in Docling's grid."""
    grid = data.get("grid") or []
    if grid:
        return [[c.get("text", "") for c in row] for row in grid]
    rows = [[""] * data.get("num_cols", 0) for _ in range(data.get("num_rows", 0))]
    for c in data.get("table_cells", []):
        for r in range(c["start_row_offset_idx"], c["end_row_offset_idx"]):
            for k in range(c["start_col_offset_idx"], c["end_col_offset_idx"]):
                rows[r][k] = c.get("text", "")
    return rows


def docling_blocks(d):
    sizes = {int(k): (v["size"]["width"], v["size"]["height"]) for k, v in (d.get("pages") or {}).items()}

    def resolve(ref):
        _, collection, index = ref.split("/")
        return d[collection][int(index)]

    def place(item):
        prov = item.get("prov") or []
        if not prov:
            return None, None
        p, b = prov[0]["page_no"], prov[0]["bbox"]
        width, height = sizes.get(p, (None, None))
        if not width:
            return p, None
        if b.get("coord_origin", "BOTTOMLEFT") == "BOTTOMLEFT":
            top, bottom = height - b["t"], height - b["b"]
        else:
            top, bottom = b["t"], b["b"]
        return p, fraction_box(b["l"], top, b["r"], bottom, width, height)

    out, seen = [], set()

    def visit(item):
        ref = item.get("self_ref", "")
        if ref in seen:
            return
        seen.add(ref)
        children = [resolve(c["$ref"]) for c in item.get("children", [])]
        if ref in ("#/body", "#/furniture") or ref.startswith("#/groups/"):
            for child in children:
                visit(child)
            return
        page, bbox = place(item)
        label = item.get("label", "")
        if ref.startswith("#/tables/"):
            for c in item.get("captions", []):
                visit(resolve(c["$ref"]))
            rows = docling_grid(item.get("data") or {})
            kind = "table" if label == "table" else "other"
            out.append(raw(page, bbox, kind, markdown_table(rows), ref, html=table_html(rows) if rows else None))
            for child in children:
                visit(child)
            return
        if ref.startswith("#/pictures/"):
            inside = [c for c in children if c.get("self_ref", "").startswith("#/texts/") and c.get("label") != "caption"]
            for c in inside:
                seen.add(c["self_ref"])
            text = "\n".join(clean(c.get("text")) for c in inside if clean(c.get("text")))
            out.append(raw(page, bbox, "figure", text, ref))
            for child in children:
                visit(child)
            return
        kind = DOCLING_KINDS.get(label, "other")
        text = clean(item.get("text"))
        level = item.get("level") if kind == "heading" else (0 if kind == "title" else None)
        out.append(raw(page, bbox, kind, text, ref, level=level))
        for child in children:
            visit(child)

    visit(d["body"])
    if d.get("furniture"):
        visit(d["furniture"])
    page_sizes = {p: {"width_pt": w, "height_pt": h} for p, (w, h) in sizes.items()}
    return out, page_sizes


# ---------------------------------------------------------------- MinerU (docvortex.middle JSON)

MINERU_KINDS = {
    "text": "paragraph", "ref_text": "paragraph", "aside_text": "paragraph", "index": "paragraph",
    "doc_title": "title", "paragraph_title": "heading", "equation": "formula", "code": "code",
    "header": "page_header", "footer": "page_footer", "page_number": "page_number", "page_footnote": "footnote",
    "table_caption": "caption", "table_footnote": "footnote", "image_caption": "caption",
    "image_footnote": "footnote", "chart_caption": "caption", "chart_footnote": "footnote",
    "code_caption": "caption", "code_footnote": "footnote", "list": "list_item",
}
MINERU_BODIES = {"table_body": "table", "image_body": "figure", "chart_body": "figure", "code_body": "code",
                 "algorithm_body": "code"}


def mineru_spans(content):
    """Text of a block whose content is a list of spans (or a string)."""
    if isinstance(content, str):
        return content
    parts = []
    for span in content or []:
        if not isinstance(span, dict):
            continue
        value = span.get("content", "")
        if not isinstance(value, str):
            value = mineru_spans(value)
        if "equation" in (span.get("type") or ""):
            value = f"${value}$"
        parts.append(value)
    return "".join(parts)


def is_block_list(content):
    return isinstance(content, list) and any(isinstance(c, dict) and "bbox" in c for c in content)


def mineru_blocks(m):
    layout = ((m.get("extensions") or {}).get("docvortex_layout") or {}).get("pages") or []
    page_sizes = {p["page_idx"] + 1: {"width_pt": p.get("width_pt"), "height_pt": p.get("height_pt")} for p in layout}
    out = []

    def box(b):
        bbox = b.get("bbox")
        return [round(v, 4) for v in bbox] if bbox and max(bbox) <= 1.0001 else None

    def emit(block, page, where):
        btype = block.get("type", "")
        content = block.get("content")
        if btype in MINERU_BODIES:
            kind = MINERU_BODIES[btype]
            text = mineru_spans(content)
            if kind == "table":
                plain, rows = html_text(text) if "<t" in text else (text, None)
                out.append(raw(page, box(block), "table", markdown_table(rows) if rows else plain, where,
                               html=text if rows else None))
            else:
                out.append(raw(page, box(block), kind, clean(text), where))
            return
        if btype == "list" and is_block_list(content):
            for i, child in enumerate(content):
                if isinstance(child, dict):
                    out.append(raw(page, box(child) or box(block), "list_item", clean(mineru_spans(child.get("content"))),
                                   f"{where}/content/{i}"))
            return
        if is_block_list(content):  # table, image, chart, code: a group of body, caption and footnote blocks
            for i, child in enumerate(content):
                if isinstance(child, dict):
                    emit(child, page, f"{where}/content/{i}")
            return
        kind = MINERU_KINDS.get(btype, "other")
        level = block.get("level") if kind == "heading" else (0 if kind == "title" else None)
        out.append(raw(page, box(block), kind, clean(mineru_spans(content)), where, level=level))

    for p, page in enumerate(m.get("pages", [])):
        number = page.get("page_idx", p) + 1
        for i, block in enumerate(page.get("blocks", [])):
            emit(block, number, f"pages/{p}/blocks/{i}")
    return out, page_sizes


# ---------------------------------------------------------------- Marker (JSONRenderer output)

MARKER_KINDS = {
    "Text": "paragraph", "TextInlineMath": "paragraph", "Handwriting": "paragraph", "ComplexRegion": "paragraph",
    "SectionHeader": "heading", "ListItem": "list_item", "Table": "table", "Form": "table",
    "TableOfContents": "table", "Figure": "figure", "Picture": "figure", "Caption": "caption",
    "Footnote": "footnote", "Equation": "formula", "Code": "code", "PageHeader": "page_header",
    "PageFooter": "page_footer",
    # Marker 2.1 only
    "Bibliography": "paragraph", "Diagram": "figure", "ChemicalBlock": "figure",
}
MARKER_GROUPS = {"ListGroup", "TableGroup", "FigureGroup", "PictureGroup"}


def marker_blocks(d):
    out, page_sizes = [], {}

    def emit(block, page, size, where):
        btype = block.get("block_type", "")
        if btype in MARKER_GROUPS and block.get("children"):
            for i, child in enumerate(block["children"]):
                emit(child, page, size, f"{where}/children/{i}")
            return
        if btype == "Reference":
            return
        kind = MARKER_KINDS.get(btype, "other")
        text, rows = html_text(block.get("html", ""))
        level = None
        if kind == "heading":
            found = re.search(r"<h([1-6])", block.get("html", ""))
            level = int(found.group(1)) if found else 1
        html = None
        if kind == "table" and rows:
            text, html = markdown_table(rows), re.sub(r"<content-ref[^>]*>(</content-ref>)?", "", block["html"])
        if kind == "list_item":
            text = re.sub(r"^- ", "", text)
        x0, y0, x1, y1 = block.get("bbox") or (0, 0, 0, 0)
        bbox = fraction_box(x0, y0, x1, y1, *size) if block.get("bbox") else None
        out.append(raw(page, bbox, kind, text, where, level=level, html=html))

    for p, page in enumerate(d.get("children", [])):
        x0, y0, x1, y1 = page.get("bbox") or (0, 0, 0, 0)
        size = (x1 - x0, y1 - y0)
        found = re.match(r"/page/(\d+)/", page.get("id", ""))
        number = int(found.group(1)) + 1 if found else p + 1
        page_sizes[number] = {"width_pt": size[0], "height_pt": size[1]}
        for i, block in enumerate(page.get("children") or []):
            emit(block, number, size, f"children/{p}/children/{i}")
    return out, page_sizes


# ---------------------------------------------------------------- the common part

PARSERS = {"docling": docling_blocks, "docling-no": docling_blocks, "mineru": mineru_blocks, "marker": marker_blocks,
           "marker2": marker_blocks, "marker-strip": marker_blocks, "marker-llm": marker_blocks, "docling-tess": docling_blocks, **{f"docling-tess-{v}": docling_blocks for v in ("repair", "nocells", "egret", "noreng", "best")}, "docling-rapid": docling_blocks,
           "mineru-noimg": mineru_blocks}


def markdown_of(block):
    text = block["text"]
    if block["kind"] in ("title", "heading"):
        return "#" * min((block["level"] or 0) + 1, 6) + " ", text
    if block["kind"] == "list_item":
        return "- ", text
    return "", text


def finish(raw_blocks, page_sizes, doc_num, parser):
    """Ids, heading paths and the offsets into text.md; returns (blocks, text, pages)."""
    blocks, pieces, length, headings = [], [], 0, []
    for seq, r in enumerate(raw_blocks):
        block = {"id": f"{doc_num}:{parser}:{seq}", "seq": seq, "page": r["page"], "bbox": r["bbox"],
                 "kind": r["kind"], "furniture": r["kind"] in FURNITURE, "level": r["level"],
                 "heading_path": [], "text": r["text"], "html": r["html"], "start": None, "end": None,
                 "native": r["native"]}
        if block["kind"] in ("title", "heading") and block["text"]:
            level = block["level"] if block["level"] is not None else 1
            while headings and headings[-1][0] >= level:
                headings.pop()
            block["heading_path"] = [h[1] for h in headings]
            headings.append((level, block["text"]))
        else:
            block["heading_path"] = [h[1] for h in headings]
        if not block["furniture"] and block["text"]:
            prefix, text = markdown_of(block)
            if pieces:
                pieces.append("\n\n")
                length += 2
            pieces.append(prefix)
            length += len(prefix)
            block["start"] = length
            pieces.append(text)
            length += len(text)
            block["end"] = length
        blocks.append(block)
    text = "".join(pieces)
    pages = []
    numbers = sorted({b["page"] for b in blocks if b["page"]} | set(page_sizes))
    for n in numbers:
        spans = [(b["start"], b["end"]) for b in blocks if b["page"] == n and b["start"] is not None]
        pages.append({"page": n, **page_sizes.get(n, {"width_pt": None, "height_pt": None}),
                      "start": min(s for s, _ in spans) if spans else None,
                      "end": max(e for _, e in spans) if spans else None,
                      "blocks": sum(1 for b in blocks if b["page"] == n)})
    return blocks, text, pages


def normalise(folder, parser, doc_num):
    with gzip.open(folder / "native.json.gz", "rt", encoding="utf-8") as f:
        native = json.load(f)
    raw_blocks, page_sizes = PARSERS[parser](native)
    blocks, text, pages = finish(raw_blocks, page_sizes, doc_num, parser)
    with open(folder / "blocks.jsonl", "w") as f:
        for b in blocks:
            f.write(json.dumps({"schema": SCHEMA, **b} if b["seq"] == 0 else b, ensure_ascii=False) + "\n")
    (folder / "text.md").write_text(text)
    (folder / "pages.json").write_text(json.dumps(pages, indent=1) + "\n")
    return blocks


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    run = Path(sys.argv[1])
    count = 0
    for native in sorted(run.glob("*/*/native.json.gz")):
        folder = native.parent
        parser = json.loads((folder.parent / "meta.json").read_text())["parser"]
        blocks = normalise(folder, parser, folder.name)
        count += 1
        print(f"{parser} {folder.name}: {len(blocks)} blocks")
    if not count:
        raise SystemExit(f"no native.json.gz under {run}")


if __name__ == "__main__":
    main()
