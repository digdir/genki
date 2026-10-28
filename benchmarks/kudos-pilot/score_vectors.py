"""Vector-only scoring for the Kudos pilot's model comparison (genki issue 92): each question is embedded the way
genki would (the model's query prompt first), the nearest 100 passages are found by exact search in that model's
own knowledge database (no index, so the index cannot blur the comparison), and the expected page and document
are looked up in that list. No planner, keywords or reranker: this measures the embedding model alone. The
question vectors are kept in .data/queries-<key>.npy for the index benchmark.

    .data/embed-venv/bin/python score_vectors.py <key>          # a model from models.json, its server running
    .data/embed-venv/bin/python score_vectors.py baseline       # text-embedding-3-large@1536 in the pilot database

Question sets: the 76 ka-kudos-draft questions with an expected document (scored per document) and
.data/generated-questions.json (scored per page and per document). Writes .data/vectors-<key>.json.
Settings for the baseline: FOUNDRY_OPENAI_BASE_URL and FOUNDRY_OPENAI_KEY (environment or .env.local).
"""
import json
import math
import sys
import time
import urllib.request

import numpy as np
import psycopg
import yaml

from common import DATA, HERE, REPO, SAMPLE
from gen_questions import setting

TOP = 100


def model_settings(key):
    if key == "baseline":
        return {"key": key, "hf": "text-embedding-3-large", "dimensions": 1536, "prompts": {},
                "database": "knowledge", "dataset": "digdir/kudos-next"}
    m = next(m for m in json.loads((HERE / "models.json").read_text())["models"] if m["key"] == key)
    return {**m, "database": f"knowledge_{key.replace('-', '_')}", "dataset": f"digdir/kudos-next-{key}"}


def embed(model, texts):
    prompt = model["prompts"].get("query", "")
    inputs = [prompt + t for t in texts]
    if model["key"] == "baseline" or model.get("catalogModel"):
        # OpenAI's models on Foundry, as genki calls them (text-embedding-3-large shortened to 1,536)
        url = setting("FOUNDRY_OPENAI_BASE_URL").rstrip("/") + "/embeddings"
        headers = {"api-key": setting("FOUNDRY_OPENAI_KEY")}
        body = {"model": model["hf"], "input": inputs, "dimensions": model["dimensions"], "encoding_format": "float"}
    else:
        url, headers = f"http://127.0.0.1:{model['server']}/v1/embeddings", {}
        body = {"model": model["hf"], "input": inputs}
    vectors = []
    for at in range(0, len(inputs), 32):
        request = urllib.request.Request(
            url, data=json.dumps({**body, "input": inputs[at:at + 32]}).encode(),
            headers={"content-type": "application/json", **headers},
        )
        with urllib.request.urlopen(request, timeout=600) as response:
            vectors += [d["embedding"] for d in sorted(json.load(response)["data"], key=lambda d: d["index"])]
    return vectors


def questions():
    sample = json.loads(SAMPLE.read_text())["documents"]
    old_of = {d["uuid"]: d["old_id"] for d in sample if d["old_id"]}
    test_set = yaml.safe_load((REPO / "packages" / "eval" / "testsets" / "ka-kudos-draft.yaml").read_text())
    draft = []
    for c in test_set["spec"]["cases"]:
        expected = sorted({s["document"] for s in (c.get("expected") or {}).get("sources", []) if s.get("document")})
        text = c["input"] if isinstance(c["input"], str) else " ".join(p.get("text", "") for p in c["input"]["parts"])
        if expected:
            draft.append({"id": c["id"], "set": "draft", "split": c.get("split", "train"), "question": text,
                          "documents": expected})
    generated = []
    path = DATA / "generated-questions.json"
    if path.exists():
        for q in json.loads(path.read_text())["questions"]:
            document = old_of.get(q["document"], q["document"])
            generated.append({"id": q["id"], "set": "generated", "language": q["language"], "question": q["question"],
                              "documents": [document], "page": [document, q["page"]]})
    return draft + generated, old_of


