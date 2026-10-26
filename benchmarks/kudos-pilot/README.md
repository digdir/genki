# Kudos pilot: re-ingest into pgvector and compare with Typesense

Re-ingests about 300 Kudos documents from the KUDOS API into `digdir/kudos-next` on pgvector, with every PDF converted by Marker, and compares retrieval with Typesense on the same documents ([#92](https://github.com/digdir/genki/issues/92)). The sample is the 65 documents the `ka-kudos-draft` test cases cite, the 150 documents of the ingestion benchmark (`benchmarks/ingestion/sample.json`), and decoys of the test documents' types and years drawn from documents Typesense also holds.

## Commands

```sh
cd benchmarks/kudos-pilot
python3 draw_sample.py     # sample.json, from the ingestion benchmark's data (committed)
python3 convert.py         # every sample PDF through the Marker service, so its cache holds them (hours)
python3 run_ingest.py      # create the pilot pipeline through the API and run it
python3 copy_typesense.py  # copy the pilot's documents from the shared Typesense into a local one (about 30 minutes)
cd ../..
npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts run 3
npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts compare benchmarks/kudos-pilot/.data/run-<time>.json
# the Typesense service with the planner's phrase step off, against the same service with it on
npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts run 3 typesense-blind
npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts compare <run.json> <run-blind.json> typesense typesense-blind
```

`run_ingest.py --converted-only --roles test` runs only the test documents Marker has already converted, as a smoke test; `KUDOS_PILOT_LIMIT=2 … run 1` asks only the first two questions. The sides are `typesense`, `typesense-blind` and `pgvector`; `run` asks the ones it is given, `compare` takes each side's rounds from whichever run files hold it. Python 3.9 or later, standard library only.

## What has to run

- The Marker service (`services/marker-pdf-to-markdown`), natively on a Mac for the GPU: `MARKER_WORKERS=1 PORT=8091 CACHE_DIR=<pilot>/.data/marker-cache MARKER_PDF_TO_MARKDOWN_API_KEY=… ./venv/bin/python main.py`.
- The two databases: `COMPOSE_PROJECT_NAME=genki-kudos-pilot GENAI_POSTGRES_PORT=55442 GENAI_KNOWLEDGE_PORT=55443 docker compose up -d postgres knowledge`.
- A local Typesense of the shared cluster's version, for the comparison: `docker run -d --name genki-kudos-pilot-typesense -p 127.0.0.1:8108:8108 -v genki-kudos-pilot-typesense:/data typesense/typesense:30.1 --data-dir /data --api-key=<key in .data/typesense-local-key>`. `copy_typesense.py` only reads the shared cluster: the collection schemas and searches filtered to the pilot's old ids. It leaves out the phrase vectors, which the local Typesense computes again with the same model.
- The API in dev mode against both, with Marker as converter and the local Typesense: `PORT=8096 GENAI_DEV_MODE=true DATABASE_URL=…:55442/genai KNOWLEDGE_DATABASE_URL=…:55443/knowledge DOCUMENT_CONVERTER=marker MARKER_URL=http://localhost:8091/api/v1/marker-pdf-to-markdown MARKER_API_KEY=… TYPESENSE_LOCAL_URL=http://127.0.0.1:8108 TYPESENSE_LOCAL_KEY=… npx tsx --conditions=source src/main.ts` from `apps/api`. The Foundry and ColBERT settings come from `.env.local`.

## Self-hosted embedding models

Every model in `models.json` (Borealis Embed 212M, BGE-M3, Arctic Embed L v2, Qwen3-Embedding 0.6B, 4B and 8B) re-embeds the same 20,248 page passages, from the stored Marker output, into its own pair of databases (`genai_<key>`, `knowledge_<key>`), behind its own API, and is scored two ways: vector search alone, and the full genki search.

```sh
python3 -m venv .data/embed-venv   # Python 3.10+; torch, sentence-transformers, fastapi, uvicorn, psycopg, numpy, pyarrow, pgvector, PyYAML
python3 gen_questions.py 600                                   # ~600 questions from random pages, every sixth in Nynorsk
.data/embed-venv/bin/python score_vectors.py baseline          # text-embedding-3-large@1536, vector search alone
./run_model.sh borealis                                        # databases, embedding server, API, ingest, vector scores
.data/embed-venv/bin/python compare_vectors.py                 # every model against the baseline
cd ../.. && npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts run 3 borealis,bge-m3,pgvector
```

- `embed_server.py` serves one model on the Mac's GPU behind an OpenAI-compatible `/v1/embeddings`; genki adds each model's own query prompt through `prompts` in the embedding catalog.
- `setup_models.py` writes `.data/config`: the committed `apps/api/config/local` plus an endpoint, embedding model, dataset and retrieve-only service per model. `start_model_api.sh <key>` starts that model's API with it.
- `chain_rest.sh` and `chain_big.sh` run the rest unattended: the full search for the small models, the index benchmark, then the two large Qwen3 models.
- Qwen3 models are embedded on Apple's MLX (`mlx_qwen3.py`, `pre_embed.py`) straight into the model's genki embedding cache (`kn_embeddings`); the genki ingest then reads every vector from the cache. MLX gives the same vectors as PyTorch (cosine ≥ 0.9997) and runs these models 1.4–1.6× faster on the Mac's GPU.
- `score_search.py` runs genki's search without the planner (`-noplan` services: keywords + vectors + ColBERT, no model call) on every question; `full_search_summary.py` tabulates the full search with the planner per model.
- `timings.py` collects how long every step took; `dashboard_data.py` writes the CSV files behind the benchmark dashboard.

## Index and scale

`bench_index.py` measures pgvector 0.8.2 (Azure's version) in its own container (`genki-kudos-pilot-bench`, port 55444) at 100,000 to 1 million halfvec(1536) vectors: Qdrant's DBpedia 1M set embedded with text-embedding-3-large (`.data/dbpedia`) with the pilot's 20,248 pages mixed in. It compares exact search, HNSW (several ef_search), IVFFlat (several probes), binary quantisation with re-ranking, an HNSW build within Azure's limits (2 GB of build memory, 2 workers), filtered search and a nightly-sync style write. `bench_report.py` turns the results into tables and projects sizes and build times to 10–50 million vectors. `BENCH_BIG=0 … bench_index.py 30000` is a smoke run through every step.

## Settings

| Variable                         | Used by                                       | Notes                                                       |
| -------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `INGESTION_BENCHMARK_DIR`        | `draw_sample.py`, `convert.py`                | The ingestion benchmark's folder; `../ingestion` by default |
| `MARKER_URL`, `MARKER_API_KEY`   | `convert.py`                                  | The Marker service                                          |
| `TYPESENSE_URL`, `TYPESENSE_KEY` | `copy_typesense.py`                           | The shared Typesense test cluster, read only (`.env.local`) |
| `TYPESENSE_LOCAL_URL`            | `copy_typesense.py`, `kudos-pilot-compare.ts` | The local Typesense; `http://127.0.0.1:8108` by default     |
| `KUDOS_PILOT_LIMIT`              | `kudos-pilot-compare.ts`                      | Ask only the first questions, for a smoke run               |
| `KUDOS_PILOT_API`, `DEV_API_KEY` | `kudos-pilot-compare.ts`                      | The API and its dev key (`.env.local`)                      |
| `KUDOS_PILOT_DATA`               | every script                                  | Where downloads and results go; `.data/` by default         |

## Output

| File                             | Holds                                                                  |
| -------------------------------- | ---------------------------------------------------------------------- |
| `sample.json`                    | The pilot's documents, with role, old numeric id and files (committed) |
| `.data/conversions.jsonl`        | One line per PDF Marker converted: pages, seconds, OCR pages, errors   |
| `.data/ingest-<execution>.json`  | The documents of an ingest run and its report: stored, skipped, failed |
| `.data/copy-typesense.log`       | Documents, chunks and phrases on the shared cluster and locally        |
| `.data/run-<time>.json`          | Each round's answers per engine: sources in rank order and latency     |
| `.data/report-<time>.md`         | Recall@10, Recall@5, MRR and nDCG@10 with paired bootstrap intervals   |
| `.data/generated-questions.json` | The generated questions, each with its page and document               |
| `.data/vectors-<key>.json`       | One model's vector-only scores per question                            |
| `.data/vectors-report.md`        | Every model against text-embedding-3-large, paired bootstrap           |
| `.data/index-bench.jsonl`        | One line per index measurement; `index-report.md` the tables           |

## Method

- **Both engines see the same documents, on one machine.** The local Typesense holds only the pilot's documents, chunks and phrases, copied from the shared test cluster with its schema; `digdir/kudos-local-typesense` is `digdir/kudos` pointed at it. No filter is sent, so its automatic filter works as in production.
- **Same retrieval path.** Both go through Kunnskapsassistenten's retrieve-only service (`rag-single-shot`, no answer, ColBERT reranking): `kudos-pilot-typesense-retrieve-only` on the local Typesense and `kudos-pilot-retrieve-only` on pgvector. `kudos-pilot-typesense-blind-retrieve-only` is the Typesense one with `planner.expansionMode: blind`: the planner writes its queries in one model call, as on pgvector, instead of looking up stored phrases and rewording them in a second call. Its search still uses the phrases and their vectors.
- **Same load, several rounds.** Each question goes to both services back to back, in three rounds; a question's scores are averaged over the rounds, since the planning model does not always plan the same search.
- **Shared chunk ids.** Typesense's chunk ids are not unique across documents, so it can serve a passage under another document than the one it found. The report scores Typesense both as served and credited with every pilot document that holds a returned chunk.
- **Scored per document.** Chunk ids and positions differ between the indexes, so a case's expected documents are matched by old numeric id, which maps to KUDOS UUIDs through `sample.json`. Two reports that KUDOS now holds under new registrations are matched by title and date; a hit on either registration counts.
- **Paired bootstrap** over questions (`pairedBootstrap` in `packages/eval/src/stats.ts`, 10,000 resamples). With fewer than a hundred questions the interval only rules out large differences.
