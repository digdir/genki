"""Full genki search without the planner, for the Kudos pilot's model comparison (genki issue 92): every question
goes as asked to each side's kudos-pilot-<key>-noplan-retrieve-only service (keywords + vectors fused with RRF, then
ColBERT; planner.enabled false, so no model call and no cost). The sources' passage ids map to their document and
page through the pilot database (the ids, documents and pages are the same in every model's database), and the
answer is scored per page and per document like score_vectors.py. Each question goes to every side back to back.

    .data/embed-venv/bin/python score_search.py baseline borealis bge-m3 arctic-l-v2 qwen3-0-6b
    .data/embed-venv/bin/python score_search.py --step fusion baseline pplx-0-6b

--step runs one of common.SEARCH_STEPS instead: the -noplan-<step> services setup_models.py writes for the keys in
common.STEP_KEYS, written to .data/search-<step>-<key>.json. The baseline is text-embedding-3-large@1536 on the pilot API (KUDOS_PILOT_API, default http://localhost:8096,
which must run with CONFIG_DIR=.data/config to have the no-planner service); each model on its own API from
models.json. Needs DEV_API_KEY (environment or .env.local). Writes .data/search-<key>.json.
"""
import json
import os
import sys
import time
import urllib.request

import psycopg

from common import DATA, HERE, SEARCH_STEPS
from gen_questions import setting
from score_vectors import questions, scores


def side(key, step=None):
    noplan = f"noplan-{step}" if step else "noplan"
    if key == "baseline":
        return {"key": key, "model": "text-embedding-3-large", "dimensions": 1536,
                "api": os.environ.get("KUDOS_PILOT_API", "http://localhost:8096"),
                "service": f"kudos-pilot-{noplan}-retrieve-only__default"}
    m = next(m for m in json.loads((HERE / "models.json").read_text())["models"] if m["key"] == key)
    return {"key": key, "model": m.get("name", m["hf"]), "dimensions": m["dimensions"], "api": f"http://localhost:{m['api']}",
            "service": f"kudos-pilot-{key}-{noplan}-retrieve-only__default"}


def ask(s, question, key):
    request = urllib.request.Request(
        f"{s['api']}/v1/chat/completions",
        data=json.dumps({"model": s["service"], "messages": [{"role": "user", "content": question}]}).encode(),
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    started = time.perf_counter()
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                body = json.load(response)
            return [str((x.get("source") or {}).get("id", "")) for x in body.get("sources", [])], \
                (time.perf_counter() - started) * 1000, None
        except Exception as error:  # noqa: BLE001
            if attempt == 2:
                return [], (time.perf_counter() - started) * 1000, str(error)
            time.sleep(5)


def main():
    args = sys.argv[1:]
    step = args[args.index("--step") + 1] if "--step" in args else None
    if step is not None and step not in SEARCH_STEPS:
        raise SystemExit(f"--step takes one of {', '.join(SEARCH_STEPS)}")
    sides = [side(k, step) for k in args if k not in ("--step", step)]
    key = setting("DEV_API_KEY")
    asked, old_of = questions()
    with psycopg.connect("postgresql://genai:genai-local-only@127.0.0.1:55443/knowledge") as c:
        where = {r[0]: (r[1], r[2]) for r in c.execute(
            "select x.id, x.doc_id, (x.metadata->>'page')::int from kn_chunks x join kn_active a "
            "on a.dataset = x.dataset and a.generation = x.generation where x.dataset = 'digdir/kudos-next'").fetchall()}
    results = {s["key"]: [] for s in sides}
    latency = {s["key"]: [] for s in sides}
    for i, q in enumerate(asked):
        for s in sides:
            chunks, ms, error = ask(s, q["question"], key)
            located = [where[c] for c in chunks if c in where]
            documents = list(dict.fromkeys(old_of.get(d, d) for d, _ in located))
            result = {"id": q["id"], "set": q["set"], "document": scores(q["documents"], documents),
                      "sources": len(chunks), **({"error": error} if error else {})}
            if "page" in q:
                pages = list(dict.fromkeys((old_of.get(d, d), p) for d, p in located))
                result["page"] = scores([tuple(q["page"])], pages)
            for k in ("split", "language"):
                if k in q:
                    result[k] = q[k]
            results[s["key"]].append(result)
            latency[s["key"]].append(ms)
        if (i + 1) % 50 == 0:
            print(f"{i + 1}/{len(asked)} questions", flush=True)
    for s in sides:
        ms = sorted(latency[s["key"]])
        out = DATA / (f"search-{step}-{s['key']}.json" if step else f"search-{s['key']}.json")
        out.write_text(json.dumps({
            "model": s["model"], "key": s["key"], **({"step": step} if step else {}), "service": s["service"],
            "dimensions": s["dimensions"], "passages": len(where),
            "questions": len(results[s["key"]]), "errors": sum(1 for r in results[s["key"]] if "error" in r),
            "latency_ms_p50": round(ms[len(ms) // 2]), "latency_ms_p95": round(ms[int(0.95 * len(ms))]),
            "seconds_total": round(sum(ms) / 1000, 1), "embed_seconds": "–",
            "search_ms_p50": round(ms[len(ms) // 2]), "results": results[s["key"]],
        }, indent=1))
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
