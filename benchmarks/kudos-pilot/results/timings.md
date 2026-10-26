# Kudos pilot: how long everything took

On an M3 Pro (11 cores, 36 GB). Rates are tokens of the model's own tokenizer per second unless said otherwise. Wall time is the clock from start to end of the step, including everything around the model (downloads from KUDOS, database writes, HTTP).

## Marker (PDF to text, once for all models)

306 PDFs, 16,611 pages in 19.5 h of conversion time: 0.24 pages/s, 4.2 s per page; 1,542 pages needed OCR. Every later ingest reused the stored output and sent nothing to Marker.

## Ingest (fetch from KUDOS, stored Marker text, page chunks, embed, write to pgvector)

| Dataset | Documents | Started | Wall time | Embedding tokens | Tokens/s over the wall time | Note |
| --- | --- | --- | --- | --- | --- | --- |
| digdir/kudos-next | 299 | 2026-10-23T05:42 | 8.2 min | 13,504,576 | 27,522 |  |
| digdir/kudos-next | 300 | 2026-10-23T05:53 | 2.7 min | 51,444 | – | vectors from the cache |
| digdir/kudos-next-borealis | 300 | 2026-10-23T13:13 | 25.7 min | 7,163,815 | 4,649 |  |
| digdir/kudos-next-bge-m3 | 300 | 2026-10-23T13:41 | 51.6 min | 11,222,556 | 3,626 |  |
| digdir/kudos-next-arctic-l-v2 | 300 | 2026-10-23T14:33 | 61.3 min | 11,222,556 | 3,051 |  |
| digdir/kudos-next-qwen3-0-6b | 300 | 2026-10-23T16:21 | 2.6 min | 0 | – | vectors from the cache |
| digdir/kudos-next-qwen3-4b | 300 | 2026-10-24T02:25 | 2.7 min | 0 | – | vectors from the cache |
| digdir/kudos-next-qwen3-8b | 300 | 2026-10-24T17:04 | 2.7 min | 0 | – | vectors from the cache |

## Embedding the 20,040 distinct pages

| Model | Runtime | Tokens | Embedding time | Tokens/s | Pages/s |
| --- | --- | --- | --- | --- | --- |
| NbAiLab/borealis-embed-212m | PyTorch MPS server (float32) | 9,600,135 | 29.0 min | 5,509 | 11.5 |
| BAAI/bge-m3 | PyTorch MPS server (float16) | 11,222,556 | 51.2 min | 3,655 | 6.5 |
| Snowflake/snowflake-arctic-embed-l-v2.0 | PyTorch MPS server (float16) | 11,222,556 | 60.7 min | 3,080 | 5.5 |
| Qwen/Qwen3-Embedding-0.6B | MLX batch (float16) | 14,973,428 | 1.9 h | 2,216 | 3.0 |
| Qwen/Qwen3-Embedding-4B | MLX batch (float16) | 15,044,197 | 7.7 h | 541 | 0.7 |
| Qwen/Qwen3-Embedding-8B | MLX batch (float16) | 15,044,197 | 14.0 h | 298 | 0.4 |

## Question generation (gpt-4o on Foundry, 6 at a time)

750 pages asked, 600 questions kept, in 5.2 min.

## Vector-only scoring (676 questions per model)

| Model | Embedding all questions | Exact search over 20,248 pages, p50 |
| --- | --- | --- |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 10.8 s | 36.4 ms |
| text-embedding-3-large | 9.4 s | 51.8 ms |
| BAAI/bge-m3 | 10.8 s | 39.2 ms |
| NbAiLab/borealis-embed-212m | 3.2 s | 30.1 ms |
| Qwen/Qwen3-Embedding-0.6B | 16.8 s | 37.2 ms |
| Qwen/Qwen3-Embedding-4B | 89.5 s | 94.0 ms |
| Qwen/Qwen3-Embedding-8B | 153.9 s | 118.2 ms |

