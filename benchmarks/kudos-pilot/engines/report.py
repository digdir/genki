"""Compare Typesense and pgvector for Kudos, from results/ and reference/ alone, so the report rebuilds without
rerunning any side.

    report.py   # after publish.py; writes results/report.md, report.json and differences.csv

The primary metric is document Recall@10 as served: the share of the draft questions whose right document is
among the ten passages Kunnskapsassistenten's retrieve-only service returns, averaged over three rounds. Typesense
is the current side and pgvector the candidate. Each difference is one side minus another on the same questions,
with a 95% interval from resampling whole documents (benchlib.stats.compare), and a verdict against MARGIN.
"""
import collections
import json

from common_engines import CANDIDATE, CURRENT, NAMES, PUBLISHED, QUESTIONS, REFERENCE, SIDES, questions
from benchlib import instrument, record, stats, tables
from benchlib.tables import MARK, MINUS, number

SEED = 20261026
MARGIN = 0.02
BORDER = 0.01
NULL_RUNS, NULL_REPS = 1000, 1000
DAMAGE_SHARES = (0.05, 0.10)
PAIRS = ((CANDIDATE, CURRENT), ("typesense-blind", CURRENT), (CANDIDATE, "typesense-blind"))
METRICS = (("recall@10", "Recall@10"), ("recall@5", "Recall@5"), ("mrr", "MRR"), ("ndcg@10", "nDCG@10"))

GLOSSARY = tables.GLOSSARY + (
    ("Typesense", "the search engine Kudos uses today: chunks of each document, plus short search phrases with "
                  "their own vectors that the planner looks up first."),
    ("pgvector", "Postgres with vector search: here one passage per page, keyword and vector search fused (RRF)."),
    ("Planner", "gpt-4o rewriting the question into several searches before searching. With the phrase step, it "
                "first looks up stored phrases and rewords them (two model calls); blind, it writes its searches "
                "in one call."),
    ("ColBERT", "a second, more careful model that re-orders what the search found. Both sides use it."),
    ("As served / credited", "Typesense's chunk ids are not unique across documents, so it can return a passage "
                             "under another document than the one it found. As served counts the document it "
                             "returned; credited also counts every pilot document that holds that chunk (its best "
                             "case)."),
    ("Recall@10", "the share of questions whose right document is among the first ten passages."),
    ("MRR", "how high the right document sits: first place counts 1, second 1/2, not found 0, averaged."),
)

LIMITS = (
    "76 questions on 61 documents: the interval only rules out large differences, and the questions are near "
    "the ceiling for both engines.",
    "The questions were written from Typesense passages, which may favour Typesense, and no person has reviewed "
    "them.",
    "The local Typesense holds only the pilot's documents, copied read-only from the shared test cluster with its "
    "schema; its phrase vectors were recomputed with the same model.",
    "Three rounds per question even out some of gpt-4o's planning variance, not all of it.",
    "Both engines search 299 documents; all of Kudos is about 40,000.",
    "The margin was set on 26 October 2026, after the runs, when the benchmark moved to this layout.",
)


def require_current(records, questions_file=QUESTIONS, reference=REFERENCE):
    record.require_comparable(records)
    now = {"reference": record.tree_hash([reference]), "items": record.tree_hash([questions_file])}
    record.require_comparable({**records, "reference/ as it stands": now}, fields=("reference", "items"))


def load():
    records = {s: record.read(PUBLISHED / "sides" / s / "record.json") for s in SIDES}
    require_current(records)
    verdicts = {s: {r["item"]: r for r in map(json.loads, open(PUBLISHED / "sides" / s / "verdicts.jsonl"))}
                for s in SIDES}
    stats.pair_items(verdicts)
    return records, verdicts


def units(verdicts, view, metric, items, sides=SIDES):
    out = {}
    for q in items:
        u = out.setdefault(q["cluster"], {s: [0.0, 0] for s in sides})
        for s in sides:
            u[s][0] += verdicts[s][q["item"]][view][metric]
            u[s][1] += 1
    return out


def mean_of(us, side):
    total = n = 0
    for u in us:
        total += u[side][0]
        n += u[side][1]
    return total / n if n else None


def judged(c, a, b, us, label):
    d = c.diff(a, b)
    verdict = stats.decide(d, MARGIN)
    borderline = False
    if min(abs(d.low), abs(d.high), abs(d.low + MARGIN), abs(d.high + MARGIN)) < BORDER:
        for extra in (1, 2):
            e = stats.compare(us, (a, b), mean_of, seed=SEED + extra, label=label).diff(a, b)
            if e.significant != d.significant or stats.decide(e, MARGIN) != verdict:
                borderline = True
    return d, verdict, borderline


