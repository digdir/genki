"""Summarize Steps 1-2 into results/summary.json, from results/ and sample.json alone.

Corpus estimates are weighted shares of documents with a 95% interval from resampling documents
within each stratum (benchlib.stats.compare), each estimate with its own seeded draws.
"""
import collections
import csv
import json
import math
import statistics

from common import CHECKS, DATA, RESULTS as R, SAMPLE
from benchlib import stats, tables

SEED = 20261021

docs = list(csv.DictReader(open(R / "docs.csv")))
pages = list(csv.DictReader(open(R / "pages.csv")))
sample = {s["doc_num"]: s for s in json.loads(SAMPLE.read_text())}
pairing_file = R / "pairing-summary.json"
pairing = json.loads(pairing_file.read_text()) if pairing_file.exists() else {"pairing": {}, "kudos_listed": None}


def pct(n, d):
    return round(100 * n / d, 1) if d else None


def med(xs):
    xs = [float(x) for x in xs if x != ""]
    return round(statistics.median(xs), 3) if xs else None


def page_stats(rows):
    return {
        "pages": len(rows),
        "plan_flagged_pct": pct(sum(1 for r in rows if r["flags"]), len(rows)),
        "tuned_flagged_pct": pct(sum(1 for r in rows if r["flags_tuned"]), len(rows)),
        "tuned_by_check_pct": {c: pct(sum(c in r["flags_tuned"].split() for r in rows), len(rows)) for c in CHECKS},
        "median_char_similarity": med(r["similarity"] for r in rows),
        "median_5gram_f1": med(r["shingle_f1"] for r in rows),
        "median_oov_kudos": med(r["oov_kudos"] for r in rows),
        "median_oov_ours": med(r["oov_ours"] for r in rows),
    }


def doc_stats(rows):
    return {
        "docs": len(rows),
        "plan_inspect": sum(r["verdict"] == "inspect by hand" for r in rows),
        "tuned_inspect": sum(r["verdict_tuned"] == "inspect by hand" for r in rows),
    }


def weighted_share(rows, key):
    return math.fsum(float(r["weight"]) for r in rows if key(r)) / math.fsum(float(r["weight"]) for r in rows)


def estimate(label, key):
    units = {d["doc_num"]: d for d in docs}
    c = stats.compare(units, ("docs",), lambda rows, side: weighted_share(rows, key), seed=SEED, label=label,
                      strata={d["doc_num"]: d["stratum"] for d in docs})
    low, high = c.intervals["docs"]
    return {"pct": round(100 * c.scores["docs"], 1), "ci95": [round(100 * low, 1), round(100 * high, 1)]}


def flagged_share_over(threshold):
    return lambda r: int(r["flagged_pages_tuned"]) > threshold * int(r["pdf_pages"])


def missing_in_kudos(p):
    """KUDOS holds under a third of our text on a page where ours has >= 300 characters."""
    return int(p["chars_ours"]) >= 300 and 3 * int(p["chars_kudos"]) < int(p["chars_ours"])


def missing_in_ours(p):
    return int(p["chars_kudos"]) >= 300 and 3 * int(p["chars_ours"]) < int(p["chars_kudos"])


def likely_cause(p):
    hints = p["hints"].split()
    if missing_in_kudos(p) or "no_text_layer" in hints:
        return "Scan or image page"
    if "table" in hints:
        return "Table"
    if "multi_column" in hints:
        return "Multi-column"
    return "Other"


by_doc = collections.defaultdict(list)
for p in pages:
    by_doc[p["doc_num"]].append(p)
flagged = [p for p in pages if p["flags_tuned"]]

# Gate: the hard failures a single-source check can catch (page breaks, image pages).
lost_docs = {p["doc_num"] for p in pages if missing_in_kudos(p)}
table_docs = {p["doc_num"] for p in flagged if likely_cause(p) == "Table"}


def gate_fails(r):
    return r["kudos_page_aligned"] != "True" or r["doc_num"] in lost_docs


