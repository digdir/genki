"""The data files behind the Kudos benchmark dashboard (genki issue 92), from the result files in .data:
quality per model and search type, model facts and speed, index recall and latency, index builds, scale
estimates, step timings and costs. Each file is a CSV in .data/dashboard.

    .data/embed-venv/bin/python dashboard_data.py
"""
import csv
import json
import re
from datetime import datetime

from common import DATA, HERE

OUT = DATA / "dashboard"
MODELS = json.loads((HERE / "models.json").read_text())["models"]
FACTS = {  # from the models' Hugging Face cards and the Database agent's research (2026-10-23)
    "baseline": ("text-embedding-3-large", "Azure OpenAI (paid per token)", "–", "8,191", "none", "Azure, remote"),
    "borealis": ("NbAiLab/borealis-embed-212m", "NB-License 1.0 (no press-substitution services)", "212M", "8,192", "none", "PyTorch MPS"),
    "bge-m3": ("BAAI/bge-m3", "MIT", "568M", "8,192", "none", "PyTorch MPS"),
    "arctic-l-v2": ("Snowflake/snowflake-arctic-embed-l-v2.0", "Apache-2.0", "568M", "8,192", "query only", "PyTorch MPS"),
    "qwen3-0-6b": ("Qwen/Qwen3-Embedding-0.6B", "Apache-2.0", "0.6B", "32,768", "query only", "MLX"),
    "qwen3-4b": ("Qwen/Qwen3-Embedding-4B", "Apache-2.0", "4B", "32,768", "query only", "MLX"),
    "qwen3-8b": ("Qwen/Qwen3-Embedding-8B", "Apache-2.0", "7.6B", "32,768", "query only", "MLX"),
}


def write(name, rows):
    if not rows:
        return
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / f"{name}.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"{name}.csv: {len(rows)} rows")


def quality():
    rows = []
    for kind, view in (("vectors", "Vector search alone"), ("search", "genki search, no planner")):
        path = DATA / f"{kind}-summary.csv"
        if not path.exists():
            continue
        for r in csv.DictReader(open(path)):
            rows.append({"id": f"{kind}-{r['key']}-{r['language']}-{r['set']}-{r['level']}-{r['metric']}",
                         "view": view, "key": r["key"], "model": r["model"], "dimensions": r["dimensions"],
                         "questions_set": r["set"], "language": r["language"], "level": r["level"],
                         "metric": r["metric"], "score": r["score"], "difference": r["difference"],
                         "ci_low": r["ci_low"], "ci_high": r["ci_high"], "questions": r["questions"]})
    report = DATA / "full-search-report.md"
    if report.exists():
        keys = {f[0]: k for k, f in FACTS.items()}
        for line in report.read_text().splitlines():
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) != 6 or cells[0] in ("Model", "---") or cells[0] not in keys:
                continue
            key = keys[cells[0]]
            for metric, cell in (("recall@10", cells[1]), ("mrr", cells[2]), ("ndcg@10", cells[3])):
                m = re.match(r"([\d.]+)(?: \(([+-]?[\d.]+); ([+-]?[\d.]+) to ([+-]?[\d.]+)\))?", cell)
                score, diff, lo, hi = m.groups()
                rows.append({"id": f"full-{key}-all-draft-document-{metric}", "view": "genki search with planner",
                             "key": key, "model": cells[0],
                             "dimensions": next((str(x["dimensions"]) for x in MODELS if x["key"] == key), "1536"),
                             "questions_set": "draft", "language": "all", "level": "document", "metric": metric,
                             "score": score, "difference": diff or "0", "ci_low": lo or "0", "ci_high": hi or "0",
                             "questions": "76"})
    write("quality", rows)


def models():
    rows = []
    for key, (name, licence, params, max_tokens, prompts, runtime) in FACTS.items():
        m = next((x for x in MODELS if x["key"] == key), None)
        dims = m["dimensions"] if m else 1536
        stats = None
        for f in (f"pre-embed-{key}.json", f"embed-stats-{key}.json"):
            if (DATA / f).exists():
                s = json.loads((DATA / f).read_text())
                if s.get("tokens") and s.get("seconds"):
                    stats = s
                    break
        if key == "baseline":
            run = json.loads(next(DATA.glob("ingest-b56f5e02*.json")).read_text())["run"]
            seconds = (datetime.fromisoformat(run["endedAt"].replace("Z", "+00:00"))
                       - datetime.fromisoformat(run["startedAt"].replace("Z", "+00:00"))).total_seconds()
            stats = {"tokens": 13_504_576, "seconds": seconds}
        state = "done" if (DATA / f"vectors-{key}.json").exists() else "running"
        rows.append({
            "key": key, "model": name, "dimensions": dims, "parameters": params, "licence": licence,
            "max_tokens": max_tokens, "prompts": prompts, "runtime": runtime,
            "embed_tokens": stats["tokens"] if stats else "", "embed_seconds": round(stats["seconds"]) if stats else "",
            "tokens_per_second": round(stats["tokens"] / stats["seconds"]) if stats else "",
            "bytes_per_vector": 2 * dims + 8, "status": state,
        })
    write("models", rows)


