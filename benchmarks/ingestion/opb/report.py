"""Compare the graded sides, from results/ and reference/ alone, so the report rebuilds without
rerunning any side.

    report.py      # after score.py; writes results/report.md, report.json and differences.csv

Scores follow the scoring tool: a family's score is the share of its tests passed (text: present and
order; tables: table_cell), and the headline is the mean of the two. Marker is the candidate and KUDOS
the current side. Each difference is Marker minus the other side on the same tests, with a 95%
interval from resampling whole documents (benchlib.stats.compare), and a verdict against MARGIN, which
was set before the run.
"""
import collections
import json

from common_opb import CANARY, PAGES, PUBLISHED, REVIEW_LOG, SIDES, TESTS  # first: puts benchmarks/ on the path
from benchlib import instrument, record, stats, tables
from benchlib.tables import MARK, MINUS, number

SEED = 20261026
MARGIN = 0.02
CANDIDATE, CURRENT = "marker", "kudos"
PAIRS = (("marker", "kudos"), ("marker", "kudos-joined"))
NAMES = {"marker": "Marker", "kudos": "KUDOS as served", "kudos-joined": "KUDOS, page breaks ignored"}
FAMILY = {"present": "text", "order": "text", "table_cell": "tables"}
SCANNED = ("scan+text", "image-only")
TAGS = ("heading", "list", "caption", "footnote", "figure", "multi_column", "table", "tiny", "degraded")
# Rerun an interval with two more seeds when an end lies this close to zero or to minus the margin
BORDER = 0.01
NULL_RUNS, NULL_REPS = 1000, 1000
DAMAGE_SHARES = (0.05, 0.10)

GLOSSARY = tables.GLOSSARY + (
    ("KUDOS text", "the plain text the KUDOS API serves for a document (`/contents`), with a page break "
                   "character between pages. It is the PDF's own text layer, or KUDOS's OCR when the whole "
                   "PDF has none."),
    ("Marker", "the open-source PDF-to-markdown converter genki runs itself. It reads the text layer where "
               "there is one, reads the page image where there isn't, and rebuilds headings and tables."),
    ("Text layer", "the text stored inside a PDF next to what is drawn. A scan has none unless someone ran "
                   "OCR on it."),
    ("Present test", "a passage, heading or figure is in the side's text for that page (a few typing slips "
                     "allowed)."),
    ("Order test", "passage A comes before passage B, as a person reads the page (columns, boxes, footnotes)."),
    ("Table test", "a cell sits in a table under its column heading or beside its row label. Plain text has "
                   "no tables, so KUDOS fails every table test by design: it keeps the numbers, not the grid."),
    ("Headline", "the scoring tool's single score: the mean of the text score and the table score."),
    ("As served / page breaks ignored", "KUDOS's text for page n as genki would cite it, or, for documents "
                                        "whose page breaks don't match the PDF, its whole text on every page."),
)

NOTES = (
    "Marker converted the 150 documents (7,044 pages) in about 7.9 hours on one M3 Pro Mac, about 4 seconds "
    "a page; it read 749 pages from their images. It runs on our own hardware: compute, no fees.",
    "KUDOS's text costs nothing to make on our side: one API call per document.",
)

LIMITS = (
    "A text test that allows a slip or two also passes a single wrong digit inside it, so wrong digits are "
    "caught by the number tests (no slips allowed), not by every passage.",
    "Running headers, footers and page numbers aren't tested.",
    "The tests come from one reading model, checked by a second; no person checked every test.",
    "Slices other than the headline are exploratory: with this many, some differences marked "
    f"{MARK} will be chance.",
)


def require_current(records, tests=TESTS, pages=PAGES):
    """Every side was graded on the same reference and items, and those are the ones in reference/ now."""
    record.require_comparable(records)
    now = {"reference": record.tree_hash([tests]), "items": record.tree_hash([pages])}
    record.require_comparable({**records, "reference/ as it stands": now}, fields=("reference", "items"))


