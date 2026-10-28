"""Fill a shortened model's genki embedding cache from the full model's stored page vectors, for the Kudos pilot's
third round (genki issue 92). Models trained for shortening (Matryoshka: Qwen3-Embedding, Arctic Embed L v2) keep
their meaning in the first dimensions, so a vector cut to its first `dimensions` numbers and normalised again is
the shortened model's vector; sentence-transformers' truncate_dim does the same for the questions (embed_server.py
with EMBED_DIMENSIONS). The cut happens in Postgres (pgvector's subvector and l2_normalize), from kn_embeddings in
the full model's knowledge database into the shortened model's, so the genki ingest that follows finds every page
cached and no page is embedded again.

    .data/embed-venv/bin/python shorten.py qwen3-8b-1536

Reads `shortenedFrom` and `dimensions` from models.json. Restartable: a complete cache is left alone.
"""
import json
import sys
import time

import psycopg

from common import HERE

KNOWLEDGE = "postgresql://genai:genai-local-only@127.0.0.1:55443/knowledge_"
TABLE = """create table if not exists kn_embeddings (
  model text not null, dimensions integer not null, hash text not null, vec halfvec not null,
  primary key (model, dimensions, hash))"""


def main():
    key = sys.argv[1]
    models = {m["key"]: m for m in json.loads((HERE / "models.json").read_text())["models"]}
    model, source = models[key], models[models[key]["shortenedFrom"]]
    dims, source_id, target_id = model["dimensions"], f"local/{source['key']}", f"local/{key}"
    with psycopg.connect(KNOWLEDGE + source["key"].replace("-", "_")) as src, \
            psycopg.connect(KNOWLEDGE + key.replace("-", "_"), autocommit=True) as dst:
        total = src.execute("select count(*) from kn_embeddings where model = %s and dimensions = %s",
                            (source_id, source["dimensions"])).fetchone()[0]
        dst.execute("create extension if not exists vector")
        dst.execute(TABLE)
        cached = dst.execute("select count(*) from kn_embeddings where model = %s and dimensions = %s",
                             (target_id, dims)).fetchone()[0]
        if total and cached == total:
            print(f"{key}: {cached} pages cached already")
            return
        dst.execute("delete from kn_embeddings where model = %s and dimensions = %s", (target_id, dims))
        started = time.perf_counter()
        with src.cursor(name="pages") as pages, dst.cursor() as cur, \
                cur.copy("copy kn_embeddings (model, dimensions, hash, vec) from stdin") as copy:
            pages.execute("select hash, l2_normalize(subvector(vec, 1, %s))::text from kn_embeddings "
                          "where model = %s and dimensions = %s", (dims, source_id, source["dimensions"]))
            for page_hash, vector in pages:
                copy.write_row((target_id, dims, page_hash, vector))
    print(f"{key}: {total} pages cut from {source['dimensions']} to {dims} dimensions in "
          f"{time.perf_counter() - started:.0f} s")


if __name__ == "__main__":
    main()