def index():
    path = DATA / "index-bench.jsonl"
    rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    recall, builds = [], []
    pairs = {}
    for r in rows:
        if "recall_at_10" in r and "settings" in r:
            setting = " / ".join(s.replace("set ", "") for s in r["settings"] if "iterative" not in s)
            pairs.setdefault((r["size"], r["index"], setting), {})[r["queries"]] = r
        if r.get("step") == "build":
            builds.append({"id": f"{r['size']}-{r['index']}-{r['memory']}", "rows": r["size"], "index": r["index"],
                           "memory": r["memory"], "workers": r["workers"], "seconds": r["seconds"],
                           "index_gb": round(r["index_bytes"] / 1024 ** 3, 2),
                           "outgrew_memory": "yes" if r.get("notices") else "no"})
    for (size, idx, setting), p in pairs.items():
        k, d = p.get("kudos", {}), p.get("dbpedia", {})
        recall.append({"id": f"{size}-{idx}-{setting}", "rows": size, "index": idx, "setting": setting,
                       "recall_kudos": k.get("recall_at_10", ""), "recall_dbpedia": d.get("recall_at_10", ""),
                       "p50_ms": d.get("p50_ms", ""), "p95_ms": d.get("p95_ms", ""),
                       "rows_returned": d.get("returned_mean", "")})
    for r in rows:
        if r.get("index") == "none (exact)":
            recall.append({"id": f"{r['size']}-exact", "rows": r["size"], "index": "none (exact search)", "setting": "",
                           "recall_kudos": 1.0, "recall_dbpedia": 1.0, "p50_ms": r["p50_ms"], "p95_ms": r["p95_ms"],
                           "rows_returned": 10})
    write("index_recall", recall)
    write("index_builds", builds)
    other = [r for r in rows if r.get("step") == "write" or "qps" in r]
    write("index_other", [{"id": f"{r['size']}-{r.get('step', 'qps')}", "rows": r["size"],
                           "what": "write" if r.get("step") == "write" else "throughput",
                           "inserted": r.get("inserted", ""), "insert_rows_per_second": r.get("insert_rows_per_second", ""),
                           "vacuum_seconds": r.get("vacuum_seconds", ""), "clients": r.get("clients", ""),
                           "queries_per_second": r.get("qps", "")} for r in other])


def scale():
    # Estimates from the Database agent's scaling report (2026-10-23): measured bytes per row x count, Azure
    # Edsv5 sizing where the HNSW index is at most half the RAM, Norway East pay-as-you-go prices.
    rows = [
        ("Full Kudos, one vector per page", "2.7M", 1536, 42, 11, "E4 (32 GiB)", 504, 1008),
        ("10M vectors", "10M", 768, 57, 20, "E8 (64 GiB)", 988, 1976),
        ("10M vectors", "10M", 1536, 103, 41, "E16 (128 GiB)", 1978, 3956),
        ("Typesense-like: 26M phrase vectors + 2.7M pages", "28.7M", 384, 94, 41, "E16 (128 GiB)", 1958, 3916),
        ("25M vectors", "25M", 1536, 227, 102, "E32 (256 GiB)", 3955, 7910),
        ("50M vectors", "50M", 768, 204, 102, "E32 (256 GiB)", 3955, 7910),
        ("50M vectors", "50M", 1536, 435, 205, "E48 (384 GiB)", 5972, 11944),
        ("50M vectors, binary-quantised index", "50M", 1536, 460, 25, "E8 (64 GiB)", 1124, 2248),
    ]
    write("scale", [{"id": f"s{i}", "scenario": s, "vectors": v, "dimensions": d, "disk_gb": disk, "index_gb": idx,
                     "azure_compute": sku, "usd_per_month": usd, "usd_per_month_with_ha": ha}
                    for i, (s, v, d, disk, idx, sku, usd, ha) in enumerate(rows)])