def nearest(connection, model, vector):
    dims = model["dimensions"]
    literal = "[" + ",".join(f"{x:.6f}" for x in vector) + "]"
    with connection.transaction():
        connection.execute("set local enable_indexscan = off")
        connection.execute("set local enable_bitmapscan = off")
        rows = connection.execute(
            f"""select c.doc_id, (c.metadata->>'page')::int
                from kn_chunks c join kn_active a on a.dataset = c.dataset and a.generation = c.generation
                where c.dataset = %s and c.vec is not null
                order by c.vec::halfvec({dims}) <=> %s::halfvec({dims}) limit {TOP}""",
            (model["dataset"], literal),
        ).fetchall()
    return rows


def ranks(expected, ranked):
    return sorted(ranked.index(e) + 1 for e in expected if e in ranked)


def scores(expected, ranked):
    found = ranks(expected, ranked)
    ideal = sum(1 / math.log2(i + 2) for i in range(min(len(expected), 10)))
    return {
        "recall@1": sum(r <= 1 for r in found) / len(expected),
        "recall@5": sum(r <= 5 for r in found) / len(expected),
        "recall@10": sum(r <= 10 for r in found) / len(expected),
        "recall@100": len(found) / len(expected),
        "mrr": 1 / found[0] if found else 0.0,
        "ndcg@10": sum(1 / math.log2(r + 1) for r in found if r <= 10) / ideal,
    }


def main():
    key = sys.argv[1]
    model = model_settings(key)
    asked, old_of = questions()
    started = time.perf_counter()
    vectors = embed(model, [q["question"] for q in asked])
    embed_seconds = time.perf_counter() - started
    np.save(DATA / f"queries-{key}.npy", np.array(vectors, dtype=np.float32))
    results, search_seconds = [], []
    with psycopg.connect(f"postgresql://genai:genai-local-only@127.0.0.1:55443/{model['database']}",
                         autocommit=True) as connection:
        count = connection.execute(
            "select count(*) from kn_chunks c join kn_active a on a.dataset = c.dataset "
            "and a.generation = c.generation where c.dataset = %s", (model["dataset"],)).fetchone()[0]
        for q, vector in zip(asked, vectors):
            t0 = time.perf_counter()
            rows = nearest(connection, model, vector)
            search_seconds.append(time.perf_counter() - t0)
            documents = list(dict.fromkeys(old_of.get(d, d) for d, _ in rows))
            result = {"id": q["id"], "set": q["set"], "document": scores(q["documents"], documents)}
            if "page" in q:
                pages = list(dict.fromkeys((old_of.get(d, d), p) for d, p in rows))
                result["page"] = scores([tuple(q["page"])], pages)
            for k in ("split", "language"):
                if k in q:
                    result[k] = q[k]
            results.append(result)
    out = DATA / f"vectors-{key}.json"
    out.write_text(json.dumps({
        "model": model.get("name", model["hf"]), "key": key, "dimensions": model["dimensions"], "passages": count,
        "questions": len(results), "embed_seconds": round(embed_seconds, 1),
        "search_ms_p50": round(1000 * sorted(search_seconds)[len(search_seconds) // 2], 1),
        "results": results,
    }, indent=1))
    by = lambda s, level, metric: [r[level][metric] for r in results if r["set"] == s and level in r]
    mean = lambda xs: 100 * sum(xs) / max(len(xs), 1)
    print(f"{key}: {count} passages; draft doc R@10 {mean(by('draft', 'document', 'recall@10')):.1f}, "
          f"generated page R@10 {mean(by('generated', 'page', 'recall@10')):.1f}, "
          f"page MRR {mean(by('generated', 'page', 'mrr')):.1f}; wrote {out}")


if __name__ == "__main__":
    main()
