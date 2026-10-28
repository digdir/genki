# Embedding models for Kudos

Which embedding model should Kudos on pgvector use? This benchmark grades self-hosted models, shortened versions of the strongest, and OpenAI's two models on the same questions over the same 20,248 page passages of 300 Kudos documents, three ways: by vector search alone, in genki's search without the planner, and in the full search with it. The choice it informs: the embedding model in the plan to retire Typesense for Kudos ([issue 92](https://github.com/digdir/genki/issues/92)).

## Results

Graded 23 to 27 October 2026; scores, differences and the instrument checks are in [results/report.md](results/report.md), and what each run used (commit, model revision, prompts, runtime) is in `results/sides/<side>/record.json`.

By vector search alone, ten models share the first tier: pplx-embed-v1-0.6b, Qwen3-Embedding-8B and 4B at full length and shortened to 1,536 and 1,024 dimensions, snowflake-arctic-embed-l-v2.0 at 1,024 and 512, and bge-m3. harrier-oss-v1-0.6b and text-embedding-3-large are second; Qwen3-Embedding-0.6B, F2LLM-v2-0.6B, text-embedding-3-small and borealis-embed-212m third; gte-multilingual-base last. Nine of the fourteen candidates within 1,536 dimensions are better than text-embedding-3-large at the 2-point margin, pplx-embed-v1-0.6b by the most (+8.9 points of page MRR). Shortening the Qwen3 models to 1,536 or 1,024 dimensions, or Arctic to 512, costs nothing measurable. Inside genki's search every model ends up within about two points of text-embedding-3-large, and only the shortened Qwen3-Embedding-8B is significantly ahead there. Taken apart step by step (28 October), fusing keyword search with the vectors costs the most page MRR, and ColBERT orders pages no better than text-embedding-3-large's vectors.

## Sides

text-embedding-3-large at 1,536 dimensions is the current side. Every other model in `../models.json` is a candidate if its vectors have at most 1,536 dimensions; longer ones are graded for reference.

| Side                                                             | Dimensions   | How it ran                                                                 |
| ---------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| text-embedding-3-large (current)                                 | 1,536        | Azure OpenAI (Foundry), shortened by the API                               |
| text-embedding-3-small                                           | 1,536        | Azure OpenAI (Foundry)                                                     |
| bge-m3, snowflake-arctic-embed-l-v2.0                            | 1,024        | PyTorch on the Mac's GPU                                                   |
| Qwen3-Embedding 0.6B, 4B, 8B; F2LLM-v2-0.6B; harrier-oss-v1-0.6b | 1,024–4,096  | MLX for the pages, PyTorch for the questions                               |
| pplx-embed-v1-0.6b                                               | 1,024 (int8) | PyTorch, float32, its own repository code                                  |
| gte-multilingual-base                                            | 768          | PyTorch, its own repository code, under transformers 4.46                  |
| borealis-embed-212m                                              | 768          | PyTorch                                                                    |
| Qwen3-Embedding-8B and 4B @1,536 and @1,024, Arctic @512         | as named     | The full model's stored vectors cut and normalised again (`../shorten.py`) |

Every model's revision, prompts and runtime are in `../models.json` and its run record.

## Reference

`reference/questions.jsonl` (`build_reference.py`): 600 generated questions and 76 draft questions, with their right page or documents. gpt-4o wrote one question per page for pages drawn at random from the pilot's documents (`reference/generated-questions.json`: its model, seed and the pages it declined), every sixth in Nynorsk; the page is the answer. The draft questions are those of `packages/eval/testsets/ka-kudos-draft.yaml` that name their documents. No embedding model or search had a hand in either; no person has reviewed them.

## Decision rule

A candidate replaces text-embedding-3-large when its vectors have at most 1,536 dimensions and its verdict on the primary metric, page MRR on the generated questions by vector search alone, is "not worse" or "better" at a margin of 2 points. Set on 26 October 2026, after the first two rounds of models had run and before the third; `MARGIN` and `MAX_DIMENSIONS` in `report.py`. genki's search without and with the planner are secondary views, graded the same way.

## Method

- **Paired.** Every side is graded on the same questions over the same passages; differences are a side minus another.
- **Intervals** resample whole documents 10,000 times within the sample's strata (test, benchmark and decoy documents) with `benchlib.stats.compare`, seeded per comparison, so adding a model moves no other interval. An interval within 1 point of zero or of the margin is rerun with two more seeds; a verdict that changes is marked borderline.
- **Tiers** on the primary metric: a model starts a new tier only when it is significantly worse than its tier's top model after Holm correction.
- **Instrument checks** in the report: an A/A run and a known loss.
- **Views.** Vector search alone: exact search over every passage, top 100, nothing else. genki search without the planner: keyword and vector search fused with RRF, then ColBERT, ten passages. The full search: gpt-4o plans the searches first; the 76 draft questions, three rounds each, averaged.
- **Search steps.** For text-embedding-3-large and pplx-embed-v1-0.6b, genki's search without the planner is also run cut down to one step at a time (`../chain_steps.sh`, views `search-<step>`): vector search or keyword and vector search fused, each with and without ColBERT, and the whole search without ColBERT. The report's «Which step loses the pages» compares each step with the one it adds to.

## Commands

```sh
cd benchmarks/kudos-pilot/embeddings
../.data/embed-venv/bin/python build_reference.py   # reference/questions.jsonl
# run the models (../README.md), then the full search for each:
#   npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts run 3 <key>   (from the repository root)
# and the search steps: ../chain_steps.sh
../.data/embed-venv/bin/python publish.py           # verdicts and run records, from the pilot's .data and results/runs/
../.data/embed-venv/bin/python report.py            # results/report.md, report.json and differences.csv, from results/ and reference/ alone
../.data/embed-venv/bin/python -m unittest test_report
```

To add a model, give it an entry in `../models.json`, run it (`../run_model.sh <key>`, `../score_search.py <key>`, the full search), then `publish.py` and `report.py`, and read its verdict against text-embedding-3-large.

## Files

| File                                                  | Holds                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `reference/questions.jsonl`                           | The 676 questions, their right pages or documents, clusters and strata                 |
| `reference/generated-questions.json`                  | gpt-4o's questions as written, with the pages it declined                              |
| `results/runs/*.json`                                 | The full-search runs: each round's answers per model                                   |
| `results/sides/<side>/verdicts.jsonl`                 | One line per question and view: page and document scores                               |
| `results/sides/<side>/record.json`                    | What the run used: commit, code, reference and items hashes, model settings and timing |
| `results/report.md`, `report.json`, `differences.csv` | The report, its data, and every difference as a row (`pairwise`: every pair of models) |

## Limits

The report's Limits section lists them; the main ones: no person has reviewed the questions, 300 documents is a small haystack, the draft questions are near the ceiling, and the margin was set after the first two rounds.
