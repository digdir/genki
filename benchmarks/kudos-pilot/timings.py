"""Collect how long every step of the Kudos pilot took (genki issue 92), with its rate: Marker's conversions, each
ingest, embedding (through the embedding servers and in the MLX batch jobs), question generation, vector scoring,
the full genki search runs and the index benchmark. Everything comes from what the runs recorded in .data; a log
file's creation and last change give the wall time of a step that recorded nothing else.

    python3 timings.py

Writes .data/timings.md. Python 3.9 or later, standard library only.
"""
import json
import statistics
from datetime import datetime
from pathlib import Path

from common import DATA, HERE


def iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def span(path):
    st = Path(path).stat()
    return getattr(st, "st_birthtime", st.st_ctime), st.st_mtime


def minutes(seconds):
    return f"{seconds / 60:,.1f} min" if seconds < 5400 else f"{seconds / 3600:,.1f} h"


def models():
    return {m["key"]: m for m in json.loads((HERE / "models.json").read_text())["models"]}


def main():
    lines = ["# Kudos pilot: how long everything took\n",
             "On an M3 Pro (11 cores, 36 GB). Rates are tokens of the model's own tokenizer per second unless said "
             "otherwise. Wall time is the clock from start to end of the step, including everything around the model "
             "(downloads from KUDOS, database writes, HTTP).\n"]

    rows = [json.loads(l) for l in (DATA / "conversions.jsonl").read_text().splitlines() if l.strip()]
    done = [r for r in rows if r.get("ok") and not r.get("cached")]
    if done:
        seconds = sum(r["seconds"] for r in done)
        pages = sum(r["pages"] for r in done)
        lines += ["## Marker (PDF to text, once for all models)\n",
                  f"{len(done)} PDFs, {pages:,} pages in {minutes(seconds)} of conversion time: "
                  f"{pages / seconds:.2f} pages/s, {seconds / pages:.1f} s per page; "
                  f"{sum(r.get('ocr_pages') or 0 for r in done):,} pages needed OCR. Every later ingest reused the stored "
                  "output and sent nothing to Marker.\n"]

    lines += ["## Ingest (fetch from KUDOS, stored Marker text, page chunks, embed, write to pgvector)\n",
              "| Dataset | Documents | Started | Wall time | Embedding tokens | Tokens/s over the wall time | Note |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    for path in sorted(DATA.glob("ingest-*.json"), key=lambda p: json.loads(p.read_text())["run"]["startedAt"]):
        d = json.loads(path.read_text())
        run = d["run"]
        report = run.get("report") or {}
        if len(d.get("documents", [])) < 300 or not run.get("endedAt"):
            continue
        wall = (iso(run["endedAt"]) - iso(run["startedAt"])).total_seconds()
        usage = sum(u.get("inputTokens", 0) for u in (report.get("usage") or {}).values())
        note = "vectors from the cache" if usage < 100_000 else ""
        rate = f"{usage / wall:,.0f}" if usage >= 100_000 else "–"
        lines.append(f"| {d.get('dataset', 'digdir/kudos-next')} | {report.get('stored')} | {run['startedAt'][:16]} | "
                     f"{minutes(wall)} | {usage:,} | {rate} | {note} |")
    lines.append("")

    lines += ["## Embedding the 20,040 distinct pages\n",
              "| Model | Runtime | Tokens | Embedding time | Tokens/s | Pages/s |", "| --- | --- | --- | --- | --- | --- |"]
    for key, m in models().items():
        for name, runtime in ((f"embed-stats-{key}.json", "PyTorch MPS server"), (f"pre-embed-{key}.json", "MLX batch")):
            path = DATA / name
            if not path.exists():
                continue
            s = json.loads(path.read_text())
            tokens, seconds = s["tokens"], s["seconds"]
            texts = s.get("texts", s.get("passages", 0))
            if runtime.startswith("PyTorch") and texts < 1000:
                continue  # a server that only embedded questions
            lines.append(f"| {m['hf']} | {runtime} ({m['dtype']}) | {tokens:,} | {minutes(seconds)} | "
                         f"{tokens / seconds:,.0f} | {texts / seconds:.1f} |")
    lines.append("")

    log = DATA / "gen-questions.log"
    if log.exists():
        start, end = span(log)
        q = json.loads((DATA / "generated-questions.json").read_text())
        lines += ["## Question generation (gpt-4o on Foundry, 6 at a time)\n",
                  f"{q['drawn']} pages asked, {len(q['questions'])} questions kept, in {minutes(end - start)}.\n"]

    lines += ["## Vector-only scoring (676 questions per model)\n",
              "| Model | Embedding all questions | Exact search over 20,248 pages, p50 |", "| --- | --- | --- |"]
    for path in sorted(DATA.glob("vectors-*.json")):
        v = json.loads(path.read_text())
        lines.append(f"| {v['model']} | {v['embed_seconds']} s | {v['search_ms_p50']} ms |")
    lines.append("")

    lines += ["## Full genki search (planner, keywords + vectors, ColBERT), per call\n",
              "| Run | Side | Calls | p50 | p95 | Sum of calls |", "| --- | --- | --- | --- | --- | --- |"]
    for path in sorted(DATA.glob("run-2026-*.json")):
        d = json.loads(path.read_text())
        rounds = d.get("rounds", [])
        sides = sorted({s for r in rounds for s in r})
        for side in sides:
            ms = sorted(a["latencyMs"] for r in rounds for a in (r.get(side) or {}).values())
            if len(ms) < 20:
                continue
            lines.append(f"| {path.stem[4:20]} | {side} | {len(ms)} | {statistics.median(ms) / 1000:.1f} s | "
                         f"{ms[int(0.95 * len(ms))] / 1000:.1f} s | {minutes(sum(ms) / 1000)} |")
    lines.append("")

    bench = DATA / "index-bench.jsonl"
    if bench.exists():
        rows = [json.loads(l) for l in bench.read_text().splitlines() if l.strip()]
        stamps = [iso(r["at"]) for r in rows if "at" in r]
        if stamps:
            lines += ["## Index and scale benchmark\n",
                      f"From {min(stamps):%H:%M} to {max(stamps):%H:%M} UTC ({minutes((max(stamps) - min(stamps)).total_seconds())}). "
                      "Build and load times per step:\n",
                      "| Rows | Step | Index | Memory / workers | Seconds | Rows/s |", "| --- | --- | --- | --- | --- | --- |"]
            for r in rows:
                if r.get("step") in ("load", "build"):
                    lines.append(f"| {r['size']:,} | {r['step']} | {r.get('index', 'table')} | "
                                 f"{r.get('memory', '–')} / {r.get('workers', '–')} | {r['seconds']} | "
                                 f"{r['size'] / max(r['seconds'], 1e-9):,.0f} |")
            lines.append("")

    chain = DATA / "chain-rest.log"
    if chain.exists():
        lines += ["## The unattended run, step by step\n", "```", (DATA / "chain-small.log").read_text().strip()
                  if (DATA / "chain-small.log").exists() else "", chain.read_text().strip(), "```", ""]
    report = "\n".join(lines) + "\n"
    (DATA / "timings.md").write_text(report)
    print(report)


if __name__ == "__main__":
    main()