## Full genki search (planner, keywords + vectors, ColBERT), per call

| Run | Side | Calls | p50 | p95 | Sum of calls |
| --- | --- | --- | --- | --- | --- |
| 2026-10-23T07-54 | pgvector | 228 | 3.7 s | 6.3 s | 15.4 min |
| 2026-10-23T07-54 | typesense | 228 | 6.5 s | 10.3 s | 26.5 min |
| 2026-10-23T09-16 | typesense-blind | 228 | 3.6 s | 7.3 s | 15.9 min |
| 2026-10-23T17-43 | arctic-l-v2 | 228 | 3.7 s | 6.0 s | 15.2 min |
| 2026-10-23T17-43 | bge-m3 | 228 | 3.7 s | 6.3 s | 15.0 min |
| 2026-10-23T17-43 | borealis | 228 | 3.6 s | 5.7 s | 14.5 min |
| 2026-10-23T17-43 | pgvector | 228 | 4.4 s | 7.2 s | 17.8 min |
| 2026-10-23T17-43 | qwen3-0-6b | 228 | 3.8 s | 6.3 s | 15.7 min |
| 2026-10-24T02-50 | qwen3-4b | 228 | 5.2 s | 6.3 s | 20.0 min |
| 2026-10-24T17-39 | qwen3-8b | 228 | 7.3 s | 8.9 s | 28.5 min |

## Index and scale benchmark

From 17:43 to 18:38 UTC (55.0 min). Build and load times per step:

| Rows | Step | Index | Memory / workers | Seconds | Rows/s |
| --- | --- | --- | --- | --- | --- |
| 100,000 | load | table | – / – | 1.8 | 55,556 |
| 100,000 | build | hnsw m16 efc64 | 8GB / 4 | 60.9 | 1,642 |
| 100,000 | build | ivfflat lists 100 | 8GB / 4 | 3.5 | 28,571 |
| 250,000 | load | table | – / – | 3.7 | 67,568 |
| 250,000 | build | hnsw m16 efc64 | 8GB / 4 | 47.9 | 5,219 |
| 250,000 | build | ivfflat lists 250 | 8GB / 4 | 10.0 | 25,000 |
| 500,000 | load | table | – / – | 8.1 | 61,728 |
| 500,000 | build | hnsw m16 efc64 | 8GB / 4 | 105.0 | 4,762 |
| 500,000 | build | ivfflat lists 500 | 8GB / 4 | 30.1 | 16,611 |
| 500,000 | build | hnsw bit + rerank | 8GB / 4 | 30.0 | 16,667 |
| 500,000 | build | hnsw m16 efc64 | 2GB / 2 | 153.3 | 3,262 |
| 1,000,000 | load | table | – / – | 19.9 | 50,251 |
| 1,000,000 | build | hnsw m16 efc64 | 8GB / 4 | 228.4 | 4,378 |
| 1,000,000 | build | ivfflat lists 1000 | 8GB / 4 | 106.3 | 9,407 |
| 1,000,000 | build | hnsw bit + rerank | 8GB / 4 | 63.6 | 15,723 |
| 1,000,000 | build | hnsw m32 efc128 | 8GB / 4 | 673.1 | 1,486 |
| 1,000,000 | build | hnsw m16 efc64 | 2GB / 2 | 708.7 | 1,411 |

## The unattended run, step by step

```
bge-m3 failed
bge-m3 done 2026-10-23T14:32:35Z
arctic-l-v2 failed
arctic-l-v2 done 2026-10-23T15:33:51Z
qwen3-0-6b done 2026-10-23T16:24:31Z
chain finished
full search small: start 2026-10-23T16:25:25Z
full search small: done 2026-10-23T17:43:40Z
index bench: start 2026-10-23T17:43:40Z
index bench: done 2026-10-23T18:38:56Z
qwen3-4b: start 2026-10-23T18:38:58Z
```