DATA.mkdir(parents=True, exist_ok=True)
with open(DATA / "step3-candidates.csv", "w", newline="") as f:
    keep = ("doc_num", "uuid", "type", "page", "pdf_kind", "flags_tuned", "hints", "chars_kudos", "chars_ours",
            "shingle_f1", "ours_words_in_kudos", "numbers_missing_in_kudos", "oov_kudos", "oov_ours",
            "lang_kudos", "lang_ours")
    w = csv.DictWriter(f, fieldnames=[*keep, "likely_cause"])
    w.writeheader()
    w.writerows({**{k: p[k] for k in keep}, "likely_cause": likely_cause(p)} for p in flagged)

summary = {
    "step1_pairing": pairing["pairing"] | {"kudos_listed": pairing["kudos_listed"]},
    "sample": {
        "docs": len(docs),
        "pages": len(pages),
        "by_type": dict(collections.Counter(d["type"] for d in docs)),
        "by_pdf_class": dict(collections.Counter(d["pdf_class"] for d in docs)),
        "by_publish_year": dict(sorted(collections.Counter(d["publish_year"] for d in docs).items())),
        "scan_proxy_vs_measured": dict(collections.Counter(
            f'{"scan?" if sample[d["doc_num"]]["likely_scanned"] else "digital?"} -> {d["pdf_class"]}'
            for d in docs)),
        "page_kinds": dict(collections.Counter(p["pdf_kind"] for p in pages)),
        "pages_without_text_layer": sum(p["text_layer"] != "True" for p in pages),
    },
    "page_alignment": {
        "kudos_matches_pdf": sum(d["kudos_page_aligned"] == "True" for d in docs),
        "ours_matches_pdf": sum(d["ours_page_aligned"] == "True" for d in docs),
        "pages_meta_matches_pdf": sum(str(d["pages_meta"]) == d["pdf_pages"] for d in docs),
        "kudos_mismatches": [
            {k: d[k] for k in ("doc_num", "uuid", "type", "pdf_class", "pdf_pages", "kudos_pages")}
            for d in docs if d["kudos_page_aligned"] != "True"],
        "ours_mismatches": [
            {k: d[k] for k in ("doc_num", "type", "pdf_pages", "ours_pages", "ours_chunks")}
            for d in docs if d["ours_page_aligned"] != "True"],
    },
    "pages_flagged_pct": {
        "plan": {c: pct(sum(c in p["flags"].split() for p in pages), len(pages)) for c in CHECKS}
        | {"any": pct(sum(1 for p in pages if p["flags"]), len(pages))},
        "tuned": {c: pct(sum(c in p["flags_tuned"].split() for p in pages), len(pages)) for c in CHECKS}
        | {"any": pct(len(flagged), len(pages))},
    },
    "verdicts": doc_stats(docs),
    "corpus_estimate_docs_pct": {
        "plan_any_flag": estimate("plan_any_flag", lambda r: r["verdict"] == "inspect by hand"),
        "tuned_any_flag": estimate("tuned_any_flag", lambda r: r["verdict_tuned"] == "inspect by hand"),
        "tuned_over_10pct_pages": estimate("tuned_over_10pct_pages", flagged_share_over(0.10)),
        "tuned_over_25pct_pages": estimate("tuned_over_25pct_pages", flagged_share_over(0.25)),
        "tuned_over_50pct_pages": estimate("tuned_over_50pct_pages", flagged_share_over(0.50)),
        **{f"tuned_{c}": estimate(f"tuned_{c}", lambda r, c=c: int(r[f"tuned_{c}"]) > 0) for c in CHECKS},
    },
    "tuned_flagged_page_share_per_doc": {
        "median_pct": med(100 * int(d["flagged_pages_tuned"]) / int(d["pdf_pages"]) for d in docs),
        "docs_over_10pct": sum(flagged_share_over(0.10)(d) for d in docs),
        "docs_over_25pct": sum(flagged_share_over(0.25)(d) for d in docs),
        "docs_over_50pct": sum(flagged_share_over(0.50)(d) for d in docs),
    },
    "by_pdf_class": {c: page_stats([p for d in docs if d["pdf_class"] == c for p in by_doc[d["doc_num"]]])
                     | doc_stats([d for d in docs if d["pdf_class"] == c])
                     for c in sorted({d["pdf_class"] for d in docs})},
    "by_page_kind": {k: page_stats([p for p in pages if p["pdf_kind"] == k])
                     for k in sorted({p["pdf_kind"] for p in pages})},
    "by_type": {t: page_stats([p for d in docs if d["type"] == t for p in by_doc[d["doc_num"]]])
                | doc_stats([d for d in docs if d["type"] == t])
                for t in sorted({d["type"] for d in docs})},
    "noise": {
        "noise_worse_side": dict(collections.Counter(p["noise_worse"] for p in pages if p["noise_worse"])),
        "pages_with": {
            k: {"kudos": sum(int(p[f"{k}_kudos"]) > 0 for p in pages), "ours": sum(int(p[f"{k}_ours"]) > 0 for p in pages)}
            for k in ("mojibake", "fffd", "ligature", "pua", "nfd", "broken_hyphen", "glued", "spaced_runs",
                      "split_words", "duplicates")},
        "totals": {
            k: {"kudos": sum(int(p[f"{k}_kudos"]) for p in pages), "ours": sum(int(p[f"{k}_ours"]) for p in pages)}
            for k in ("split_words", "spaced_runs", "glued")},
        "median_boilerplate_page_share": {"kudos": med(d["boilerplate_kudos"] for d in docs),
                                          "ours": med(d["boilerplate_ours"] for d in docs)},
    },
    "language": {
        "pairs": {f"{a or '-'}/{b or '-'}": n for (a, b), n in collections.Counter(
            (p["lang_kudos"], p["lang_ours"]) for p in pages).most_common()},
        "low_conf_pages": {"kudos": sum(p["lang_conf_kudos"] != "" and float(p["lang_conf_kudos"]) < 0.75 for p in pages),
                           "ours": sum(p["lang_conf_ours"] != "" and float(p["lang_conf_ours"]) < 0.75 for p in pages)},
    },
    "numbers": {
        "pages_kudos_missing_ours_number": sum(bool(p["numbers_missing_in_kudos"]) for p in pages),
        "pages_ours_missing_kudos_number": sum(bool(p["numbers_missing_in_ours"]) for p in pages),
    },
    "tuned_flagged_pages": {
        "count": len(flagged),
        "hints": dict(collections.Counter(h for p in flagged for h in (p["hints"].split() or ["none"]))),
        "pdf_kind": dict(collections.Counter(p["pdf_kind"] for p in flagged)),
    },
    "kudos_extra_pages_pct": pct(sum("kudos_extra" in p["hints"] for p in pages), len(pages)),
    "missing_content": {
        "kudos": {
            "pages": sum(missing_in_kudos(p) for p in pages),
            "docs": len(lost_docs),
            "docs_corpus_estimate": estimate("missing_in_kudos_docs", lambda r: r["doc_num"] in lost_docs),
            "share_of_our_text_pct": pct(
                sum(int(p["chars_ours"]) - int(p["chars_kudos"]) for p in pages if missing_in_kudos(p)),
                sum(int(p["chars_ours"]) for p in pages)),
        },
        "ours": {
            "pages": sum(missing_in_ours(p) for p in pages),
            "docs": len({p["doc_num"] for p in pages if missing_in_ours(p)}),
        },
    },
    "tuned_flagged_by_cause": {
        "all": dict(collections.Counter(likely_cause(p) for p in flagged)),
        **{t: {"pages": len(by_type), **collections.Counter(likely_cause(p) for p in by_type if p["flags_tuned"])}
           for t in sorted({p["type"] for p in pages})
           for by_type in [[p for p in pages if p["type"] == t]]},
    },
    "gate_docs_corpus_estimate": {
        "page_breaks_or_image_pages": estimate("gate_page_breaks_or_image_pages", gate_fails),
        "plus_flagged_table_pages": estimate("gate_plus_flagged_table_pages", lambda r: gate_fails(r) or r["doc_num"] in table_docs),
    },
}
tables.write_json(R / "summary.json", summary, sort_keys=False)
print(f"wrote {R / 'summary.json'}")
