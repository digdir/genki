"""Embed every distinct page passage of the Kudos pilot for one Qwen3-architecture model (`mlx` in models.json) on
Apple's MLX (mlx_qwen3.py) and store the vectors in that model's genki embedding cache (kn_embeddings in
knowledge_<key>, keyed by model, dimensions and the sha256 of the text, as packages/ingest/src/embedding-cache.ts
reads it). The genki ingest that follows then finds every vector cached and sends nothing to the model. MLX runs
these models faster than PyTorch on this Mac's GPU and gives the same vectors (cosine ≥ 0.9997 against
sentence-transformers on real pages).

The passages are the ones genki makes from the stored Marker output: the same in every model's database, so they
are read from the pilot's own knowledge database. Restartable: texts already cached are skipped.

    .data/embed-venv/bin/python pre_embed.py qwen3-4b

Writes .data/pre-embed-<key>.json with the token count and time.
"""
import fcntl
import hashlib
import json
import sys
import time

import psycopg

from common import DATA, HERE
from mlx_qwen3 import Qwen3Embedder

TABLE = """create table if not exists kn_embeddings (
  model text not null, dimensions integer not null, hash text not null, vec halfvec not null,
  primary key (model, dimensions, hash))"""


def main():
    key = sys.argv[1]
    # One run per model at a time: a second one waits, then finds the passages cached
    lock = open(DATA / f"pre-embed-{key}.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    m = next(m for m in json.loads((HERE / "models.json").read_text())["models"] if m["key"] == key)
    snapshot = DATA / "hf" / "hub" / f"models--{m['hf'].replace('/', '--')}" / "snapshots" / m["revision"]
    model_id, dims = f"local/{key}", m["dimensions"]
    with psycopg.connect("postgresql://genai:genai-local-only@127.0.0.1:55443/knowledge") as c:
        texts = [r[0] for r in c.execute(
            "select distinct x.text from kn_chunks x join kn_active a on a.dataset = x.dataset "
            "and a.generation = x.generation where x.dataset = 'digdir/kudos-next'").fetchall()]
    target = f"postgresql://genai:genai-local-only@127.0.0.1:55443/knowledge_{key.replace('-', '_')}"
    with psycopg.connect(target, autocommit=True) as db:
        db.execute("create extension if not exists vector")
        db.execute(TABLE)
        cached = {r[0] for r in db.execute(
            "select hash from kn_embeddings where model = %s and dimensions = %s", (model_id, dims)).fetchall()}
        todo = [(hashlib.sha256(t.encode()).hexdigest(), t) for t in texts]
        todo = [(h, t) for h, t in todo if h not in cached]
        print(f"{key}: {len(texts)} distinct passages, {len(todo)} to embed", flush=True)
        if not todo:
            return  # an earlier run embedded them all; its stats file stays
        embedder = Qwen3Embedder(snapshot)
        started, tokens, done = time.perf_counter(), 0, 0
        for at in range(0, len(todo), 32):
            batch = todo[at:at + 32]
            vectors = embedder.embed([t for _, t in batch])
            tokens += sum(len(embedder.tokens(t)) for _, t in batch)
            with db.cursor() as cur:
                cur.executemany(
                    "insert into kn_embeddings (model, dimensions, hash, vec) values (%s, %s, %s, %s::halfvec) "
                    "on conflict (model, dimensions, hash) do nothing",
                    [(model_id, dims, h, "[" + ",".join(f"{x:.6f}" for x in v) + "]") for (h, _), v in zip(batch, vectors)],
                )
            done += len(batch)
            if done % 640 == 0 or done == len(todo):
                seconds = time.perf_counter() - started
                rate = tokens / seconds
                eta = (len(todo) - done) * (seconds / done) / 60
                print(f"{key}: {done}/{len(todo)} passages, {rate:.0f} tokens/s, ~{eta:.0f} min left", flush=True)
        seconds = time.perf_counter() - started
    (DATA / f"pre-embed-{key}.json").write_text(json.dumps({
        "model": m["hf"], "runtime": "mlx float16", "passages": len(todo), "tokens": tokens,
        "seconds": round(seconds, 1), "tokens_per_second": round(tokens / max(seconds, 1e-9), 1),
    }, indent=1))
    print(f"{key}: embedded {len(todo)} passages ({tokens} tokens) in {seconds / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
