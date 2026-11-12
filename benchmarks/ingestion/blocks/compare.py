"""Compare the structure each parser gave the same documents, from the normalised blocks (normalise.py).

    python3 compare.py <run folder> [<run folder> ...]    # writes <first run folder>/structure.md

Counts, not a verdict: what a chunker would get from each parser. Per parser and document: blocks, characters
of text, headings and their distinct levels, list items, tables, figures, page furniture, empty blocks, æøå per
1,000 letters (an OCR that drops the Norwegian letters writes "okonomi" for "økonomi"), and seconds per page.
With several run folders (the same parsers on other hosts), the seconds per page of each host are put side by
side. Standard library only.
"""
import json
import os
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

LETTER = re.compile(r"[^\W\d_]")
NORWEGIAN = re.compile(r"[æøåÆØÅ]")


def stats(folder):
    blocks = [json.loads(line) for line in open(folder / "blocks.jsonl")]
    text = (folder / "text.md").read_text()
    kinds = Counter(b["kind"] for b in blocks)
    letters = len(LETTER.findall(text))
    levels = sorted({b["level"] for b in blocks if b["kind"] == "heading" and b["level"] is not None})
    return {
        "blocks": len(blocks), "chars": len(text),
        "headings": kinds["heading"] + kinds["title"], "levels": levels,
        "list_items": kinds["list_item"], "tables": kinds["table"], "figures": kinds["figure"],
        "furniture": sum(1 for b in blocks if b["furniture"]),
        "empty": sum(1 for b in blocks if not b["furniture"] and not b["text"] and b["kind"] != "figure"),
        "aeoa": round(1000 * len(NORWEGIAN.findall(text)) / letters, 1) if letters else 0.0,
    }


def timings(parser_folder):
    path = parser_folder / "timings.jsonl"
    if not path.exists():
        return {}
    return {r["doc_num"]: r for r in map(json.loads, path.read_text().splitlines())}


def gpu(parser_folder):
    """Peak memory and mean utilisation from the nvidia-smi samples run.sh takes while the parser runs."""
    path = parser_folder / "gpu.csv"
    if not path.exists():
        return ""
    memory, busy = [], []
    for line in path.read_text().splitlines()[1:]:
        fields = [f.strip() for f in line.split(",")]
        if len(fields) >= 3:
            busy.append(float(fields[1].split()[0]))
            memory.append(float(fields[2].split()[0]))
    if not memory:
        return ""
    return f", GPU peak {max(memory):.0f} MiB, {statistics.mean(busy):.0f}% busy"


def main():
    runs = [Path(p) for p in sys.argv[1:]]
    if not runs:
        raise SystemExit(__doc__)
    first = runs[0]
    documents = json.loads((Path(__file__).resolve().parent / os.environ.get("DOCUMENTS", "documents.json")).read_text())["documents"]
    kinds_of = {d["doc_num"]: ", ".join(d["page_kinds"]) for d in documents}
    parsers = sorted(p.name for p in first.iterdir() if (p / "meta.json").exists())
    lines = [f"# Block structure: {', '.join(parsers)}", "",
             f"Run folders: {', '.join(str(r) for r in runs)}. Counts from `blocks.jsonl`; see `normalise.py` for "
             "the block format and `compare.py` for each column.", ""]

    lines += ["## Per parser, all documents", "",
              "| Parser | Documents | Blocks | Characters | Headings | Heading levels | List items | Tables | Furniture | Empty | æøå per 1,000 letters |",
              "| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |"]
    per = {}
    for parser in parsers:
        rows = {f.name: stats(f) for f in sorted((first / parser).iterdir()) if (f / "blocks.jsonl").exists()}
        per[parser] = rows
        total = lambda key: sum(r[key] for r in rows.values())  # noqa: E731
        levels = sorted({level for r in rows.values() for level in r["levels"]})
        letters_rate = statistics.median([r["aeoa"] for r in rows.values()]) if rows else 0
        lines.append(f"| {parser} | {len(rows)} | {total('blocks')} | {total('chars')} | {total('headings')} | "
                     f"{levels} | {total('list_items')} | {total('tables')} | {total('furniture')} | {total('empty')} | "
                     f"{letters_rate} (median) |")

    lines += ["", "## Seconds per page", "",
              "| Parser | " + " | ".join(r.name for r in runs) + " |", "| --- |" + " ---: |" * len(runs)]
    for parser in parsers:
        cells = []
        for run in runs:
            t = timings(run / parser)
            if t:
                pages = sum(r["pages"] for r in t.values())
                seconds = sum(r["seconds"] for r in t.values())
                cells.append(f"{seconds / pages:.2f} ({pages} pages{gpu(run / parser)})")
            else:
                cells.append("–")
        lines.append(f"| {parser} | " + " | ".join(cells) + " |")

    lines += ["", "## Per document", "",
              "| Document | Pages | Parser | Blocks | Characters | Headings | Levels | List items | Tables | Furniture | æøå/1,000 | s/page |",
              "| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |"]
    docs = sorted({d for rows in per.values() for d in rows}, key=lambda d: [x["doc_num"] for x in documents].index(d)
                  if d in kinds_of else 0)
    for doc in docs:
        for parser in parsers:
            r = per[parser].get(doc)
            if not r:
                lines.append(f"| {doc} | {kinds_of.get(doc, '')} | {parser} | failed or missing | | | | | | | | |")
                continue
            t = timings(first / parser).get(doc)
            lines.append(f"| {doc} | {kinds_of.get(doc, '')} | {parser} | {r['blocks']} | {r['chars']} | {r['headings']} | "
                         f"{r['levels']} | {r['list_items']} | {r['tables']} | {r['furniture']} | {r['aeoa']} | "
                         f"{t['seconds_per_page'] if t else '–'} |")
    (first / "structure.md").write_text("\n".join(lines) + "\n")
    print(f"wrote {first / 'structure.md'}")


if __name__ == "__main__":
    main()
