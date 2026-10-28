"""Compare the embedding models, from results/ and reference/ alone, so the report rebuilds without rerunning
any side.

    report.py   # after publish.py; writes results/report.md, report.json and differences.csv

The primary metric is page MRR on the generated questions by vector search alone: how high the model alone puts
the one page a question was written from. text-embedding-3-large at 1,536 dimensions is the current side. Each
difference is a side minus another on the same questions, with a 95% interval from resampling whole documents
within the sample's strata (benchlib.stats.compare), and a verdict against MARGIN. genki's search without the
planner and the full search with it are secondary views, graded the same way.
"""
import collections
import json

from common_embeddings import CURRENT, PUBLISHED, QUESTIONS, REFERENCE, SIDES, dimensions, name, questions
from benchlib import instrument, record, stats, tables
from benchlib.tables import MARK, MINUS, number

SEED = 20261026
MARGIN = 0.02
# Longer vectors cost more storage and memory than the current side's, so they are not candidates (26 October 2026)
MAX_DIMENSIONS = 1536
# Rerun an interval with two more seeds when an end lies this close to zero or to minus the margin
BORDER = 0.01
NULL_RUNS, NULL_REPS = 1000, 1000
DAMAGE_SHARES = (0.05, 0.10)
VIEWS = {"vectors": "Vector search alone", "search": "genki search, no planner", "full": "Full search with planner"}
# genki's search without the planner taken apart, one step at a time (../chain_steps.sh), for the sides that ran it:
# from the model alone to the whole search, each view on the 600 generated questions
STEP_VIEWS = {
    "vectors": "Vector search alone (exact)",
    "search-vector": "Vector search through genki",
    "search-vector-colbert": "Vector search, then ColBERT",
    "search-fusion": "Keyword and vector search fused",
    "search-fusion-colbert": "Fused, then ColBERT",
    "search-nocolbert": "genki search without ColBERT",
    "search": "genki search",
}
# Each step against the one it adds to
STEP_DIFFS = (
    ("search-vector", "vectors", "genki's vector search (HNSW) instead of exact search"),
    ("search-vector-colbert", "search-vector", "ColBERT on the vector results"),
    ("search-fusion", "search-vector", "Keyword search fused with the vectors"),
    ("search-fusion-colbert", "search-fusion", "ColBERT on the fused results"),
    ("search-nocolbert", "search-fusion", "The rest of genki's search: the metadata search, query-aware boosts, "
                                          "filters guessed from the question (the pilot has no search phrases)"),
    ("search", "search-nocolbert", "ColBERT on the whole search"),
)

GLOSSARY = tables.GLOSSARY + (
    ("Embedding model", "a model that turns a text into a list of numbers (a vector) so that texts with similar "
                        "meaning get similar vectors. It finds passages; it does not write answers."),
    ("Dimensions", "how many numbers each vector has. More can hold more nuance but cost more storage and memory."),
    ("Shortened (@1,024)", "a model trained so its vectors keep their meaning in the first numbers (Matryoshka), "
                           "cut to that many and normalised again. Built here from the full vectors."),
    ("Vector search alone", "the question's vector against every page's vector, exactly, nothing else: the model "
                            "on its own."),
    ("genki search", "genki's retrieval as it runs: keyword and vector search fused, then ColBERT reranking, ten "
                     "passages. With the planner, gpt-4o first rewrites the question into several searches."),
    ("Fusion (RRF)", "merging the keyword and the vector results into one list; reciprocal rank fusion rewards "
                     "passages that rank high in either."),
    ("ColBERT", "a second model that reads the question with each candidate passage and puts them in a new order "
                "(reranking)."),
    ("Page MRR", "how high the right page sits: first place counts 1, second 1/2, third 1/3, not in the list 0, "
                 "averaged over questions and shown on a 0 to 100 scale."),
    ("Recall@k", "the share of questions whose right page (or document) is among the first k results."),
    ("Generated questions", "600 questions gpt-4o wrote, one per randomly drawn page, with that page as the answer. "
                            "Not reviewed by a person."),
    ("Draft questions", "the 76 questions of Kunnskapsassistenten's draft test set that name the document that "
                        "answers them. Not reviewed by a person."),
)

