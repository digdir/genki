"""Compare other PDF parsers with Marker 1.10.2 (issue 337), from results/ and reference/ alone.

    report_parsers.py      # after score.py; writes results/parsers.md, parsers.json and parsers-differences.csv

The same tests, scores and statistics as report.py, with Marker 1.10.2 as the current side and each parser
graded so far as a candidate. A candidate could replace Marker when it is "not worse" or "better" at the
margin on text tests and on table tests, all pages. Tiers rank every side by the headline. Seconds per page
are a note and never part of the ranking.
"""
import collections
import json

from common_opb import PAGES, PARSERS, PUBLISHED, TESTS  # first: puts benchmarks/ on the path
from benchlib import record, stats, tables
from benchlib.tables import MARK, MINUS, number

import report as base

CURRENT = "marker"
NAMES = {"marker": "Marker 1.10.2", "marker-2.1": "Marker 2.1", "pp-structurev3": "PP-StructureV3",
         "paddleocr-vl": "PaddleOCR-VL-1.6", "mineru": "MinerU 4.1.6", "docling": "Docling 2.146",
         "docling-no": "Docling 2.146, Norwegian OCR",
         "docling-tess": "Docling 2.146, Tesseract Norwegian", "docling-rapid": "Docling 2.146, RapidOCR",
         "docling-easyocr-en": "Docling 2.146, EasyOCR English", "mineru-noimg": "MinerU 4.1.6, no picture descriptions",
         "marker-1.10.2-pages": "Marker 1.10.2, page by page"}

GLOSSARY = base.GLOSSARY + (
    ("Marker 1.10.2", "the converter genki runs today (the Marker service in PR 91), the current side here."),
    ("Marker 2.1", "Marker's next major version: one Surya vision-language model does layout, OCR and tables."),
    ("PP-StructureV3", "PaddleOCR's pipeline of small models: layout, text detection and recognition, tables, "
                       "formulas. It reads the page image, not the text layer."),
    ("PaddleOCR-VL-1.6", "PaddleOCR's layout model plus a 0.9-billion-parameter vision-language model that "
                         "reads each region of the page image."),
    ("MinerU 4.1.6", "OpenDataLab's parser at its default PDF tier (standard): small models plus the "
                     "MinerU2.5-Pro vision-language model, with the text layer where it can use it."),
    ("Docling 2.146", "IBM's parser with its default pipeline: the text layer, a layout model, TableFormer for "
                      "tables, and OCR for pictures."),
    ("Candidate", "a parser that could replace Marker 1.10.2."),
)

LIMITS = base.LIMITS + (
    "Marker 1.10.2's text comes from converting whole documents and splitting them into pages; every other "
    "parser saw one page at a time. The tests check what is on the page, not heading levels or text carried "
    "over from other pages.",
    "Every parser ran on one M3 Pro Mac. Where a parser's vision-language model runs in vLLM on an NVIDIA GPU, "
    "it ran here in MLX (Apple's framework) from the same weights; the outputs can differ in small ways.",
    "Each parser ran with its defaults, plus Norwegian where it takes a language (PP-StructureV3). Docling's "
    "default OCR takes no language and is EasyOCR in English here; three Docling sides change only the OCR: "
    "EasyOCR with Norwegian and English, Tesseract with Norwegian, and RapidOCR with its default models.",
)


def published_sides():
    """Marker 1.10.2 and every parser with a run record in results/."""
    return (CURRENT,) + tuple(s for s in PARSERS if (PUBLISHED / "sides" / s / "record.json").exists())


def load(sides):
    records = {s: record.read(PUBLISHED / "sides" / s / "record.json") for s in sides}
    base.require_current(records)
    verdicts = {s: {r["test_id"]: r for r in map(json.loads, open(PUBLISHED / "sides" / s / "verdicts.jsonl"))}
                for s in sides}
    stats.pair_items(verdicts)
    meta = {p["page_id"]: p for p in json.loads(PAGES.read_text())}
    tests = {t["id"]: t for f in sorted(TESTS.glob("*.json")) for t in json.loads(f.read_text())["tests"]}
    rows = []
    for tid, k in sorted(verdicts[CURRENT].items()):
        p = meta[k["page_id"]]
        rows.append({"test_id": tid, "page_id": k["page_id"], "doc": k["document"], "type": k["test_type"],
                     "family": base.FAMILY[k["test_type"]], "tags": set(k["tags"]), "kind": p["pdf_kind"],
                     "reason": p["reason"], "doc_type": p["type"], "test": tests[tid],
                     **{s: verdicts[s][tid]["result"] == "pass" for s in sides},
                     **{f"why_{s}": verdicts[s][tid]["why"] for s in sides}})
    return rows, records, meta


