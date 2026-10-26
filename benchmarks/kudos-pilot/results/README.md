# Kudos pilot: results

The measurements behind the Kudos pilot ([genki issue 92](https://github.com/digdir/genki/issues/92)), copied from `.data/`, where the scripts write them. Measured 22 to 24 October 2026 on one M3 Pro. The bootstrap in every report is seeded, so rechecking from these files gives the same numbers and intervals.

The scripts keep writing to `.data/`. Copy a file here by hand when a rerun should replace it.

## Reports

| File                                       | Compares                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typesense-vs-pgvector.md`                 | The retrieve-only service on a local Typesense holding the pilot's documents and on pgvector with text-embedding-3-large: the 76 draft questions, 3 rounds. Credited first, then as served |
| `typesense-phrase-step-off.md`             | Typesense with and without the planner's phrase step                                                                                                                                       |
| `typesense-phrase-step-off-vs-pgvector.md` | Typesense with the phrase step off against pgvector                                                                                                                                        |
| `vectors-report.md`                        | Seven embedding models by vector search alone: 600 generated and 76 draft questions                                                                                                        |
| `search-report.md`                         | The same models in genki's search without the planner (keywords and vectors with RRF, then ColBERT)                                                                                        |
| `full-search-report.md`                    | The same models in the full search with the planner: the 76 draft questions, 3 rounds                                                                                                      |
| `index-report.md`                          | pgvector indexes (exact, HNSW, IVFFlat, binary quantisation with re-ranking) at up to 1 million vectors, and sizes projected to 50 million                                                 |
| `timings.md`                               | How long each step took and tokens per second. A note, not part of any ranking                                                                                                             |

The Typesense numbers in the decision doc are the "as served" tables: Typesense without credit for documents that share a returned chunk id.

## Tables and questions

| File                                                             | Holds                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `vectors-summary.csv`, `search-summary.csv`, `index-summary.csv` | The reports' tables, one row per model or index and metric                                                                                  |
| `dashboard/*.csv`                                                | The data of the benchmark page: quality, models, index recall, builds, scale, steps and costs                                               |
| `generated-questions.json`                                       | The 600 questions gpt-4o wrote from random pilot pages, each with its document, page and chunk. Unreviewed: the page is taken as the answer |

The 76 draft questions are `packages/eval/testsets/ka-kudos-draft.yaml`.

## Raw results

`baseline` is text-embedding-3-large at 1,536 dimensions; the other keys are in `../models.json`.

| File                                                     | Holds                                                                                                         | Written as (in `.data/`)            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `raw/runs/typesense-vs-pgvector.json`                    | Each round's answers per side: sources in rank order, latency, and the documents holding each Typesense chunk | `run-2026-10-23T07-54-01-081Z.json` |
| `raw/runs/typesense-phrase-step-off.json`                | The same for Typesense with the phrase step off                                                               | `run-2026-10-23T09-16-42-335Z.json` |
| `raw/runs/full-search-3-large-and-small-models.json`     | The full search for text-embedding-3-large, Borealis, BGE-M3, Arctic and Qwen3-0.6B                           | `run-2026-10-23T17-43-40-255Z.json` |
| `raw/runs/full-search-qwen3-4b.json`                     | The full search for Qwen3-Embedding-4B                                                                        | `run-2026-10-24T02-50-36-539Z.json` |
| `raw/runs/full-search-qwen3-8b.json`                     | The full search for Qwen3-Embedding-8B                                                                        | `run-2026-10-24T17-39-42-305Z.json` |
| `raw/vectors-<key>.json`                                 | One model's vector-only result per question                                                                   | same name                           |
| `raw/search-<key>.json`                                  | One model's result per question in the search without the planner                                             | same name                           |
| `raw/index-bench.jsonl`                                  | One line per index measurement                                                                                | same name                           |
| `raw/comparison-data.json`                               | Per question and side: planning, search and rerank time, queries, hits (the comparison page's data)           | same name                           |
| `raw/conversions.jsonl`                                  | One line per PDF Marker converted: pages, OCR pages, seconds                                                  | same name                           |
| `raw/embed-stats-<key>.json`, `raw/pre-embed-<key>.json` | Tokens and seconds of each model's embedding                                                                  | same name                           |

## Recheck

From the repository root, without the pilot's databases or Typesense:

```sh
compare() { npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts compare "$@"; }
runs=benchmarks/kudos-pilot/results/raw/runs

compare $runs/typesense-vs-pgvector.json
compare $runs/typesense-vs-pgvector.json $runs/typesense-phrase-step-off.json typesense typesense-blind
compare $runs/typesense-vs-pgvector.json $runs/typesense-phrase-step-off.json typesense-blind pgvector
compare $runs/full-search-*.json pgvector qwen3-8b    # any model key against text-embedding-3-large
```

`compare` prints the report and writes a copy to `.data/`. The vector and search reports come from the per-question files (needs numpy):

```sh
cd benchmarks/kudos-pilot
mkdir -p /tmp/kudos-recheck && cp results/raw/vectors-*.json results/raw/search-*.json results/generated-questions.json /tmp/kudos-recheck/
KUDOS_PILOT_DATA=/tmp/kudos-recheck python3 compare_vectors.py           # writes /tmp/kudos-recheck/vectors-report.md
KUDOS_PILOT_DATA=/tmp/kudos-recheck python3 compare_vectors.py search    # writes /tmp/kudos-recheck/search-report.md
```