LIMITS = (
    "No person has reviewed the questions. gpt-4o wrote the generated ones from single pages, so they may lean on "
    "the page's own wording, which favours models trained on machine-written questions.",
    "One page counts as right. If another page also answers a generated question, finding it counts as a miss, "
    "the same for every model.",
    "300 documents, with look-alikes added on purpose; all of Kudos has over a hundred times more pages.",
    "The draft questions are near the ceiling, so the full search with the planner separates the models poorly; "
    "the planner was not run on the generated questions, since each search costs a gpt-4o call.",
    "Few Nynorsk questions (99), and most must find a Bokmål page. Slices other than the primary metric are "
    "exploratory: with this many comparisons, some differences marked " + MARK + " will be chance.",
    "One setting of genki's search. Other fusion weights, more candidates or another reranker could change how "
    "much of a model's lead survives.",
    "Qwen3-Embedding-8B at full length (4,096 dimensions) was searched without an index, which pgvector can't build "
    "above 4,000; every other side was searched as genki searches it.",
    "pplx-embed-v1 gives int8 vectors by design and was graded on them; gte-multilingual-base ran its own "
    "repository code under transformers 4.46.",
    "The full-search runs are from four days (23, 24, 26 and 27 October 2026); gpt-4o's planning varies from run to "
    "run, which three rounds per question only partly evens out: see the run-to-run check under Instrument checks.",
    "The run records were written on 26 October 2026, after the runs: their code hash is of the code then, and "
    "the margin and the dimension limit were set after the first two rounds had run.",
    "The search steps were run for two sides only, text-embedding-3-large and pplx-embed-v1-0.6b, on 28 October "
    "2026, after the other runs.",
)


def require_current(records, questions_file=QUESTIONS, reference=REFERENCE):
    """Every side was graded on the same reference and items, and those are the ones in reference/ now."""
    record.require_comparable(records)
    now = {"reference": record.tree_hash([reference]), "items": record.tree_hash([questions_file])}
    record.require_comparable({**records, "reference/ as it stands": now}, fields=("reference", "items"))


def load():
    sides = [s for s in SIDES if (PUBLISHED / "sides" / s / "verdicts.jsonl").exists()]
    records = {s: record.read(PUBLISHED / "sides" / s / "record.json") for s in sides}
    require_current(records)
    verdicts = {s: collections.defaultdict(dict) for s in sides}
    for s in sides:
        for line in open(PUBLISHED / "sides" / s / "verdicts.jsonl"):
            r = json.loads(line)
            verdicts[s][r["view"]][r["item"]] = r
    for view in dict.fromkeys((*VIEWS, *STEP_VIEWS)):
        held = {s: verdicts[s][view] for s in sides if verdicts[s][view]}
        if held:
            stats.pair_items(held)
    return sides, records, verdicts


def score(row, level, metric):
    """The item's score, or None where its view doesn't measure it (the full search: documents only, no
    Recall@1 or Recall@100)."""
    values = row.get(level) if row else None
    return None if values is None or values.get(metric) is None else float(values[metric])


def units(verdicts, sides, view, level, metric, items):
    """Per document and side: the sum and count of the metric over its questions."""
    out = {}
    for q in items:
        u = out.setdefault(q["cluster"], {s: [0.0, 0] for s in sides})
        for s in sides:
            x = score(verdicts[s][view].get(q["item"]), level, metric)
            if x is not None:
                u[s][0] += x
                u[s][1] += 1
    return out


def step_units(verdicts, side, level, metric, items):
    """Per document and view of one side: the sum and count of the metric over its questions."""
    out = {}
    for q in items:
        u = out.setdefault(q["cluster"], {v: [0.0, 0] for v in STEP_VIEWS})
        for v in STEP_VIEWS:
            x = score(verdicts[side][v].get(q["item"]), level, metric)
            if x is not None:
                u[v][0] += x
                u[v][1] += 1
    return out


def mean_of(us, side):
    total = n = 0
    for u in us:
        v = u[side]
        total += v[0]
        n += v[1]
    return total / n if n else None


def judged(c, a, b, us, strata, label):
    """a minus b with its verdict, rerun with two more seeds when an end is near zero or minus the margin."""
    d = c.diff(a, b)
    verdict = stats.decide(d, MARGIN)
    borderline = False
    if min(abs(d.low), abs(d.high), abs(d.low + MARGIN), abs(d.high + MARGIN)) < BORDER:
        for extra in (1, 2):
            e = stats.compare(us, (a, b), mean_of, seed=SEED + extra, label=label, strata=strata).diff(a, b)
            if e.significant != d.significant or stats.decide(e, MARGIN) != verdict:
                borderline = True
    return d, verdict, borderline