def steps():
    from timings import iso, span

    rows = []

    def add(step, what, seconds, rate=""):
        hours = seconds / 3600
        rows.append({"id": f"s{len(rows):02d}", "step": step, "what": what,
                     "minutes": round(seconds / 60, 1), "time": f"{hours:.1f} h" if hours >= 1.5 else f"{seconds / 60:.0f} min",
                     "rate": rate})

    conv = [json.loads(l) for l in (DATA / "conversions.jsonl").read_text().splitlines() if l.strip()]
    done = [r for r in conv if r.get("ok") and not r.get("cached")]
    seconds, pages = sum(r["seconds"] for r in done), sum(r["pages"] for r in done)
    add("Convert PDFs with Marker (once)", f"{len(done)} PDFs, {pages:,} pages", seconds, f"{pages / seconds:.2f} pages/s")
    add("Write questions with gpt-4o", "750 pages, 600 questions", (lambda s: s[1] - s[0])(span(DATA / "gen-questions.log")))
    names = {k: f[0] for k, f in FACTS.items()}
    for key in FACTS:
        for f, how in ((f"pre-embed-{key}.json", "MLX"), (f"embed-stats-{key}.json", "PyTorch MPS")):
            if (DATA / f).exists():
                s = json.loads((DATA / f).read_text())
                if s.get("tokens") and s.get("seconds") and s.get("texts", s.get("passages", 0)) > 1000:
                    add("Embed 20,040 pages", f"{names[key]} ({how})", s["seconds"],
                        f"{s['tokens'] / s['seconds']:,.0f} tokens/s")
                    break
    for path in sorted(DATA.glob("ingest-*.json")):
        d = json.loads(path.read_text())
        run = d["run"]
        if len(d.get("documents", [])) < 300 or not run.get("endedAt"):
            continue
        seconds = (iso(run["endedAt"]) - iso(run["startedAt"])).total_seconds()
        usage = sum(u.get("inputTokens", 0) for u in ((run.get("report") or {}).get("usage") or {}).values())
        dataset = d.get("dataset", "digdir/kudos-next")
        how = "vectors from the cache" if usage < 100_000 else f"{usage / seconds:,.0f} tokens/s over the wall time"
        add("genki ingest of 300 documents", dataset, seconds, how)
    for path in sorted(DATA.glob("vectors-*.json")):
        v = json.loads(path.read_text())
        add("Vector-only scoring, 676 questions", v["model"], v["embed_seconds"] + v["search_ms_p50"] * 676 / 1000,
            f"exact search p50 {v['search_ms_p50']} ms")
    for log, what in (("full-search-small.log", "5 sides x 76 questions x 3 rounds (with planner)"),
                      ("full-search-qwen3-4b.log", "Qwen3-4B, 76 questions x 3 rounds (with planner)"),
                      ("full-search-qwen3-8b.log", "Qwen3-8B, 76 questions x 3 rounds (with planner)"),
                      ("search-small.log", "5 sides x 676 questions (no planner)"),
                      ("search-qwen3-4b.log", "Qwen3-4B, 676 questions (no planner)"),
                      ("search-qwen3-8b.log", "Qwen3-8B, 676 questions (no planner)")):
        if (DATA / log).exists() and "wrote" in (DATA / log).read_text():
            a, b = span(DATA / log)
            add("genki search runs", what, b - a)
    bench = [json.loads(l) for l in (DATA / "index-bench.jsonl").read_text().splitlines() if l.strip()]
    stamps = [iso(r["at"]) for r in bench if "at" in r]
    add("Index and scale benchmark", "100k to 1M vectors, every index", (max(stamps) - min(stamps)).total_seconds())
    write("steps", rows)


def costs():
    write("costs", [
        {"id": "c1", "item": "text-embedding-3-large for the pilot ingest", "volume": "13.5M tokens", "usd": 1.80, "status": "done"},
        {"id": "c2", "item": "gpt-4o planner, retrieval runs before this benchmark", "volume": "≈ 1,230 calls", "usd": 3.60, "status": "done"},
        {"id": "c3", "item": "gpt-4o writing the generated questions", "volume": "750 pages", "usd": 2.50, "status": "done"},
        {"id": "c4", "item": "gpt-4o planner, full search per model", "volume": "1,596 calls", "usd": 4.60, "status": "done"},
        {"id": "c5", "item": "text-embedding-3-large for question vectors", "volume": "≈ 52,000 tokens", "usd": 0.01, "status": "done"},
        {"id": "c6", "item": "Self-hosted models, databases, index benchmark, ColBERT (Digdir's server)", "volume": "on this Mac", "usd": 0, "status": "free"},
    ])


if __name__ == "__main__":
    quality()
    models()
    index()
    scale()
    steps()
    costs()
