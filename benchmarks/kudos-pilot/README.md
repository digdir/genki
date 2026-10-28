# Kudos pilot: re-ingest into pgvector, with three benchmarks

Re-ingests about 300 Kudos documents from the KUDOS API into pgvector, every PDF converted by Marker, and compares search engines, embedding models and vector indexes on them ([issue 92](https://github.com/digdir/genki/issues/92)). The sample is the 65 documents the `ka-kudos-draft` test cases cite, the 150 documents of the ingestion benchmark (`benchmarks/ingestion/sample.json`), and 85 decoys of the test documents' types and years drawn from documents Typesense also holds.

This folder holds what the benchmarks share: the sample, the conversion, the ingest, the local Typesense and the embedding models' servers and runners. Each benchmark has its own folder in the layout of [`benchmarks/README.md`](../README.md):

| Benchmark                  | Question                                                        | Results                                |
| -------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| [`engines`](engines)       | Typesense or pgvector for Kudos                                 | [report](engines/results/report.md)    |
| [`embeddings`](embeddings) | Which embedding model, at no more than 1,536 dimensions         | [report](embeddings/results/report.md) |
| [`indexes`](indexes)       | Which pgvector index, and what tens of millions of vectors take | [report](indexes/results/report.md)    |

## Commands

```sh
cd benchmarks/kudos-pilot
python3 draw_sample.py      # sample.json, from the ingestion benchmark's data (committed)
python3 convert.py          # every sample PDF through the Marker service, so its cache holds them (hours)
python3 run_ingest.py       # create the pilot pipeline through the API and run it
python3 copy_typesense.py   # copy the pilot's documents from the shared Typesense into a local one (about 30 minutes)
python3 gen_questions.py 600                                   # the generated questions (embeddings/reference)
python3.13 -m venv .data/embed-venv && .data/embed-venv/bin/pip install -r requirements.txt
./run_model.sh <key>        # one model of models.json: databases, pages, server, API, ingest, vector scores
.data/embed-venv/bin/python score_vectors.py baseline         # text-embedding-3-large, vector search alone
.data/embed-venv/bin/python score_search.py <key> ...         # genki's search without the planner
```

Then each benchmark's own commands: its README. `run_ingest.py --converted-only --roles test` runs only the test documents Marker has already converted, as a smoke test; `KUDOS_PILOT_LIMIT=2 … run 1` asks only the first two questions.

## What has to run

- The Marker service (`services/marker-pdf-to-markdown`), natively on a Mac for the GPU: `MARKER_WORKERS=1 PORT=8091 CACHE_DIR=<pilot>/.data/marker-cache MARKER_PDF_TO_MARKDOWN_API_KEY=… ./venv/bin/python main.py`. Only for conversion: every ingest after it reuses the stored output.
- The two databases: `COMPOSE_PROJECT_NAME=genki-kudos-pilot GENAI_POSTGRES_PORT=55442 GENAI_KNOWLEDGE_PORT=55443 docker compose up -d postgres knowledge`.
- A local Typesense of the shared cluster's version, for the engines benchmark: `docker run -d --name genki-kudos-pilot-typesense -p 127.0.0.1:8108:8108 -v genki-kudos-pilot-typesense:/data typesense/typesense:30.1 --data-dir /data --api-key=<key in .data/typesense-local-key>`. `copy_typesense.py` only reads the shared cluster: the collection schemas and searches filtered to the pilot's old ids. It leaves out the phrase vectors, which the local Typesense computes again with the same model.
- The API in dev mode against both, with Marker as converter and the local Typesense: `PORT=8096 GENAI_DEV_MODE=true DATABASE_URL=…:55442/genai KNOWLEDGE_DATABASE_URL=…:55443/knowledge DOCUMENT_CONVERTER=marker MARKER_URL=http://localhost:8091/api/v1/marker-pdf-to-markdown MARKER_API_KEY=… TYPESENSE_LOCAL_URL=http://127.0.0.1:8108 TYPESENSE_LOCAL_KEY=… npx tsx --conditions=source src/main.ts` from `apps/api`. The Foundry and ColBERT settings come from `.env.local`.

## Embedding models

Every model in `models.json` re-embeds the same 20,248 page passages, from the stored Marker output, into its own pair of databases (`genai_<key>`, `knowledge_<key>`), behind its own API (`start_model_api.sh`, with the config `setup_models.py` writes to `.data/config`). `run_model.sh <key>` does it all for one model; `chain_rest.sh`, `chain_big.sh`, `chain_round2.sh` and `chain_round3.sh` ran the rounds. `chain_steps.sh` runs genki's search without the planner cut down to one step at a time (vector or fusion search, each with and without ColBERT, and the whole search without ColBERT) for text-embedding-3-large and pplx-embed-v1-0.6b, through the step services `setup_models.py` writes; `start_model_api.sh baseline` starts the pilot's own API for it.

- `embed_server.py` serves one model on the Mac's GPU behind an OpenAI-compatible `/v1/embeddings`; genki adds each model's own query prompt through `prompts` in the embedding catalog.
- **MLX** (`mlx` in `models.json`): models of the Qwen3 architecture (Qwen3-Embedding, F2LLM-v2, harrier-oss-v1) embed their pages on Apple's MLX (`mlx_qwen3.py`, `pre_embed.py`) straight into the model's genki embedding cache (`kn_embeddings`); the ingest then reads every vector from the cache. MLX gives the same vectors as PyTorch (cosine ≥ 0.9997 for Qwen3, ≥ 0.99998 against float32 for F2LLM-v2 and harrier) and runs these models 1.4–1.6× faster.
- **Shortened** (`shortenedFrom`): `shorten.py` cuts the full model's stored page vectors to `dimensions` and normalises them again, into the shortened model's cache; its server cuts the questions the same way (`EMBED_DIMENSIONS`, sentence-transformers' `truncate_dim`). Nothing is embedded again.
- **From genki's catalog** (`catalogModel`): text-embedding-3-small runs on Foundry as genki calls it; no local server.
- **Code from the model's repository** (`trustRemoteCode`): read before it ran and pinned by commit. pplx-embed-v1 outputs int8 vectors (its own quantiser), stored as they come, and runs in float32, since float16 overflows. gte-multilingual-base's code lives in `Alibaba-NLP/new-impl` (`codeRevision`); offline loading looks for that repository's `main`, so `.data/hf/hub/models--Alibaba-NLP--new-impl/refs/main` names the pinned commit. Its 2024 code does not load under transformers 5 (its position buffers come out uninitialised), so it runs from `.data/embed-venv-tf4` (`venv` in `models.json`; `requirements-tf4.txt`), where it reproduces the scores on its model card.
- `timings.py` collects how long every step took and `dashboard_data.py` writes the CSV files behind the benchmark dashboard, both from `.data`.

## Settings

| Variable                         | Used by                                       | Notes                                                       |
| -------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `INGESTION_BENCHMARK_DIR`        | `draw_sample.py`, `convert.py`                | The ingestion benchmark's folder; `../ingestion` by default |
| `MARKER_URL`, `MARKER_API_KEY`   | `convert.py`                                  | The Marker service                                          |
| `TYPESENSE_URL`, `TYPESENSE_KEY` | `copy_typesense.py`                           | The shared Typesense test cluster, read only (`.env.local`) |
| `TYPESENSE_LOCAL_URL`            | `copy_typesense.py`, `kudos-pilot-compare.ts` | The local Typesense; `http://127.0.0.1:8108` by default     |
| `KUDOS_PILOT_LIMIT`              | `kudos-pilot-compare.ts`                      | Ask only the first questions, for a smoke run               |
| `KUDOS_PILOT_API`, `DEV_API_KEY` | `kudos-pilot-compare.ts`                      | The API and its dev key (`.env.local`)                      |
| `KUDOS_PILOT_DATA`               | every script                                  | Downloads, caches and run output; `.data/` by default       |

## Files

| File                             | Holds                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `sample.json`                    | The pilot's documents, with role, old numeric id and files                                   |
| `models.json`                    | Every embedding model: revision, dimensions, prompts, runtime, ports                         |
| `requirements*.txt`              | The two Python environments, pinned                                                          |
| `.data/marker-cache`             | Marker's output per PDF; the ingestion benchmark's page tests read it too                    |
| `.data/ingest-<execution>.json`  | The documents of an ingest run and its report: stored, skipped, failed                       |
| `.data/run-<time>.json`          | `kudos-pilot-compare.ts run`: each round's answers; copied into a benchmark's `results/runs` |
| `.data/vectors-<key>.json`       | `score_vectors.py`: one model's per-question scores, vector search alone                     |
| `.data/search-<key>.json`        | `score_search.py`: the same in genki's search without the planner                            |
| `.data/search-<step>-<key>.json` | `score_search.py --step`: the same with the search cut down to one step (`chain_steps.sh`)   |

## Method shared by the benchmarks

- **Same documents and passages for every side.** Marker converted every PDF once; genki split the text one passage per page (at most 4,000 characters), 20,248 passages in all, and every model embedded exactly those.
- **Same retrieval path.** Searches go through Kunnskapsassistenten's retrieve-only service (`rag-single-shot`, no answer, ColBERT reranking), with or without the planner.
- **Scored per document or page.** Chunk ids differ between indexes, so a question's documents are matched by old numeric id, which maps to KUDOS documents through `sample.json`. Two reports that KUDOS now holds under new registrations are matched by title and date; a hit on either counts.
