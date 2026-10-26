"""Compare the vector-only scores of every model (score_vectors.py output) with the baseline,
text-embedding-3-large@1536, for the Kudos pilot (genki issue 92). Paired bootstrap over questions, 10,000
resamples, 95% percentile intervals, as packages/eval/src/stats.ts does.

    .data/embed-venv/bin/python compare_vectors.py          # every .data/vectors-*.json
    .data/embed-venv/bin/python compare_vectors.py search   # every .data/search-*.json (score_search.py)

Writes .data/<vectors|search>-report.md and .data/<vectors|search>-summary.csv.
"""
import csv
import json
import sys

import numpy as np

from common import DATA, HERE

METRICS = [
    ("generated", "page", "recall@1", "Page R@1"),
    ("generated", "page", "recall@10", "Page R@10"),
    ("generated", "page", "recall@100", "Page R@100"),
    ("generated", "page", "mrr", "Page MRR"),
    ("generated", "document", "recall@10", "Doc R@10 (gen.)"),
    ("draft", "document", "recall@10", "Doc R@10 (draft)"),
    ("draft", "document", "mrr", "Doc MRR (draft)"),
]


KIND = sys.argv[1] if len(sys.argv) > 1 else "vectors"


def load():
    order = ["baseline"] + [m["key"] for m in json.loads((HERE / "models.json").read_text())["models"]]
    runs = {}
    for key in order:
        path = DATA / f"{KIND}-{key}.json"
        if path.exists():
            runs[key] = json.loads(path.read_text())
    return runs


def column(run, s, level, metric, language=None):
    return {r["id"]: r[level][metric] for r in run["results"]
            if r["set"] == s and level in r and (language is None or r.get("language") == language)}


def bootstrap(base, other, rng):
    ids = sorted(set(base) & set(other))
    a = np.array([base[i] for i in ids]) * 100
    b = np.array([other[i] for i in ids]) * 100
    diff = b - a
    samples = rng.integers(0, len(ids), size=(10_000, len(ids)))
    means = diff[samples].mean(axis=1)
    return b.mean(), diff.mean(), np.percentile(means, 2.5), np.percentile(means, 97.5), len(ids)


def main():
    runs = load()
    base = runs["baseline"]
    rng = np.random.default_rng(92)
    rows, lines = [], []
    if KIND == "vectors":
        lines.append("# Kudos pilot: embedding models by vector search alone\n")
        lines.append(
            "Each question is embedded with the model's query prompt and the nearest 100 passages are found by exact "
            "search in that model's own database (20,248 page passages from the same Marker text). No planner, "
            "keywords or reranker. ")
    else:
        lines.append("# Kudos pilot: embedding models in genki's search, without the planner\n")
        lines.append(
            "Each question goes as asked to the model's kudos-pilot-<key>-noplan-retrieve-only service: keywords and "
            "vectors fused with RRF, then ColBERT, the answer's ten passages scored. No planner (no model call). ")
    lines[-1] += (
        "Generated questions: one per page, written by gpt-4o, the page is the answer (unreviewed). Draft questions: "
        "the 76 ka-kudos-draft questions with an expected document. Differences are against "
        "text-embedding-3-large@1536, paired bootstrap, 95% interval.\n")
    for language, title in ((None, "All generated questions"), ("nb", "Bokmål only"), ("nn", "Nynorsk only")):
        chosen = METRICS if language is None else [m for m in METRICS if m[0] == "generated"]
        lines.append(f"## {title}\n")
        lines.append("| Model | Dims | " + " | ".join(m[3] for m in chosen) + " |")
        lines.append("| --- | --- | " + " | ".join("---" for _ in chosen) + " |")
        for key, run in runs.items():
            cells = []
            for s, level, metric, label in chosen:
                b = column(base, s, level, metric, language if s == "generated" else None)
                o = column(run, s, level, metric, language if s == "generated" else None)
                if not o:
                    cells.append("–")
                    continue
                mean, diff, lo, hi, n = bootstrap(b, o, rng)
                cells.append(f"{mean:.1f}" if key == "baseline" else f"{mean:.1f} ({diff:+.1f}; {lo:+.1f} to {hi:+.1f})")
                rows.append({"model": run["model"], "key": key, "language": language or "all", "set": s,
                             "level": level, "metric": metric, "score": round(mean, 2),
                             "difference": round(diff, 2) if key != "baseline" else 0,
                             "ci_low": round(lo, 2) if key != "baseline" else 0,
                             "ci_high": round(hi, 2) if key != "baseline" else 0, "questions": n,
                             "dimensions": run["dimensions"]})
            lines.append(f"| {run['model']} | {run['dimensions']} | " + " | ".join(cells) + " |")
        lines.append("")
    lines.append("## Time\n")
    if KIND == "vectors":
        lines.append("| Model | Dims | Passages | Question embedding (s, all questions) | Exact search p50 (ms) |")
        lines.append("| --- | --- | --- | --- | --- |")
        for key, run in runs.items():
            lines.append(f"| {run['model']} | {run['dimensions']} | {run['passages']} | {run['embed_seconds']} | "
                         f"{run['search_ms_p50']} |")
    else:
        lines.append("| Model | Dims | Questions | Errors | p50 per search (ms) | p95 (ms) | Sum of searches (s) |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- |")
        for key, run in runs.items():
            lines.append(f"| {run['model']} | {run['dimensions']} | {run['questions']} | {run['errors']} | "
                         f"{run['latency_ms_p50']} | {run['latency_ms_p95']} | {run['seconds_total']} |")
    report = "\n".join(lines) + "\n"
    (DATA / f"{KIND}-report.md").write_text(report)
    with open(DATA / f"{KIND}-summary.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(report)


if __name__ == "__main__":
    main()