def main():
    records, verdicts = load()
    qs = questions()
    lines, csv_rows = [], []
    w = lines.append
    data = {"questions": len(qs), "documents": len({q["cluster"] for q in qs}), "margin": MARGIN, "seed": SEED,
            "reps": stats.REPS, "current": CURRENT, "candidate": CANDIDATE, "sides": {}, "differences": []}

    comparisons = {}
    for view in ("served", "credited"):
        for metric, label in METRICS:
            us = units(verdicts, view, metric, qs)
            comparisons[(view, metric)] = (stats.compare(us, SIDES, mean_of, seed=SEED, label=f"{view}:{metric}"), us)
    primary, primary_units = comparisons[("served", "recall@10")]
    tiers = stats.tiers(primary)
    data["tiers"] = [[NAMES[s] for s in t] for t in tiers]
    for s in SIDES:
        data["sides"][s] = {f"{view}:{metric}": comparisons[(view, metric)][0].scores[s]
                            for view in ("served", "credited") for metric, _ in METRICS}

    judged_pairs = {}
    for (view, metric), (c, us) in comparisons.items():
        for a, b in PAIRS:
            d, verdict, borderline = judged(c, a, b, us, f"{view}:{metric}")
            judged_pairs[(view, metric, a, b)] = (d, verdict, borderline)
            row = {"view": view, "metric": metric, "a": a, "b": b, "score_a": c.scores[a], "score_b": c.scores[b],
                   "diff": d.point, "low": d.low, "high": d.high, "p": d.p, "detectable": d.detectable,
                   "verdict": verdict, "significant": d.significant, "borderline": borderline,
                   "documents": c.clusters}
            csv_rows.append(row)
            data["differences"].append(row)

    head, verdict, _ = judged_pairs[("served", "recall@10", CANDIDATE, CURRENT)]
    tier_words = "; ".join(f"tier {i}: " + ", ".join(NAMES[s] for s in t) for i, t in enumerate(tiers, 1))
    w("# Search engines for Kudos: Typesense and pgvector\n")
    w(f"{len(qs)} draft questions on {data['documents']} documents, three rounds each, through Kunnskapsassistenten's "
      "retrieve-only service on a local Typesense holding only the pilot's documents and on pgvector, both reranked "
      f"with ColBERT. Typesense is the current side, pgvector the candidate; the primary metric is document Recall@10 "
      f"as served, and the margin is {number(MARGIN, 0)} points.\n")
    w("## Answer\n")
    w(f"By Recall@10 as served, {tier_words}. pgvector minus Typesense is {tables.signed(head.point)} points (95% "
      f"interval {tables.interval(head.low, head.high)}): {verdict} at a {number(MARGIN, 0)}-point margin, and this "
      f"sample detects differences of {number(head.detectable)} points or more.\n")

    w("## Tiers (quality only)\n")
    w(tables.table(["Tier", "Side", "Recall@10 as served", "Recall@10 credited", "MRR as served", "nDCG@10 as served"],
                   [[str(i), NAMES[s], number(primary.scores[s]),
                     number(comparisons[("credited", "recall@10")][0].scores[s]),
                     number(comparisons[("served", "mrr")][0].scores[s]),
                     number(comparisons[("served", "ndcg@10")][0].scores[s])]
                    for i, t in enumerate(tiers, 1) for s in t], "llrrrr"))
    w("A side starts a new tier only when it is significantly worse than the top of its tier, after correcting "
      "for every pair compared.\n")

    w("## Paired differences\n")
    w(f"{MARK} marks an interval that leaves out zero; the verdict is against a {number(MARGIN, 0)}-point margin; "
      "*borderline* means the verdict or the mark changed when rerun with two other seeds.\n")
    for view, title in (("served", "As served"), ("credited", "Typesense credited with every holder of a chunk")):
        w(f"### {title}\n")
        body = []
        for a, b in PAIRS:
            for metric, label in METRICS:
                d, verdict, borderline = judged_pairs[(view, metric, a, b)]
                body.append([f"{NAMES[a]} {MINUS} {NAMES[b]}", label,
                             tables.diff_cell(d, verdict + (", *borderline*" if borderline else "")),
                             number(d.detectable)])
        w(tables.table(["Pair", "Metric", "Difference", "Detectable (points)"], body, "llll"))

    w("## Where they disagree\n")
    found = lambda s, q: verdicts[s][q["item"]]["served"]["recall@10"]
    only_new = [q for q in qs if found(CANDIDATE, q) == 1 and found(CURRENT, q) == 0]
    only_old = [q for q in qs if found(CURRENT, q) == 1 and found(CANDIDATE, q) == 0]
    w(f"Questions whose right document is in the top ten in every round on one engine and in none on the other: "
      f"pgvector only {len(only_new)}, Typesense only {len(only_old)}.\n")
    for title, xs in (("Only pgvector finds the document", only_new), ("Only Typesense finds the document", only_old)):
        w(f"### {title} ({len(xs)})\n")
        for q in xs[:10]:
            w(f"- `{q['item']}`: \"{q['question']}\" ({q['title']})")
        w("")

    w("## How the reference was made\n")
    w("The reference is `reference/questions.jsonl`: the questions of Kunnskapsassistenten's draft test set "
      "(`packages/eval/testsets/ka-kudos-draft.yaml`) that name the documents that answer them, by their old Typesense "
      "ids, which `../sample.json` maps to KUDOS documents. Two reports KUDOS now holds under new registrations are "
      "matched by title and date, and a hit on either counts. Intervals resample whole documents.\n")

    w("## Instrument checks\n")
    pair_units = {k: {"a": u[CANDIDATE], "b": u[CURRENT]} for k, u in primary_units.items()}
    null_share = instrument.null_runs(pair_units, "a", "b", mean_of, seed=SEED, n=NULL_RUNS, reps=NULL_REPS)
    base = [{"item": q["item"], "cluster": q["cluster"], "x": found(CANDIDATE, q)} for q in qs]
    losses = []
    for share in DAMAGE_SHARES:
        damaged = instrument.damage(base, share, seed=SEED, key=lambda r: r["cluster"], fail=lambda r: {**r, "x": 0.0})
        intact = {r["item"]: r["x"] for r in base}
        us = {}
        for r in damaged:
            u = us.setdefault(r["cluster"], {"damaged": [0.0, 0], "intact": [0.0, 0]})
            u["damaged"][0] += r["x"]
            u["damaged"][1] += 1
            u["intact"][0] += intact[r["item"]]
            u["intact"][1] += 1
        dd = stats.compare(us, ("damaged", "intact"), mean_of, seed=SEED,
                           label=f"instrument:damage:{share}").diff("damaged", "intact")
        losses.append((share, dd, stats.decide(dd, MARGIN)))
    w(f"- **No real difference (A/A).** pgvector's and Typesense's results swapped at random within each document, "
      f"{NULL_RUNS} times: the 95% interval left out zero {number(null_share)}% of the time. About 5% is right" +
      ("; a little more means the intervals run slightly narrow with this few documents, so read an interval that "
       "ends near zero with care." if null_share > 0.06 else "."))
    w("- **A known loss.** pgvector with every question missed on a seeded share of documents, against intact: " +
      "; ".join(f"{number(share, 0)}% of documents {tables.diff_cell(dd, v)}" for share, dd, v in losses) + ".\n")
    data["instrument"] = {"null_share": null_share, "null_runs": NULL_RUNS, "null_reps": NULL_REPS,
                          "damage": [{"share": share, "diff": dd.point, "low": dd.low, "high": dd.high,
                                      "verdict": v} for share, dd, v in losses]}

    w("## Limits\n")
    w("\n".join(f"- {l}" for l in LIMITS) + "\n")
    w(tables.glossary(GLOSSARY))
    notes = []
    for s in SIDES:
        lat = stats.latency([ms for v in verdicts[s].values() for ms in v["latency_ms"]])
        notes.append(f"{NAMES[s]}: {lat['n']} searches, p50 {lat['p50'] / 1000:.1f} s, p95 {lat['p95'] / 1000:.1f} s "
                     "per search, planner included.")
    notes.append("Typesense's phrase step makes a second gpt-4o call before searching; blind planning makes one.")
    w(tables.notes(notes))
    w("## Run record\n")
    w(tables.table(["Side", "Commit", "Uncommitted changes", "Published", "Reference", "Run"],
                   [[NAMES[s], (r["git"]["commit"] or "none")[:12],
                     {True: "yes", False: "no"}.get(r["git"]["dirty"], "n/a"), r["time"], r["reference"][:12],
                     r["side_settings"]["run"]] for s, r in records.items()], "llllll"))
    data["records"] = {s: {"commit": r["git"]["commit"], "dirty": r["git"]["dirty"], "time": r["time"],
                           "reference": r["reference"], "items": r["items"], "code": r["code"]}
                       for s, r in records.items()}
    tables.write_text(PUBLISHED / "report.md", "\n".join(lines))
    tables.write_json(PUBLISHED / "report.json", data, sort_keys=False)
    tables.write_csv(PUBLISHED / "differences.csv", csv_rows)
    print(f"wrote {PUBLISHED / 'report.md'}")


if __name__ == "__main__":
    main()