def seconds_note(records, candidates):
    parts = []
    for s in candidates:
        t = records[s]["side_settings"].get("seconds_per_page")
        if t:
            parts.append(f"{NAMES[s]} median {number(t['median'], 1, 1)} s, 90th percentile {number(t['p90'], 1, 1)} s")
    return ("Seconds per page on the M3 Pro, with up to four parsers sharing it, so slower than alone: "
            + "; ".join(parts) + ". Marker 1.10.2 took about 4 seconds a page on the whole documents. Not part "
            "of the ranking, and no guide to a GPU host (issue 337 has the Azure options).") if parts else None


def main():
    sides = published_sides()
    candidates = sides[1:]
    if not candidates:
        raise SystemExit("no parser graded yet: run the converters, then score.py")
    rows, records, meta = load(sides)
    page_ids = {r["page_id"] for r in rows}
    docs = {r["doc"] for r in rows}
    lines, csv_rows = [], []
    w = lines.append
    data = {"tests": len(rows), "pages": len(page_ids), "documents": len(docs), "margin": base.MARGIN,
            "seed": base.SEED, "reps": stats.REPS, "current": CURRENT, "candidates": list(candidates),
            "differences": []}

    everything = base.units(rows, sides)
    head = base.headline_of(rows)
    overall = stats.compare(everything, sides, head, seed=base.SEED, label="parsers:tiers:headline")
    text_rows = [r for r in rows if r["family"] == "text"]
    table_rows = [r for r in rows if r["family"] == "tables"]
    fam = {s: (base.all_tests(list(base.units(text_rows, sides).values()), s),
               base.all_tests(list(base.units(table_rows, sides).values()), s),
               base.all_tests(list(everything.values()), s)) for s in sides}
    tiers = stats.tiers(overall)
    data["tiers"] = tiers
    data["sides"] = {s: {"headline": overall.scores[s], "text": fam[s][0], "tables": fam[s][1], "all": fam[s][2]}
                     for s in sides}

    # The decision: each candidate minus Marker on text tests and on table tests, all pages
    decision = {}
    for fam_name, rs in (("text", text_rows), ("tables", table_rows)):
        us = base.units(rs, sides)
        c = stats.compare(us, sides, base.all_tests, seed=base.SEED, label=f"parsers:decision:{fam_name}")
        for s in candidates:
            d, verdict, borderline = base.judged(c, s, CURRENT, us, base.all_tests, f"parsers:decision:{fam_name}")
            decision[(s, fam_name)] = (d, verdict, borderline)
    replaces = {s: all(decision[(s, f)][1] in ("not worse", "better") for f in ("text", "tables"))
                for s in candidates}
    data["decision"] = {s: {f: {"diff": decision[(s, f)][0].point, "low": decision[(s, f)][0].low,
                                "high": decision[(s, f)][0].high, "verdict": decision[(s, f)][1],
                                "borderline": decision[(s, f)][2]} for f in ("text", "tables")}
                        | {"could_replace": replaces[s]} for s in candidates}

    groups = []
    for title, label, kind, parts in base.slices(rows):
        measured = []
        for name, rs in parts:
            if not rs:
                continue
            us = base.units(rs, sides)
            metric = base.headline_of(rs) if kind == "headline" else base.all_tests
            c = stats.compare(us, sides, metric, seed=base.SEED, label=f"parsers:{title}:{name}")
            if any(c.scores[s] is None for s in sides):
                continue
            pairs = [(s, *base.judged(c, s, CURRENT, us, metric, f"parsers:{title}:{name}")) for s in candidates]
            measured.append((name, rs, c, pairs))
            for s, d, verdict, borderline in pairs:
                row = {"table": title, "slice": name, "tests": len(rs), "pages": len({r["page_id"] for r in rs}),
                       "documents": c.clusters, "a": s, "b": CURRENT, "score_a": c.scores[s],
                       "score_b": c.scores[CURRENT], "diff": d.point, "low": d.low, "high": d.high, "p": d.p,
                       "detectable": d.detectable, "verdict": verdict, "significant": d.significant,
                       "borderline": borderline, "few_documents": c.small}
                csv_rows.append(row)
                data["differences"].append(row)
        groups.append((title, label, measured))

    m = base.number(base.MARGIN, 0)
    w("# Page tests: other parsers vs Marker 1.10.2\n")
    w(f"{len(rows)} tests on {len(page_ids)} pages from {len(docs)} Kudos documents, the reference of "
      f"`report.md`: yes/no facts about each page, written from the page image. Marker 1.10.2 is the current "
      f"side and every other parser a candidate; the margin is {m} points.\n")

    w("## Answer\n")
    tier_words = "; ".join(f"tier {i}: " + ", ".join(NAMES[s] for s in t) for i, t in enumerate(tiers, 1))
    w(f"Ranked by the headline, {tier_words}.\n")
    for s in candidates:
        t, tb = decision[(s, "text")], decision[(s, "tables")]
        w(f"- **{NAMES[s]}**: text tests {tables.signed(t[0].point)} points against Marker 1.10.2 (95% interval "
          f"{tables.interval(t[0].low, t[0].high)}), {t[1]}; table tests {tables.signed(tb[0].point)} "
          f"({tables.interval(tb[0].low, tb[0].high)}), {tb[1]}. "
          + ("It could replace Marker on quality." if replaces[s] else
             "Not shown to be as good as Marker on " + " and ".join(
                 f"{'text' if f == 'text' else 'table'} tests" for f in ("text", "tables")
                 if decision[(s, f)][1] not in ("not worse", "better")) + "."))
    w("")
    w("Scanned pages are 377 of the 1,933 tests, so a parser can read scans much worse and still pass the rule "
      "on all pages (Marker read about one page in ten of the sample from its image). Each candidate on scans, "
      "headline, against Marker 1.10.2:\n")
    scan_slices = ("Scanned pages (scan with or without a text layer)", "Scans without a text layer (image only)")
    for s in candidates:
        cells = []
        for name in scan_slices:
            x = next((x for x in data["differences"] if x["table"] == "Headline by page kind" and x["slice"] == name
                      and x["a"] == s), None)
            if x is None:
                continue
            diff = ("unreliable" if x["verdict"] == "unreliable" else
                    f"{tables.signed(x['diff'])} ({tables.interval(x['low'], x['high'])})")
            cells.append(f"{name.split(' (')[0].lower()} {number(x['score_a'])} against {number(x['score_b'])}, "
                         f"difference {diff}")
        w(f"- **{NAMES[s]}**: " + "; ".join(cells) + ".")
    w("")
    w("These slices are exploratory and part of no rule: the image-only pages come from 12 documents. They are "
      "here so a parser that loses scans is not chosen on the all-pages verdict alone.\n")
    w(f"A candidate could replace Marker 1.10.2 when it is \"not worse\" or \"better\" at a {m}-point margin on "
      "text tests and on table tests: \"not worse\" needs the whole 95% interval of the paired difference above "
      f"{MINUS}{m} points.\n")

    w("## Tiers (quality only)\n")
    w(tables.table(["Tier", "Side", "Headline", "Text tests", "Table tests", "All tests"],
                   [[str(i), NAMES[s], number(overall.scores[s]), number(fam[s][0]), number(fam[s][1]),
                     number(fam[s][2])] for i, t in enumerate(tiers, 1) for s in t], "llrrrr"))
    w("A side starts a new tier only when it is significantly worse than the top of its tier, after correcting "
      "for every pair compared.\n")

    w("## Paired differences\n")
    w(f"Each candidate minus Marker 1.10.2 on the same tests. {MARK} marks an interval that leaves out zero; the "
      f"verdict is against a {m}-point margin; *borderline* means the verdict or {MARK} changed when rerun with "
      "two other seeds; *few documents* means under 20, where intervals run narrow.\n")
    for title, label, measured in groups:
        w(f"### {title}\n")
        body = []
        for name, rs, c, pairs in measured:
            for s, d, verdict, borderline in pairs:
                flags = ", ".join(x for x, on in (("borderline", borderline), ("few documents", c.small)) if on)
                body.append([name + (f", *{flags}*" if flags else ""), NAMES[s], str(len(rs)), str(c.clusters),
                             number(c.scores[s]), number(c.scores[CURRENT]), tables.diff_cell(d), verdict])
        w(tables.table([label, "Candidate", "Tests", "Documents", "Candidate score", "Marker 1.10.2",
                        f"Candidate {MINUS} Marker", "Verdict"], body, "llrrrrll"))

    w("## Where each candidate and Marker disagree\n")
    for s in candidates:
        both = collections.Counter((r[s], r[CURRENT]) for r in rows)
        only_c = collections.Counter(f'{r["kind"]} {r["type"]}' for r in rows if r[s] and not r[CURRENT])
        only_m = collections.Counter(f'{r["kind"]} {r["type"]}' for r in rows if r[CURRENT] and not r[s])
        failed = records[s]["side_settings"].get("failed_pages") or []
        w(f"### {NAMES[s]}\n")
        w(f"Both pass {both[(True, True)]}, only {NAMES[s]} {both[(True, False)]}, only Marker "
          f"{both[(False, True)]}, both fail {both[(False, False)]}. Pages the parser failed on: "
          f"{len(failed)}{' (' + ', '.join(failed) + ')' if failed else ''}.\n")
        top = lambda cnt: ", ".join(f"{k} {v}" for k, v in cnt.most_common(6)) or "none"
        w(f"- Only {NAMES[s]} passes, by page kind and test type: {top(only_c)}.")
        w(f"- Only Marker passes: {top(only_m)}.\n")
        for title, keep, why in ((f"Only Marker passes", lambda r: r[CURRENT] and not r[s], f"why_{s}"),
                                 (f"Only {NAMES[s]} passes", lambda r: r[s] and not r[CURRENT], f"why_{CURRENT}")):
            xs = [r for r in rows if keep(r)]
            w(f"{title} ({len(xs)}), first 10:\n")
            for r in xs[:10]:
                w(f"- `{r['test_id']}` ({meta[r['page_id']]['pdf_kind']}, {r['type']}): {base.describe(r['test'])}. "
                  f"Why: {base.short(r[why])}")
            w("")

    w("## Limits\n")
    w("\n".join(f"- {l}" for l in LIMITS) + "\n")
    w("The reference, how it was checked, and the instrument checks (A/A and a known loss) are in "
      "[report.md](report.md); they hold for these comparisons too, since every side is graded on the same tests.\n")
    w(tables.glossary(GLOSSARY))
    note = seconds_note(records, candidates)
    w(tables.notes([note] if note else ["No timings recorded."]))

    w("## Run record\n")
    w(tables.table(["Side", "Commit", "Uncommitted changes", "Graded", "Reference", "Version", "Settings"],
                   [[NAMES[s], (r["git"]["commit"] or "none")[:12],
                     {True: "yes", False: "no"}.get(r["git"]["dirty"], "n/a"), r["time"], r["reference"][:12],
                     str(r["side_settings"].get("version") or r["side_settings"].get("marker_version")),
                     tables.plain(json.dumps(r["side_settings"].get("settings"), ensure_ascii=False))]
                    for s, r in records.items()], "lllllll"))
    data["records"] = {s: {"commit": r["git"]["commit"], "dirty": r["git"]["dirty"], "time": r["time"],
                           "reference": r["reference"], "items": r["items"], "code": r["code"],
                           "side_settings": r["side_settings"]} for s, r in records.items()}

    tables.write_text(PUBLISHED / "parsers.md", "\n".join(lines))
    tables.write_json(PUBLISHED / "parsers.json", data, sort_keys=False)
    tables.write_csv(PUBLISHED / "parsers-differences.csv", csv_rows)
    print(f"wrote {PUBLISHED / 'parsers.md'}")


if __name__ == "__main__":
    main()