def load():
    records = {s: record.read(PUBLISHED / "sides" / s / "record.json") for s in SIDES}
    require_current(records)
    verdicts = {s: {r["test_id"]: r for r in map(json.loads, open(PUBLISHED / "sides" / s / "verdicts.jsonl"))}
                for s in SIDES}
    stats.pair_items(verdicts)
    meta = {p["page_id"]: p for p in json.loads(PAGES.read_text())}
    tests = {t["id"]: t for f in sorted(TESTS.glob("*.json")) for t in json.loads(f.read_text())["tests"]}
    rows = []
    for tid, k in sorted(verdicts[CURRENT].items()):
        p = meta[k["page_id"]]
        rows.append({"test_id": tid, "page_id": k["page_id"], "doc": k["document"], "type": k["test_type"],
                     "family": FAMILY[k["test_type"]], "tags": set(k["tags"]), "kind": p["pdf_kind"],
                     "reason": p["reason"], "doc_type": p["type"], "test": tests[tid],
                     **{s: verdicts[s][tid]["result"] == "pass" for s in SIDES},
                     **{f"why_{s}": verdicts[s][tid]["why"] for s in SIDES}})
    return rows, records, meta


def units(rows, sides=SIDES):
    """Per document and side: text passed, text tests, table passed, table tests."""
    out = {}
    for r in rows:
        u = out.setdefault(r["doc"], {s: [0, 0, 0, 0] for s in sides})
        i = 0 if r["family"] == "text" else 2
        for s in sides:
            u[s][i] += r[s]
            u[s][i + 1] += 1
    return out


def headline_of(rows):
    """The mean of the families this slice has; None in a resample that lost one of them."""
    present = [i for i, f in ((0, "text"), (2, "tables")) if any(r["family"] == f for r in rows)]

    def metric(us, side):
        rates = []
        for i in present:
            passed = total = 0
            for u in us:
                v = u[side]
                passed += v[i]
                total += v[i + 1]
            if not total:
                return None
            rates.append(passed / total)
        return sum(rates) / len(rates)
    return metric


def all_tests(us, side):
    passed = total = 0
    for u in us:
        v = u[side]
        passed += v[0] + v[2]
        total += v[1] + v[3]
    return passed / total if total else None


def judged(c, a, b, us, metric, label, strata=None):
    """The difference a minus b with its verdict, rerun with two more seeds when an end is near zero or
    minus the margin; borderline when the seeds disagree."""
    d = c.diff(a, b)
    verdict = stats.decide(d, MARGIN)
    near = min(abs(d.low), abs(d.high), abs(d.low + MARGIN), abs(d.high + MARGIN)) < BORDER
    borderline = False
    if near:
        for extra in (1, 2):
            e = stats.compare(us, (a, b), metric, seed=SEED + extra, label=label, strata=strata).diff(a, b)
            if e.significant != d.significant or stats.decide(e, MARGIN) != verdict:
                borderline = True
    return d, verdict, borderline


def slices(rows):
    page_kinds = [("All pages", rows),
                  ("Typical pages (one random page per document)", [r for r in rows if r["reason"] == "random"]),
                  ("Digital pages (text layer in the PDF)", [r for r in rows if r["kind"] == "digital"]),
                  ("Scanned pages (scan with or without a text layer)", [r for r in rows if r["kind"] in SCANNED]),
                  ("Scans with a text layer (OCR'd PDF)", [r for r in rows if r["kind"] == "scan+text"]),
                  ("Scans without a text layer (image only)", [r for r in rows if r["kind"] == "image-only"])]
    text = lambda rs: [r for r in rs if r["family"] == "text"]
    return [
        ("Headline by page kind", "Pages", "headline", page_kinds),
        ("Text tests only, by page kind", "Pages", "all", [(n, text(rs)) for n, rs in page_kinds]),
        ("By test type", "Test type", "all", [(t, [r for r in rows if r["type"] == t])
                                              for t in ("present", "order", "table_cell")]),
        ("Text tests by what the text is", "Tag", "all",
         [(t, [r for r in rows if t in r["tags"] and r["family"] == "text"]) for t in TAGS]),
        ("Headline by document type", "Document type", "headline",
         [(t, [r for r in rows if r["doc_type"] == t]) for t in sorted({r["doc_type"] for r in rows})]),
    ]


def describe(t):
    a = t["args"]
    txt = lambda x: x.get("text", x.get("number", ""))
    if t["test_type"] == "present":
        return f'"{txt(a["content"])}"'
    if t["test_type"] == "order":
        return f'"{txt(a["before"])}" before "{txt(a["after"])}"'
    rest = ", ".join(f'{k} "{txt(v)}"' for k, v in a.items() if k != "cell" and isinstance(v, dict))
    return f'cell "{txt(a["cell"])}" ({rest})'


def short(text, n=140):
    return text if len(text) <= n else text[:n - 3] + "..."


