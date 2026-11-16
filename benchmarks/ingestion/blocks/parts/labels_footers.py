"""Printed page labels, and page headers and footers Docling left in the body, on a sample of a Docling export
(ADR 0055).

    python3 -I labels_footers.py <export root> [files] [seed]      # defaults: 200 files, seed 7

The export root holds `<2 hex>/<sha256>/docling.json` (DoclingDocument JSON). Reads each text item's first `prov`
(page and box) straight from the JSON. Prints one JSON object with two parts:

labels    a page's label is the first furniture text on it that reads as a page number (`12`, `s. 12`, `side 3 av 9`).
          The rule keeps a label when the nearest labelled page within 2 pages before or after has the same offset
          (label minus physical page). `rule_run_coverage` is the share of all pages it keeps a label for.
footers   body text (not furniture) repeated on 3 or more pages of a file, digits folded, with at least one letter:
          `bandonly_*` counts the strings that sit only in the top 10 % or only in the bottom 10 % of the page
          (the strict same-band rule); `contact_*` counts body lines in the bottom 15 % with a phone number, an
          e-mail address or a contact word (saksbehandler, telefon, ...).

Reads the export only, writes nothing, and prints no document text.
"""
import collections
import json
import random
import re
import sys
from pathlib import Path

LABEL_RE = re.compile(r"^(?:s\.|side|page|sida)?\s*(\d{1,4})(?:\s*(?:av|of|/)\s*\d{1,4})?$", re.I)
ROMAN_RE = re.compile(r"^(?:s\.|side|page|sida)?\s*(m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$", re.I)
FURN_LABELS = {"page_footer", "page_header", "page_number"}
PHONE_RE = re.compile(r"(?:\+47[\s.]*\d{2}[\s.]?\d{2}[\s.]?\d{2}[\s.]?\d{2})|(?<![\w/:.,-])(?:\d{8}|\d{2} \d{2} \d{2} \d{2}|\d{3} \d{2} \d{3})(?![\w/.,-])")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
WORD_RE = re.compile(r"\b(?:saksbehandler|telefon|tlf|telefaks|postadresse|besøksadresse|org\.?\s?nr)\b", re.I)


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"\d", "#", s)).strip().lower()


def is_furn(t):
    return t.get("content_layer") == "furniture" or t["label"] in FURN_LABELS


def read_items(d):
    """One item per text with a box: page, text, furniture or not, label, y of its centre (0 bottom, 1 top)."""
    pages = {int(k): v["size"] for k, v in d["pages"].items()}
    items = []
    for t in d["texts"]:
        for p in (t.get("prov") or [])[:1]:
            pg = p["page_no"]
            h = pages.get(pg, {}).get("height") or 842
            bb = p["bbox"]
            y = (bb["t"] + bb["b"]) / 2 / h
            if bb.get("coord_origin") != "BOTTOMLEFT":
                y = 1 - y
            items.append(dict(page=pg, text=(t.get("text") or "").strip(), furn=is_furn(t), label=t["label"], y=y))
    return len(pages), items


