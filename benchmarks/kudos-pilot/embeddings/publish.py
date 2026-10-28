"""Publish each side's verdicts and run record to results/, from the pilot's scores in .data:

- vectors: score_vectors.py's per-question scores, vector search alone (.data/vectors-<key>.json);
- search: score_search.py's, genki's search without the planner (.data/search-<key>.json);
- search-<step>: the same search cut down to one of common.SEARCH_STEPS (../chain_steps.sh), for the sides that ran
  them (.data/search-<step>-<key>.json);
- full: the full genki search with the planner, from the run files in results/runs/ (kudos-pilot-compare.ts
  `verdicts`: each draft question's document scores averaged over its three rounds).

    publish.py   # after the pilot's runs; then report.py

results/sides/<side>/verdicts.jsonl   one line per question and view: page and document scores
results/sides/<side>/record.json      what the run used: commit, code, reference and items hashes, model settings

A full-search run file for a side that has none in results/runs/ yet is copied from .data, where
kudos-pilot-compare.ts writes it (the newest with three rounds of that side alone).
"""
import datetime
import json
import shutil
import subprocess

from common_embeddings import (BENCHMARK, CURRENT, DATA, PILOT, PUBLISHED, QUESTIONS, REFERENCE, REPO, RUNS, SIDES,
                               compare_side, dimensions, model, pilot_key, questions)
from benchlib import record, tables
from common import SEARCH_STEPS

COMPARE = REPO / "packages" / "eval" / "src" / "scripts" / "kudos-pilot-compare.ts"
CODE = [PILOT / f for f in ("score_vectors.py", "score_search.py", "embed_server.py", "mlx_qwen3.py", "pre_embed.py",
                            "shorten.py", "setup_models.py", "run_model.sh", "common.py", "chain_steps.sh")] + [COMPARE]
PACKAGES = ("sentence-transformers", "transformers", "torch", "mlx", "mlx-lm")
SETTINGS = {
    "documents": 300, "passages": 20248,
    "vectors": "exact search over every page passage in the side's own database, top 100",
    "search": "kudos-pilot-<side>-noplan-retrieve-only: keywords and vectors fused with RRF, ColBERT, 10 passages",
    "full": "kudos-pilot-<side>-retrieve-only: gpt-4o planner, then the same search; 3 rounds of the draft questions",
    "search-<step>": "kudos-pilot-<side>-noplan-<step>-retrieve-only (setup_models.search_step): vector or fusion "
                     "search alone, each with or without ColBERT, or the whole search without ColBERT",
}
METRICS = {"Recall@10": "recall@10", "Recall@5": "recall@5", "MRR": "mrr", "nDCG@10": "ndcg@10"}


def runtime(side):
    if side == CURRENT:
        return {"model": "text-embedding-3-large", "dimensions": 1536, "runtime": "Azure OpenAI (Foundry)"}
    m = model(side)
    how = ("Azure OpenAI (Foundry)" if m.get("catalogModel") else
           f"cut from {m['shortenedFrom']}'s stored vectors" if m.get("shortenedFrom") else
           "MLX (pages), PyTorch MPS (questions)" if m.get("mlx") else "PyTorch MPS")
    return {"model": m["hf"], "revision": m.get("revision"), "dimensions": m["dimensions"], "dtype": m.get("dtype"),
            "prompts": m["prompts"], "runtime": how, "environment": m.get("venv") or (
                None if m.get("catalogModel") else "embed-venv"),
            "remote_code": m.get("trustRemoteCode", False), "shortened_from": m.get("shortenedFrom"),
            "catalog_model": m.get("catalogModel")}


def timing(side):
    """How long the side took, for the report's notes (never its ranking): page embedding, question embedding,
    exact search and genki's search without the planner, from the pilot's stats files."""
    key, m, t = pilot_key(side), model(side), {}
    # A model ingested again (pplx-0-6b: its first ingest lost two documents) keeps its full run's stats aside
    for f, how in ((f"pre-embed-{key}.json", "MLX"), (f"embed-stats-{key}.json", "PyTorch MPS"),
                   (f"embed-stats-{key}-first-ingest.json", "PyTorch MPS")):
        path = DATA / f
        if not path.exists():
            continue
        s = json.loads(path.read_text())
        if s.get("tokens") and s.get("seconds") and s.get("texts", s.get("passages", 0)) > 1000:
            t.update(embed_seconds=round(s["seconds"], 1), embed_tokens=s["tokens"],
                     tokens_per_second=round(s["tokens"] / s["seconds"]), embed_runtime=f"{how} {m['dtype']}")
            break
    dataset = "digdir/kudos-next" if side == CURRENT else f"digdir/kudos-next-{side}"
    if not t and (side == CURRENT or m.get("catalogModel")):
        for path in sorted(DATA.glob("ingest-*.json")):
            d = json.loads(path.read_text())
            run = d["run"]
            usage = sum(u.get("inputTokens", 0) for u in ((run.get("report") or {}).get("usage") or {}).values())
            if d.get("dataset", "digdir/kudos-next") == dataset and usage > 1_000_000 and run.get("endedAt"):
                wall = (datetime.datetime.fromisoformat(run["endedAt"].replace("Z", "+00:00"))
                        - datetime.datetime.fromisoformat(run["startedAt"].replace("Z", "+00:00"))).total_seconds()
                t.update(embed_seconds=round(wall, 1), embed_tokens=usage, tokens_per_second=round(usage / wall),
                         embed_runtime="Azure OpenAI, the ingest's wall time")
                break
    for prefix, fields in (("vectors", {"embed_seconds": "questions_embed_seconds", "search_ms_p50": "exact_search_p50_ms"}),
                           ("search", {"latency_ms_p50": "search_p50_ms", "latency_ms_p95": "search_p95_ms"})):
        path = DATA / f"{prefix}-{key}.json"
        if path.exists():
            d = json.loads(path.read_text())
            t.update({new: d[old] for old, new in fields.items() if isinstance(d.get(old), (int, float))})
    return t