def main():
    rows, records, meta = load()
    docs = {r["doc"] for r in rows}
    page_ids = {r["page_id"] for r in rows}
    lines, data = [], {"tests": len(rows), "pages": len(page_ids), "documents": len(docs), "margin": MARGIN,
                       "seed": SEED, "reps": stats.REPS, "candidate": CANDIDATE, "current": CURRENT,
                       "differences": []}
    w = lines.append
    csv_rows = []

    everything = units(rows)
    head = headline_of(rows)
    overall = stats.compare(everything, SIDES, head, seed=SEED, label="tiers:headline")
    text_rows = [r for r in rows if r["family"] == "text"]
    table_rows = [r for r in rows if r["family"] == "tables"]
    fam = {s: (all_tests(list(units(text_rows).values()), s), all_tests(list(units(table_rows).values()), s),
               all_tests(list(everything.values()), s)) for s in SIDES}
    tiers = stats.tiers(overall)
    data["tiers"] = tiers
    data["sides"] = {s: {"headline": overall.scores[s], "text": fam[s][0], "tables": fam[s][1], "all": fam[s][2]}
                     for s in SIDES}

    groups = []
    for title, label, kind, parts in slices(rows):
        measured = []
        for name, rs in parts:
            if not rs:
                continue
            us = units(rs)
            metric = headline_of(rs) if kind == "headline" else all_tests
            c = stats.compare(us, SIDES, metric, seed=SEED, label=f"{title}:{name}")
            if any(c.scores[s] is None for s in SIDES):
                continue
            pairs = [(a, b, *judged(c, a, b, us, metric, f"{title}:{name}")) for a, b in PAIRS]
            measured.append((name, rs, c, pairs))
            for a, b, d, verdict, borderline in pairs:
                row = {"table": title, "slice": name, "tests": len(rs), "pages": len({r["page_id"] for r in rs}),
                       "documents": c.clusters, "a": a, "b": b, "score_a": c.scores[a], "score_b": c.scores[b],
                       "diff": d.point, "low": d.low, "high": d.high, "p": d.p, "detectable": d.detectable,
                       "verdict": verdict, "significant": d.significant, "borderline": borderline,
                       "few_documents": c.small}
                csv_rows.append(row)
                data["differences"].append(row)
        groups.append((title, label, measured))

    digital = next(x for x in data["differences"] if x["table"] == "Text tests only, by page kind"
                   and x["slice"].startswith("Digital") and x["b"] == CURRENT)
    tier_words = "; ".join(f"tier {i}: " + ", ".join(NAMES[s] for s in t) for i, t in enumerate(tiers, 1))

    w("# Page tests: Marker vs KUDOS text\n")
    w(f"{len(rows)} tests on {len(page_ids)} pages from {len(docs)} documents. The reference is yes/no facts "
      "about each page, written from the page image and never from either text. Marker is the candidate, "
      f"KUDOS the current side, and the margin is {number(MARGIN, 0)} points.\n")

    w("## Answer\n")
    w(f"Ranked by the headline, {tier_words}. On text tests of digital pages, Marker minus KUDOS is "
      f"{tables.signed(digital['diff'])} points (95% interval {tables.interval(digital['low'], digital['high'])}): "
      f"{digital['verdict']} at a {number(MARGIN, 0)}-point margin, and this sample detects differences of "
      f"{number(digital['detectable'])} points or more.\n")

    w("## Tiers (quality only)\n")
    w(tables.table(["Tier", "Side", "Headline", "Text tests", "Table tests", "All tests"],
                   [[str(i), NAMES[s], number(overall.scores[s]), number(fam[s][0]), number(fam[s][1]),
                     number(fam[s][2])] for i, t in enumerate(tiers, 1) for s in t], "llrrrr"))
    w("A side starts a new tier only when it is significantly worse than the top of its tier, after "
      "correcting for every pair compared.\n")

    w("## Paired differences\n")
    w(f"Marker minus each KUDOS variant on the same tests. {MARK} marks an interval that leaves out zero; "
      f"the verdict is against a {number(MARGIN, 0)}-point margin; *borderline* means the verdict or {MARK} "
      "changed when rerun with two other seeds; *few documents* means under 20, where intervals run narrow.\n")
    for title, label, measured in groups:
        w(f"### {title}\n")
        body = []
        for name, rs, c, pairs in measured:
            a, b, d, verdict, borderline = pairs[0]
            flags = ", ".join(x for x, on in (("borderline", borderline), ("few documents", c.small)) if on)
            body.append([name + (f", *{flags}*" if flags else ""), str(len(rs)), str(c.clusters),
                         number(c.scores[a]), number(c.scores[b]), tables.diff_cell(d), verdict,
                         number(d.detectable)])
        w(tables.table([label, "Tests", "Documents", "Marker", "KUDOS", f"Marker {MINUS} KUDOS", "Verdict",
                        "Detectable (points)"], body, "lrrrrllr"))

    w("## When page numbers are ignored\n")
    missing = sorted({r["page_id"] for r in rows if r["why_kudos"] == "no html output"})
    shifted = sorted({r["page_id"] for r in rows if r["kudos"] != r["kudos-joined"]})
    joined = next(x for x in data["differences"] if x["slice"] == "All pages" and x["b"] == "kudos-joined"
                  and x["table"] == "Headline by page kind")
    w(f"KUDOS serves no text at all for {len(missing)} of the {len(page_ids)} pages (their documents have fewer "
      "page breaks than pages). Giving KUDOS each such document's whole text for every page changes the verdict "
      f"of {sum(r['kudos'] != r['kudos-joined'] for r in rows)} tests on {len(shifted)} pages; its headline goes "
      f"from {number(overall.scores['kudos'])} to {number(overall.scores['kudos-joined'])}. Marker against it: "
      f"{tables.signed(joined['diff'])} (95% interval {tables.interval(joined['low'], joined['high'])}).\n")
    data["kudos_missing_pages"] = len(missing)

    w("## Where they disagree\n")
    both = collections.Counter((r["marker"], r["kudos"]) for r in rows)
    w(tables.table(["", "KUDOS passes", "KUDOS fails"],
                   [["**Marker passes**", both[(True, True)], both[(True, False)]],
                    ["**Marker fails**", both[(False, True)], both[(False, False)]]], "lrr"))
    reasons = collections.Counter(
        "table structure" if r["why_kudos"] == "no tables found" else
        "page not served" if r["why_kudos"] == "no html output" else r["type"]
        for r in rows if r["marker"] and not r["kudos"])
    w("Tests only Marker passes, by why KUDOS failed: " +
      ", ".join(f"{k} {v}" for k, v in sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0]))) + ".\n")

    def examples(title, keep, why_side, n=25):
        xs = [r for r in rows if keep(r)]
        w(f"### {title} ({len(xs)})\n")
        for r in xs[:n]:
            w(f"- `{r['test_id']}` ({meta[r['page_id']]['pdf_kind']}, {r['type']}): {describe(r['test'])}. "
              f"Why: {short(r[why_side])}")
        w("")

    examples("Only KUDOS passes", lambda r: r["kudos"] and not r["marker"], "why_marker")
    examples("Only Marker passes, other than table structure and pages not served",
             lambda r: r["marker"] and not r["kudos"] and r["why_kudos"] not in ("no tables found", "no html output"),
             "why_kudos")
    examples("Both fail", lambda r: not r["marker"] and not r["kudos"], "why_marker")

    cov = json.loads((PUBLISHED / "coverage.json").read_text())
    w("## Across all pages of the sample (no reference)\n")
    w(f"Of the {cov['pages']} non-blank pages of the 150 documents, Marker keeps under a tenth of the text "
      f"layer's text on {cov['marker_lost']} pages with at least {cov['lost_min_chars']} characters of text layer "
      f"({number(cov['marker_lost_share'])}% of pages, corpus-weighted); on {cov['marker_lost_picture']} of them "
      "its layout step read the whole page as one picture, and Marker keeps no text from a block it labels as a "
      f"picture. On the {cov['image_only']} scanned pages without a text layer, Marker gives text on "
      f"{cov['image_only_marker']}; KUDOS gives text on the right page on {cov['image_only_kudos']} "
      f"({cov['image_only_kudos_misaligned']} are in documents whose KUDOS page breaks don't match the PDF, so no "
      "page can be cited).\n")
    data["coverage"] = cov

    w("## How the reference was made and checked\n")
    log = [json.loads(l) for l in open(REVIEW_LOG)]
    v = collections.Counter(x["verdict"] for x in log)
    deriv = collections.Counter(r["test"]["derivation"] for r in rows)
    w(f"Writers saw only page images (`reference/writing-tests.md`). A second reader, blind to the results, "
      f"checked the {len(log)} tests the two sides disagree on or both fail (`reference/verifying-tests.md`): ok "
      f"{v['ok']}, fixed {v['fix']}, dropped {v['drop']}. The {both[(True, True)]} tests both pass agree with two "
      "independent extractions. Derivations: " +
      ", ".join(f"{k} {n}" for k, n in sorted(deriv.items(), key=lambda kv: (-kv[1], kv[0]))) + ".\n")
    answers = json.loads((CANARY / "answers.json").read_text())
    checked = [json.loads(l) for l in open(CANARY / "result.jsonl")]
    broken = [r for r in checked if answers[r["test_id"]]["corrupt"]]
    real = [r for r in checked if not answers[r["test_id"]]["corrupt"]]
    w(f"To see whether the check catches mistakes, a fresh reader got {len(checked)} tests: {len(real)} real and "
      f"{len(broken)} broken on purpose (a changed digit, a dropped word, swapped letters in a heading, a reversed "
      f"order), without being told. It caught {sum(r['verdict'] != 'ok' for r in broken)} of {len(broken)} broken "
      f"tests and kept {sum(r['verdict'] == 'ok' for r in real)} of {len(real)} real ones (`reference/canary/`).\n")

    w("## Instrument checks\n")
    pair_units = {k: {"a": u[CANDIDATE], "b": u[CURRENT]} for k, u in units(rows, (CANDIDATE, CURRENT)).items()}
    null_share = instrument.null_runs(pair_units, "a", "b", head, seed=SEED, n=NULL_RUNS, reps=NULL_REPS)
    base = [{**r, "damaged": r["marker"]} for r in rows]
    losses = []
    for share in DAMAGE_SHARES:
        damaged = instrument.damage(base, share, seed=SEED, key=lambda r: r["page_id"],
                                    fail=lambda r: {**r, "damaged": False})
        dmg = stats.compare(units(damaged, ("damaged", "marker")), ("damaged", "marker"), head, seed=SEED,
                            label=f"instrument:damage:{share}")
        dd = dmg.diff("damaged", "marker")
        losses.append((share, dd, stats.decide(dd, MARGIN)))
    w(f"- **No real difference (A/A).** Marker's and KUDOS's results swapped at random within each document, "
      f"{NULL_RUNS} times: the 95% interval left out zero {number(null_share)}% of the time. About 5% is right; "
      "much more would mean the intervals are too narrow.")
    w("- **A known loss.** Marker with every test failed on a seeded share of pages, against intact Marker: " +
      "; ".join(f"{number(share, 0)}% of pages {tables.diff_cell(dd, verdict)}" for share, dd, verdict in losses) +
      ". The guard passes only \"not worse\" or \"better\", so a candidate with either loss would not replace the "
      "current side; \"worse\" needs the whole interval beyond the margin.\n")
    data["instrument"] = {"null_share": null_share, "null_runs": NULL_RUNS, "null_reps": NULL_REPS,
                          "damage": [{"share": share, "diff": dd.point, "low": dd.low, "high": dd.high,
                                      "verdict": verdict} for share, dd, verdict in losses]}

    w("## Limits\n")
    w("\n".join(f"- {l}" for l in LIMITS) + "\n")
    w(tables.glossary(GLOSSARY))
    w(tables.notes(NOTES))

    w("## Run record\n")
    w(tables.table(["Side", "Commit", "Uncommitted changes", "Graded", "Reference", "Scorer", "Side settings"],
                   [[NAMES[s], (r["git"]["commit"] or "none")[:12], {True: "yes", False: "no"}.get(r["git"]["dirty"], "n/a"),
                     r["time"], r["reference"][:12], r["settings"]["scorer"],
                     ", ".join(f"{k} {v}" for k, v in sorted(r["side_settings"].items())
                               if k in ("marker_version", "source"))]
                    for s, r in records.items()], "lllllll"))
    data["records"] = {s: {"commit": r["git"]["commit"], "dirty": r["git"]["dirty"], "time": r["time"],
                           "reference": r["reference"], "items": r["items"], "code": r["code"]}
                       for s, r in records.items()}

    tables.write_text(PUBLISHED / "report.md", "\n".join(lines))
    tables.write_json(PUBLISHED / "report.json", data, sort_keys=False)
    tables.write_csv(PUBLISHED / "differences.csv", csv_rows)
    print(f"wrote {PUBLISHED / 'report.md'}")


if __name__ == "__main__":
    main()