def labels(S, offsets, npages, items):
    lab, lab_src, roman_pages = {}, {}, set()
    for it in items:
        if not it["furn"]:
            continue
        m = LABEL_RE.match(it["text"])
        if m and it["page"] not in lab:
            lab[it["page"]] = int(m.group(1))
            lab_src[it["page"]] = it["label"]
        r = ROMAN_RE.match(it["text"]) if it["text"] else None
        if r and r.group(1):
            roman_pages.add(it["page"])
    S["lab_pages"] += len(lab)
    S["lab_differs"] += sum(1 for p, v in lab.items() if v != p)
    off = {p: v - p for p, v in lab.items()}
    if off:
        dom, _ = collections.Counter(off.values()).most_common(1)[0]
        S["agree_dominant"] += sum(1 for o in off.values() if o == dom)
    S["agree_run"] += sum(1 for p, o in off.items() if off.get(p - 1) == o or off.get(p + 1) == o)

    def nearest(p, o, steps):
        for q in steps:
            if q in off:
                return off[q] == o
        return False

    run = {p for p, o in off.items() if nearest(p, o, (p - 1, p - 2)) or nearest(p, o, (p + 1, p + 2))}
    S["agree_run2"] += len(run)
    # runs: consecutive kept labels (gap <= 2) with the same offset
    cur = []
    for p in sorted(run) + [None]:
        if p is not None and cur and p - cur[-1] <= 2 and off[p] == off[cur[-1]]:
            cur.append(p)
            continue
        if cur:
            S["runs"] += 1
            if len(cur) <= 2:
                S["short_runs"] += 1
                S["short_run_pages"] += len(cur)
        cur = [p] if p is not None else []
    for p in run:
        offsets["0" if off[p] == 0 else ("neg" if off[p] < 0 else "pos")] += 1
    for p, v in lab.items():
        inrun = p in run
        if 1900 <= v <= 2100:
            S["year_like"] += 1
            S["year_like_inrun"] += inrun
        if not inrun:
            S["not_run"] += 1
            if lab.get(p - 1) == v or lab.get(p + 1) == v:
                S["const_number"] += 1
                S["const_number_header"] += lab_src[p] == "page_header"
            if v > npages + 50 and not (1900 <= v <= 2100):
                S["wild_jump"] += 1
            if len(lab) == 1:
                S["only_label_in_doc"] += 1
    S["roman_pages"] += len(roman_pages)
    S["roman_pages_unlabelled"] += len(roman_pages - set(lab))
    # numbers in the body, in the top or bottom 8 %, on pages with no furniture label
    seq_offs = {off[p] for p in run}
    body_fit, body_any, body_off = set(), set(), {}
    for it in items:
        if it["furn"] or it["page"] in lab or not (it["y"] < 0.08 or it["y"] > 0.92):
            continue
        m = LABEL_RE.match(it["text"])
        if not m:
            continue
        body_any.add(it["page"])
        o = int(m.group(1)) - it["page"]
        if off.get(it["page"] - 1) == o or off.get(it["page"] + 1) == o or o in seq_offs:
            body_fit.add(it["page"])
        body_off.setdefault(it["page"], o)
    all_off = {**body_off, **off}
    body_run = {p for p, o in body_off.items() if all_off.get(p - 1) == o or all_off.get(p + 1) == o}
    S["body_band_number_pages"] += len(body_any)
    S["body_band_fit_pages"] += len(body_fit)
    S["body_band_run_pages"] += len(body_run)
    S["rule_furn_plus_body_run"] += len(run) + len(body_run - run)


def footers(S, npages, items):
    S["texts"] += len(items)
    S["furn_texts"] += sum(it["furn"] for it in items)
    S["furn_pages"] += len({it["page"] for it in items if it["furn"]})
    pages_by_norm = collections.defaultdict(set)
    bands_by_norm = collections.defaultdict(set)
    for it in items:
        if not it["furn"] and it["text"]:
            k = norm(it["text"])
            pages_by_norm[k].add(it["page"])
            bands_by_norm[k].add("top" if it["y"] > 0.9 else "bot" if it["y"] < 0.1 else "mid")
    rep = {k for k, v in pages_by_norm.items() if len(v) >= 3 and re.search(r"[^\W\d_]", k)}
    S["numeric_only_rep_texts"] += sum(1 for k, v in pages_by_norm.items() if len(v) >= 3 and not re.search(r"[^\W\d_]", k))
    rep_band_only = {k for k in rep if bands_by_norm[k] <= {"top"} or bands_by_norm[k] <= {"bot"}}
    bo_pages, band_rep_pages, band_rep_long_pages = set(), set(), set()
    for it in items:
        if it["furn"] or not it["text"]:
            continue
        k = norm(it["text"])
        if k in rep_band_only:
            S["bandonly_rep_texts"] += 1
            bo_pages.add(it["page"])
        if k not in rep:
            continue
        longish = len(k) >= 10
        if it["y"] < 0.10 or it["y"] > 0.90:
            S["band_rep_texts"] += 1
            band_rep_pages.add(it["page"])
            if longish:
                S["band_rep_texts_len10"] += 1
                band_rep_long_pages.add(it["page"])
        else:
            S["mid_rep_texts"] += 1
            S["mid_rep_texts_len10"] += longish
            S["mid_rep_texts_core"] += 0.15 <= it["y"] <= 0.85
    S["bandonly_rep_pages"] += len(bo_pages)
    S["docs_bandonly"] += bool(bo_pages)
    S["band_rep_pages"] += len(band_rep_pages)
    S["band_rep_long_pages"] += len(band_rep_long_pages)
    S["docs_with_band_rep"] += bool(band_rep_pages)

    contact_doc = contact_furn_doc = strong_doc = False
    contact_pages = set()
    for it in items:
        if it["y"] >= 0.15 or not it["text"]:
            continue
        kinds = [k for k, rx in (("phone", PHONE_RE), ("email", EMAIL_RE), ("word", WORD_RE)) if rx.search(it["text"])]
        if not kinds:
            continue
        if it["furn"]:
            S["contact_furn"] += 1
            contact_furn_doc = True
            continue
        S["contact_body"] += 1
        contact_doc = True
        contact_pages.add(it["page"])
        for k in kinds:
            S["contact_body_" + k] += 1
        S["contact_body_caught_by_rep"] += norm(it["text"]) in rep
        S["contact_body_caught_by_bandonly"] += norm(it["text"]) in rep_band_only
        S["contact_body_in_docs_lt3pages"] += npages < 3
        if len(kinds) >= 2 or "email" in kinds:
            S["contact_body_strong"] += 1
            strong_doc = True
    S["contact_pages"] += len(contact_pages)
    S["docs_contact_body"] += contact_doc
    S["docs_contact_furn"] += contact_furn_doc
    S["docs_contact_strong"] += strong_doc
    S["docs_lt3pages"] += npages < 3