def collect_runs():
    """Copy into results/runs/ a full-search run for every side that has none there yet."""
    RUNS.mkdir(parents=True, exist_ok=True)
    held = {s for f in RUNS.glob("*.json") for r in json.loads(f.read_text())["rounds"] for s in r}
    for side in SIDES:
        name = compare_side(side)
        if name in held:
            continue
        own = []
        for f in sorted(DATA.glob("run-2026-*.json")):
            rounds = json.loads(f.read_text()).get("rounds", [])
            if len(rounds) >= 3 and all(set(r) == {name} for r in rounds):
                own.append(f)
        if own:
            shutil.copyfile(own[-1], RUNS / f"full-search-{side}.json")
            print(f"{side}: full search from {own[-1].name}")


def full_verdicts():
    out = DATA / "embeddings-full-verdicts"
    if out.exists():
        shutil.rmtree(out)
    files = [str(f) for f in sorted(RUNS.glob("*.json"))]
    subprocess.run(["npx", "tsx", "--conditions=source", str(COMPARE), "verdicts", str(out), *files], cwd=REPO,
                   check=True, capture_output=True, text=True)
    by_side = {}
    for side in SIDES:
        path = out / f"{compare_side(side)}.jsonl"
        if path.exists():
            by_side[side] = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    run_of = {s: f.name for f in sorted(RUNS.glob("*.json"))
              for r in json.loads(f.read_text())["rounds"] for s in r}
    return by_side, run_of


def scored_at(path):
    return datetime.datetime.fromtimestamp(path.stat().st_mtime, datetime.timezone.utc).replace(microsecond=0).isoformat()


def main():
    items = {q["item"] for q in questions()}
    collect_runs()
    full, run_of = full_verdicts()
    published = []
    for side in SIDES:
        rows, views = [], {}
        for view, prefix in (("vectors", "vectors"), ("search", "search"),
                             *((f"search-{step}", f"search-{step}") for step in SEARCH_STEPS)):
            path = DATA / f"{prefix}-{pilot_key(side)}.json"
            if not path.exists():
                continue
            scored = json.loads(path.read_text())
            if view == "vectors" and scored.get("passages") != SETTINGS["passages"]:
                raise SystemExit(f"{side}: {path.name} searched {scored.get('passages')} passages, not "
                                 f"{SETTINGS['passages']}: its ingest lost documents; ingest it again")
            results = scored["results"]
            if {r["id"] for r in results} != items:
                raise SystemExit(f"{side}: {path.name} was scored on other questions than the reference")
            rows += [{"item": r["id"], "view": view, "document": r["document"], "page": r.get("page")} for r in results]
            views[view] = scored_at(path)
        for v in full.get(side, []):
            if v["served"] is None:
                raise SystemExit(f"{side}: {v['item']} failed in a full-search round")
            rows.append({"item": v["item"], "view": "full", "rounds": v["rounds"], "latency_ms": v["latencyMs"],
                         "document": {METRICS[k]: x for k, x in v["served"].items()}})
        if side in full:
            views["full"] = run_of[compare_side(side)]
        if not rows:
            print(f"{side}: nothing scored yet")
            continue
        out = PUBLISHED / "sides" / side
        tables.write_jsonl(out / "verdicts.jsonl", sorted(rows, key=lambda r: (r["view"], r["item"])))
        record.write(out / "record.json", record.make(
            BENCHMARK, root=REPO, code=CODE, reference=[REFERENCE], items=[QUESTIONS], side=side,
            side_settings={**runtime(side), "scored": views, "timing": timing(side)}, settings=SETTINGS,
            packages=PACKAGES))
        published.append(f"{side} ({', '.join(views)})")
    print("published " + "; ".join(published))
    assert all(dimensions(s) for s in SIDES)


if __name__ == "__main__":
    main()
