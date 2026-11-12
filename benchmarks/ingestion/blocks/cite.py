"""Cited text as plain text, from the blocks (normalise.py) and a span of the document text.

    python3 cite.py <blocks.jsonl> <start> <end>      # prints the phrase, its sentence and its passage

A citation is a span [start, end) of text.md. The blocks' own offsets give its plain text without the Markdown
around it (no "#" before a heading, no "-" before a list item): only the characters of block text inside the
span, blocks joined by a blank line. Standard library only.
"""
import json
import re
import sys

# Norwegian abbreviations a sentence does not end at ("jf. Innst. 450", "Prop. 115 S", "kap. 3")
ABBREVIATIONS = {
    "jf", "jfr", "innst", "prop", "meld", "st", "nr", "kap", "pkt", "dok", "mv", "m.v", "bl.a", "ca", "f.eks",
    "evt", "inkl", "ekskl", "mill", "mrd", "kr", "pst", "tlf", "dvs", "osv", "etc", "vedr", "ref", "jan", "feb",
    "mar", "apr", "aug", "sep", "sept", "okt", "nov", "des", "s", "e.f", "nkr",
}
SENTENCE_END = re.compile(r"[.!?:](?=\s+[A-ZÆØÅ0-9«\"(])")


def covering(blocks, start, end):
    """The blocks whose text overlaps [start, end), in reading order."""
    return [b for b in sorted(blocks, key=lambda b: b["seq"])
            if b.get("start") is not None and b["start"] < end and b["end"] > start]


def extract(blocks, start, end):
    """The plain text of [start, end): each covered block's text clipped to the span, a blank line between."""
    pieces = []
    for b in covering(blocks, start, end):
        a, z = max(start, b["start"]) - b["start"], min(end, b["end"]) - b["start"]
        pieces.append(b["text"][a:z])
    return "\n\n".join(p for p in pieces if p)


def ends_sentence(text, i):
    """Whether the punctuation at text[i] ends a sentence, rather than an abbreviation or a number."""
    word = re.search(r"([\w.]+)$", text[:i])
    if not word:
        return True
    token = word.group(1).lower().strip(".")
    # "2. Instruksens formål" is an ordinal; "januar 2022. Stortinget" ends a sentence
    return token not in ABBREVIATIONS and not (token.isdigit() and len(token) <= 2)


def sentence(blocks, start, end):
    """(start, end) of the sentence around [start, end), inside the block it starts in."""
    found = covering(blocks, start, end)
    if not found:
        return start, end
    b = found[0]
    text, a, z = b["text"], start - b["start"], min(end, b["end"]) - b["start"]
    begin = 0
    for m in SENTENCE_END.finditer(text, 0, a):
        if ends_sentence(text, m.start()):
            begin = m.end()
    stop = len(text)
    for m in SENTENCE_END.finditer(text, z):
        if ends_sentence(text, m.start()):
            stop = m.end()
            break
    while begin < len(text) and text[begin].isspace():
        begin += 1
    return b["start"] + begin, b["start"] + stop


def quote(blocks, start, end, document=None):
    """What an answer shows for a citation: the phrase, its sentence, the pages and the boxes."""
    s, e = sentence(blocks, start, end)
    found = covering(blocks, start, end)
    return {"phrase": extract(blocks, start, end), "sentence": extract(blocks, s, e),
            "span": [start, end], "sentence_span": [s, e], "document": document,
            "pages": sorted({b["page"] for b in found}),
            "boxes": [{"page": b["page"], "bbox": b["bbox"]} for b in found]}


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    blocks = [json.loads(line) for line in open(sys.argv[1])]
    print(json.dumps(quote(blocks, int(sys.argv[2]), int(sys.argv[3])), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