def main(root, count, seed):
    random.seed(seed)
    files = random.sample(sorted(Path(root).glob("*/*/docling.json")), count)
    S, offsets = collections.Counter(), collections.Counter()
    for path in files:
        npages, items = read_items(json.loads(path.read_text()))
        S["docs"] += 1
        S["pages"] += npages
        labels(S, offsets, npages, items)
        footers(S, npages, items)
    P, L = S["pages"], S["lab_pages"]
    pct = lambda a, b: round(100 * a / b, 2) if b else None
    print(json.dumps({
        "seed": seed, "docs": S["docs"], "pages": P,
        "labels": {
            "labelled_pages": L, "labelled_pct": pct(L, P), "differs_pct_of_labelled": pct(S["lab_differs"], L),
            "agree_dominant_pct": pct(S["agree_dominant"], L), "agree_adjacent_pct": pct(S["agree_run"], L),
            "rule_kept_pages": S["agree_run2"], "rule_agree_pct_of_labelled": pct(S["agree_run2"], L),
            "rule_run_coverage_pct": pct(S["agree_run2"], P),
            "rule_plus_body_band_coverage_pct": pct(S["rule_furn_plus_body_run"], P),
            "kept_offsets": dict(offsets), "not_kept": S["not_run"], "runs": S["runs"],
            "short_runs_le2": S["short_runs"], "short_run_pages": S["short_run_pages"],
            "year_like": S["year_like"], "year_like_kept": S["year_like_inrun"],
            "same_number_as_neighbour": S["const_number"], "same_number_in_header": S["const_number_header"],
            "label_over_pages_plus_50": S["wild_jump"], "only_label_in_doc": S["only_label_in_doc"],
            "roman_pages": S["roman_pages"], "roman_pages_unlabelled": S["roman_pages_unlabelled"],
            "body_band8_number_pages": S["body_band_number_pages"], "body_band8_fit_pages": S["body_band_fit_pages"],
            "body_band8_run_pages": S["body_band_run_pages"],
        },
        "footers": {
            "furniture_text_pct": pct(S["furn_texts"], S["texts"]), "pages_with_furniture_pct": pct(S["furn_pages"], P),
            "bandonly_rep_texts": S["bandonly_rep_texts"], "bandonly_rep_pages": S["bandonly_rep_pages"],
            "bandonly_rep_pages_pct": pct(S["bandonly_rep_pages"], P), "docs_bandonly": S["docs_bandonly"],
            "band_rep_texts": S["band_rep_texts"], "band_rep_pages": S["band_rep_pages"],
            "band_rep_pages_pct": pct(S["band_rep_pages"], P), "band_rep_long_pages_pct": pct(S["band_rep_long_pages"], P),
            "docs_with_band_rep": S["docs_with_band_rep"],
            "mid_rep_texts": S["mid_rep_texts"], "mid_rep_texts_len10": S["mid_rep_texts_len10"],
            "mid_rep_texts_core_15_85": S["mid_rep_texts_core"], "numeric_only_rep_strings": S["numeric_only_rep_texts"],
            "contact_body": S["contact_body"],
            "contact_body_kinds": {k: S["contact_body_" + k] for k in ("phone", "email", "word")},
            "contact_pages": S["contact_pages"], "contact_body_strong": S["contact_body_strong"],
            "docs_contact_body": S["docs_contact_body"], "docs_contact_body_pct": pct(S["docs_contact_body"], S["docs"]),
            "docs_contact_strong": S["docs_contact_strong"],
            "contact_body_caught_by_rep": S["contact_body_caught_by_rep"],
            "contact_body_caught_by_bandonly": S["contact_body_caught_by_bandonly"],
            "contact_body_in_docs_lt3pages": S["contact_body_in_docs_lt3pages"],
            "contact_furn": S["contact_furn"], "docs_contact_furn": S["docs_contact_furn"], "docs_lt3pages": S["docs_lt3pages"],
        },
    }, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 200, int(sys.argv[3]) if len(sys.argv) > 3 else 7)