def model_of(side):
    """The full-length model a shortened side was cut from, or None."""
    from common_embeddings import model
    m = model(side) if side != CURRENT else None
    return m.get("shortenedFrom") if m else None


def eligible(side):
    return dimensions(side) <= MAX_DIMENSIONS


def main():
    sides, records, verdicts = load()
    qs = questions()
    generated = [q for q in qs if q["set"] == "generated"]
    draft = [q for q in qs if q["set"] == "draft"]
    strata = {q["cluster"]: q["stratum"] for q in qs}
    in_view = {v: [s for s in sides if verdicts[s][v]] for v in VIEWS}
    lines, csv_rows = [], []
    w = lines.append
    data = {"questions": {"generated": len(generated), "draft": len(draft)},
            "documents": len({q["cluster"] for q in qs}), "margin": MARGIN, "max_dimensions": MAX_DIMENSIONS,
            "seed": SEED, "reps": stats.REPS, "current": CURRENT, "sides": {}, "differences": []}

    def comparison(view, items, level, metric, label, layered=True):
        s = [x for x in in_view[view]]
        us = units(verdicts, s, view, level, metric, items)
        st = {c: strata[c] for c in us} if layered else None
        return stats.compare(us, s, mean_of, seed=SEED, label=label, strata=st), us, st

    primary, primary_units, primary_strata = comparison("vectors", generated, "page", "mrr", "primary")
    tiers = stats.tiers(primary)
    data["tiers"] = [[name(s) for s in t] for t in tiers]
    search, search_units, search_strata = comparison("search", generated, "page", "mrr", "search")
    full, full_units, _ = comparison("full", draft, "document", "mrr", "full", layered=False)
    draft_vectors, dv_units, _ = comparison("vectors", draft, "document", "mrr", "draft:vectors", layered=False)

    def against_current(c, us, st, label, view_name):
        out = {}
        for s in c.sides:
            if s == CURRENT:
                continue
            d, verdict, borderline = judged(c, s, CURRENT, us, st, label)
            out[s] = (d, verdict, borderline)
            row = {"view": view_name, "metric": label, "a": s, "b": CURRENT, "score_a": c.scores[s],
                   "score_b": c.scores[CURRENT], "diff": d.point, "low": d.low, "high": d.high, "p": d.p,
                   "detectable": d.detectable, "verdict": verdict, "significant": d.significant,
                   "borderline": borderline, "documents": c.clusters}
            csv_rows.append(row)
            data["differences"].append(row)
        return out

    vs_primary = against_current(primary, primary_units, primary_strata, "primary", VIEWS["vectors"])
    vs_search = against_current(search, search_units, search_strata, "search", VIEWS["search"])
    vs_full = against_current(full, full_units, None, "full", VIEWS["full"])
    for a, b in ((x, y) for i, x in enumerate(primary.sides) for y in primary.sides[i + 1:]):
        d = primary.diff(a, b)
        csv_rows.append({"view": VIEWS["vectors"], "metric": "pairwise", "a": a, "b": b, "score_a": primary.scores[a],
                         "score_b": primary.scores[b], "diff": d.point, "low": d.low, "high": d.high, "p": d.p,
                         "detectable": d.detectable, "verdict": "", "significant": d.significant,
                         "borderline": False, "documents": primary.clusters})

    def mean(view, s, items, level, metric):
        xs = [score(verdicts[s][view].get(q["item"]), level, metric) for q in items]
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None

    for s in sides:
        data["sides"][s] = {"name": name(s), "dimensions": dimensions(s), "eligible": eligible(s), **{
            f"{view}:{level}:{metric}:{subset}": mean(view, s, items, level, metric)
            for view in VIEWS for subset, items in (("generated", generated), ("draft", draft))
            for level in ("page", "document") for metric in ("recall@1", "recall@10", "recall@100", "mrr", "ndcg@10")
            if verdicts[s][view] and mean(view, s, items, level, metric) is not None}}

    candidates = [s for s in sides if s != CURRENT and eligible(s)]
    passing = [s for s in candidates if vs_primary[s][1] in ("better", "not worse")]
    best = max(candidates, key=lambda s: primary.scores[s])
    bd, bv, _ = vs_primary[best]
    tier_words = "; ".join(f"tier {i}: " + ", ".join(name(s) for s in t) for i, t in enumerate(tiers, 1))

    w("# Embedding models for Kudos\n")
    w(f"{len(sides)} embedding models graded on the same {len(generated)} generated and {len(draft)} draft questions "
      f"over the same 20,248 page passages of 300 Kudos documents. text-embedding-3-large at 1,536 dimensions is the "
      f"current side; a candidate has at most {MAX_DIMENSIONS:,} dimensions. The primary metric is page MRR by vector "
      f"search alone, and the margin is {number(MARGIN, 0)} points.\n")

    w("## Answer\n")
    w(f"By vector search alone, {tier_words}. The best candidate within {MAX_DIMENSIONS:,} dimensions, {name(best)}, "
      f"scores {tables.signed(bd.point)} points against text-embedding-3-large (95% interval "
      f"{tables.interval(bd.low, bd.high)}): {bv} at a {number(MARGIN, 0)}-point margin, and this sample detects "
      f"differences of {number(bd.detectable)} points or more. {len(passing)} of {len(candidates)} candidates are "
      "better or not worse; inside genki's search the models end up within a few points of each other.\n")

    w("## Tiers (quality only)\n")
    w(tables.table(
        ["Tier", "Model", "Dimensions", "Page MRR, vectors alone", "Page MRR, genki search", "Document MRR, full search"],
        [[str(i), name(s) + ("" if eligible(s) else " (over the limit)"), f"{dimensions(s):,}",
          number(primary.scores[s]), number(search.scores.get(s)), number(full.scores.get(s))]
         for i, t in enumerate(tiers, 1) for s in t], "llrrrr"))
    w("Tiers come from the primary metric: a model starts a new tier only when it is significantly worse than the "
      "top of its tier, after correcting for every pair compared. The other columns are the secondary views.\n")

    w("## Paired differences against the current side\n")
    w(f"Each model minus text-embedding-3-large on the same questions. {MARK} marks an interval that leaves out zero; "
      f"the verdict is against a {number(MARGIN, 0)}-point margin; *borderline* means the verdict or {MARK} changed "
      "when rerun with two other seeds. Vectors alone and genki search: page MRR on the generated questions; full "
      "search: document MRR on the draft questions.\n")
    body = []
    for s in sorted(vs_primary, key=lambda x: -primary.scores[x]):
        cells = []
        for table_ in (vs_primary, vs_search, vs_full):
            if s not in table_:
                cells.append("n/a")
                continue
            d, verdict, borderline = table_[s]
            cells.append(tables.diff_cell(d, verdict + (", *borderline*" if borderline else "")))
        body.append([name(s) + ("" if eligible(s) else " (over the limit)"), *cells,
                     number(vs_primary[s][0].detectable)])
    w(tables.table(["Model", "Vectors alone", "genki search, no planner", "Full search with planner",
                    "Detectable (points), vectors"], body, "lllll"))
    w("Every pair of models on the primary metric, with its interval, is in `differences.csv` (metric `pairwise`).\n")

    w("## Every view\n")
    w("### Vector search alone\n")
    order = sorted(in_view["vectors"], key=lambda s: -primary.scores[s])
    w(tables.table(["Model", "Dimensions", "Right page first", "Right page in top 10", "Right page in top 100",
                    "Page MRR", "Right document in top 10", "Draft: document MRR"],
                   [[name(s), f"{dimensions(s):,}", number(mean("vectors", s, generated, "page", "recall@1")),
                     number(mean("vectors", s, generated, "page", "recall@10")),
                     number(mean("vectors", s, generated, "page", "recall@100")), number(primary.scores[s]),
                     number(mean("vectors", s, generated, "document", "recall@10")), number(draft_vectors.scores[s])]
                    for s in order], "lrrrrrrr"))
    w("Percentages of the 600 generated questions, except the last column (the 76 draft questions).\n")
    w("### genki search without the planner\n")
    w(tables.table(["Model", "Right page first", "Right page in top 10", "Page MRR", "Right document in top 10",
                    "Draft: document MRR"],
                   [[name(s), number(mean("search", s, generated, "page", "recall@1")),
                     number(mean("search", s, generated, "page", "recall@10")), number(search.scores[s]),
                     number(mean("search", s, generated, "document", "recall@10")),
                     number(mean("search", s, draft, "document", "mrr"))]
                    for s in sorted(in_view["search"], key=lambda x: -search.scores[x])], "lrrrrr"))
    w("### Full search with the planner\n")
    w(tables.table(["Model", "Recall@10", "MRR", "nDCG@10"],
                   [[name(s), number(mean("full", s, draft, "document", "recall@10")), number(full.scores[s]),
                     number(mean("full", s, draft, "document", "ndcg@10"))]
                    for s in sorted(in_view["full"], key=lambda x: -full.scores[x])], "lrrr"))
    w("The 76 draft questions, document level, each averaged over three rounds.\n")
    w("### What genki's search keeps of the vectors\n")
    kept = {s: (mean("vectors", s, generated, "page", "recall@10"), mean("search", s, generated, "page", "recall@10"))
            for s in in_view["search"]}
    w(tables.table(["Model", "Right page in top 10, vectors alone", "In genki's search", "Lost"],
                   [[name(s), number(a), number(b), number(a - b)]
                    for s, (a, b) in sorted(kept.items(), key=lambda kv: -(kv[1][0] - kv[1][1]))], "lrrr"))
    step_sides = [s for s in sides if all(verdicts[s][v] for v in STEP_VIEWS)]
    if step_sides:
        w("### Which step loses the pages\n")
        w("genki's search without the planner taken apart for " + " and ".join(name(s) for s in step_sides) +
          ": vector search or keyword and vector search fused, each with and without ColBERT, then the whole "
          "search without ColBERT. Each step returns ten passages; the vector and fusion steps run one search of "
          "the passages and nothing else.\n")
        metrics = (("recall@10", "Right page in top 10"), ("mrr", "Page MRR"))
        w(tables.table(["Step", *(f"{name(s)}: {label}" for s in step_sides for _, label in metrics)],
                       [[label, *(number(mean(v, s, generated, "page", m)) for s in step_sides for m, _ in metrics)]
                        for v, label in STEP_VIEWS.items()], "l" + "r" * len(step_sides) * len(metrics)))
        body, data["steps"] = [], {}
        compared = {(s, m): stats.compare(step_units(verdicts, s, "page", m, generated), tuple(STEP_VIEWS),
                                          mean_of, seed=SEED, label=f"steps:{s}:{m}", strata=strata)
                    for s in step_sides for m, _ in metrics}
        for a, b, label in STEP_DIFFS:
            cells = []
            for s in step_sides:
                for m, _ in metrics:
                    c = compared[(s, m)]
                    d = c.diff(a, b)
                    cells.append(tables.diff_cell(d))
                    row = {"view": f"search steps, {name(s)}", "metric": f"page {m}", "a": a, "b": b,
                           "score_a": c.scores[a], "score_b": c.scores[b], "diff": d.point, "low": d.low,
                           "high": d.high, "p": d.p, "detectable": d.detectable, "verdict": "",
                           "significant": d.significant, "borderline": False, "documents": c.clusters}
                    csv_rows.append(row)
                    data["steps"].setdefault(s, []).append(row)
            body.append([label, *cells])
        w(tables.table(["What the step adds", *(f"{name(s)}: {label}" for s in step_sides for _, label in metrics)],
                       body, "l" + "l" * len(step_sides) * len(metrics)))
        w(f"Each difference is the step minus the one it adds to, in points, with its 95% interval; {MARK} marks an "
          "interval that leaves out zero.\n")

    w("## Bokmål and Nynorsk (exploratory)\n")
    lang_rows = []
    for language, label in (("nb", "Bokmål"), ("nn", "Nynorsk")):
        items = [q for q in generated if q["language"] == language]
        c, us, st = comparison("vectors", items, "page", "mrr", f"language:{language}")
        data[f"language:{language}"] = {s: c.scores[s] for s in c.sides}
        for s in c.sides:
            if s == CURRENT:
                continue
            d, verdict, borderline = judged(c, s, CURRENT, us, st, f"language:{language}")
            lang_rows.append((s, label, c.scores[s], d))
            csv_rows.append({"view": VIEWS["vectors"], "metric": f"page MRR, {label}", "a": s, "b": CURRENT,
                             "score_a": c.scores[s], "score_b": c.scores[CURRENT], "diff": d.point, "low": d.low,
                             "high": d.high, "p": d.p, "detectable": d.detectable, "verdict": verdict,
                             "significant": d.significant, "borderline": borderline, "documents": c.clusters})
    nn = {s: (score_, d) for s, label, score_, d in lang_rows if label == "Nynorsk"}
    nb = {s: score_ for s, label, score_, d in lang_rows if label == "Bokmål"}
    w(tables.table(["Model", "Bokmål (page MRR)", "Nynorsk (page MRR)", f"Nynorsk {MINUS} text-embedding-3-large"],
                   [[name(s), number(nb[s]), number(nn[s][0]), tables.diff_cell(nn[s][1])]
                    for s in sorted(nn, key=lambda x: -nn[x][0])], "lrrl"))
    w(f"Vector search alone. text-embedding-3-large: Bokmål {number(data['language:nb'][CURRENT])}, Nynorsk "
      f"{number(data['language:nn'][CURRENT])}.\n")

    w("## Where a model loses\n")
    w("Generated questions where one side has the right page in its top 10 by vector search alone and the other "
      "does not.\n")
    top10 = lambda s, q: (score(verdicts[s]["vectors"].get(q["item"]), "page", "recall@10") or 0) > 0
    w(tables.table(["Model", f"Only the model finds it", "Only text-embedding-3-large finds it"],
                   [[name(s), sum(top10(s, q) and not top10(CURRENT, q) for q in generated),
                     sum(top10(CURRENT, q) and not top10(s, q) for q in generated)]
                    for s in order if s != CURRENT], "lrr"))
    for title, keep in ((f"Only {name(best)} finds the page", lambda q: top10(best, q) and not top10(CURRENT, q)),
                        (f"Only text-embedding-3-large finds the page", lambda q: top10(CURRENT, q) and not top10(best, q))):
        xs = [q for q in generated if keep(q)]
        w(f"### {title} ({len(xs)})\n")
        for q in xs[:8]:
            w(f"- `{q['item']}` ({q['language']}): \"{q['question']}\" Page {q['page']} of \"{q['title']}\".")
        w("")

    w("## How the reference was made\n")
    w(f"The reference is `reference/questions.jsonl`: each question with its right page or documents. gpt-4o wrote "
      f"one question per page for {len(generated)} pages drawn at random from the pilot's documents "
      "(`reference/generated-questions.json` keeps its model, seed and the pages it declined), every sixth in "
      "Nynorsk; the page is the answer. The draft questions are Kunnskapsassistenten's draft test set "
      "(`packages/eval/testsets/ka-kudos-draft.yaml`), matched to the pilot's documents by their old ids. No embedding "
      "model, and no search, had a hand in either. No person has reviewed them yet.\n")
    by_stratum = collections.Counter(q["stratum"] for q in generated)
    w("Generated questions by the stratum their document was drawn in: " +
      ", ".join(f"{k} {v}" for k, v in sorted(by_stratum.items())) + ". Intervals resample whole documents within "
      "these strata.\n")

    w("## Instrument checks\n")
    pair_units = {k: {"a": u[best], "b": u[CURRENT]} for k, u in primary_units.items()}
    null_share = instrument.null_runs(pair_units, "a", "b", mean_of, seed=SEED, n=NULL_RUNS, reps=NULL_REPS)
    base_rows = [{"item": q["item"], "cluster": q["cluster"],
                  "rr": score(verdicts[best]["vectors"].get(q["item"]), "page", "mrr")} for q in generated]
    losses = []
    for share in DAMAGE_SHARES:
        damaged = instrument.damage(base_rows, share, seed=SEED, key=lambda r: r["cluster"],
                                    fail=lambda r: {**r, "rr": 0.0})
        intact = {r["item"]: r["rr"] for r in base_rows}
        us = {}
        for r in damaged:
            u = us.setdefault(r["cluster"], {"damaged": [0.0, 0], "intact": [0.0, 0]})
            u["damaged"][0] += r["rr"]
            u["damaged"][1] += 1
            u["intact"][0] += intact[r["item"]]
            u["intact"][1] += 1
        dd = stats.compare(us, ("damaged", "intact"), mean_of, seed=SEED, label=f"instrument:damage:{share}",
                           strata={c: strata[c] for c in us}).diff("damaged", "intact")
        losses.append((share, dd, stats.decide(dd, MARGIN)))
    w(f"- **No real difference (A/A).** {name(best)}'s and text-embedding-3-large's results swapped at random within "
      f"each document, {NULL_RUNS} times: the 95% interval left out zero {number(null_share)}% of the time. About 5% "
      "is right" + ("; a little more means the intervals run slightly narrow, so read an interval that ends near zero "
                    "with care." if null_share > 0.06 else "; much more would mean the intervals are too narrow."))
    w(f"- **A known loss.** {name(best)} with every question missed on a seeded share of documents, against intact: " +
      "; ".join(f"{number(share, 0)}% of documents {tables.diff_cell(dd, verdict)}" for share, dd, verdict in losses) +
      ". A candidate with either loss would not pass as \"not worse\".\n")
    # The full search's run-to-run variation: a shortened model finds the same pages as its full-length model
    # without the planner, so a gap with the planner comes from the run (gpt-4o's plans, the day), not the vectors
    drift = []
    for short, long_ in ((s, m) for s in sides for m in [model_of(s)] if m and m in sides):
        rows_ = []
        for view, items, level, st in (("full", draft, "document", None), ("search", generated, "page", strata)):
            us = units(verdicts, (short, long_), view, level, "mrr", items)
            rows_.append(stats.compare(us, (short, long_), mean_of, seed=SEED, label=f"drift:{view}:{short}",
                                       strata={c: st[c] for c in us} if st else None).diff(short, long_))
        drift.append((short, long_, *rows_))
    if drift:
        w("- **The full search varies from run to run.** A shortened model finds the same pages as its full-length model "
          "without the planner, so a gap between them with the planner comes from the run (gpt-4o plans differently "
          "each time, and the runs are from different days), not from the vectors:")
        w("")
        w(tables.table(["Shortened minus full length", "Full search with planner", "genki search, no planner"],
                       [[f"{name(a)} {MINUS} {name(b)}", tables.diff_cell(f), tables.diff_cell(g)]
                        for a, b, f, g in drift], "lll"))
        data["full_search_drift"] = [{"a": a, "b": b, "full": f.point, "full_low": f.low, "full_high": f.high,
                                      "search": g.point} for a, b, f, g in drift]
    data["instrument"] = {"null_share": null_share, "null_runs": NULL_RUNS, "null_reps": NULL_REPS, "against": best,
                          "damage": [{"share": share, "diff": dd.point, "low": dd.low, "high": dd.high,
                                      "verdict": verdict} for share, dd, verdict in losses]}

    w("## Limits\n")
    w("\n".join(f"- {l}" for l in LIMITS) + "\n")
    w(tables.glossary(GLOSSARY))

    notes = []
    for s in sides:
        t = records[s]["side_settings"].get("timing") or {}
        parts = []
        if t.get("embed_seconds"):
            parts.append(f"embedded the 20,040 distinct pages in {t['embed_seconds'] / 60:.0f} min "
                         f"({t['tokens_per_second']:,.0f} tokens/s, {t['embed_runtime']})")
        if t.get("search_p50_ms"):
            parts.append(f"genki search without the planner p50 {t['search_p50_ms'] / 1000:.1f} s")
        full_ms = sorted(ms for v in verdicts[s]["full"].values() for ms in v.get("latency_ms", []))
        if full_ms:
            parts.append(f"with the planner p50 {stats.latency(full_ms)['p50'] / 1000:.1f} s")
        if parts:
            notes.append(f"{name(s)}: " + "; ".join(parts) + ".")
    calls = sum(len(v.get("latency_ms", [])) for s in sides for v in verdicts[s]["full"].values())
    notes += [
        "Times are from one MacBook Pro (M3 Pro, 36 GB): some runs shared its GPU with another, and a server with a "
        "proper GPU would be many times faster. Shortened models reuse the full model's vectors and embed nothing.",
        "Converting the 306 PDFs with Marker took 19.5 hours, once, for every model.",
        f"Azure OpenAI: text-embedding-3-large for the pilot's ingest ($1.80), gpt-4o writing the questions ($2.50) and "
        f"planning {calls:,} full searches (about ${calls * 4.60 / 1596:.2f}); everything else ran locally, ColBERT on "
        "Digdir's own server.",
    ]
    w(tables.notes(notes))

    w("## Run record\n")
    w(tables.table(["Model", "Commit", "Uncommitted changes", "Published", "Reference", "Runtime", "Scored"],
                   [[name(s), (r["git"]["commit"] or "none")[:12],
                     {True: "yes", False: "no"}.get(r["git"]["dirty"], "n/a"), r["time"], r["reference"][:12],
                     r["side_settings"].get("runtime", ""),
                     "; ".join(f"full search from {v}" if k == "full" else f"{k} {v[:10]}"
                               for k, v in sorted(r["side_settings"].get("scored", {}).items()))]
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
