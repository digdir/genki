# Embedding models for Kudos

17 embedding models graded on the same 600 generated and 76 draft questions over the same 20,248 page passages of 300 Kudos documents. text-embedding-3-large at 1,536 dimensions is the current side; a candidate has at most 1,536 dimensions. The primary metric is page MRR by vector search alone, and the margin is 2 points.

## Answer

By vector search alone, tier 1: pplx-embed-v1-0.6b, Qwen3-Embedding-8B @1,536, Qwen3-Embedding-8B, Qwen3-Embedding-8B @1,024, Qwen3-Embedding-4B @1,536, Qwen3-Embedding-4B, Qwen3-Embedding-4B @1,024, snowflake-arctic-embed-l-v2.0, snowflake-arctic-embed-l-v2.0 @512, bge-m3; tier 2: harrier-oss-v1-0.6b, text-embedding-3-large; tier 3: Qwen3-Embedding-0.6B, F2LLM-v2-0.6B, text-embedding-3-small, borealis-embed-212m; tier 4: gte-multilingual-base. The best candidate within 1,536 dimensions, pplx-embed-v1-0.6b, scores +8.9 points against text-embedding-3-large (95% interval +5.9 to +12.0): better at a 2-point margin, and this sample detects differences of 4.3 points or more. 9 of 14 candidates are better or not worse; inside genki's search the models end up within a few points of each other.

## Tiers (quality only)

| Tier | Model | Dimensions | Page MRR, vectors alone | Page MRR, genki search | Document MRR, full search |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | pplx-embed-v1-0.6b | 1,024 | 63.2 | 50.4 | 84.8 |
| 1 | Qwen3-Embedding-8B @1,536 | 1,536 | 61.7 | 51.2 | 83.6 |
| 1 | Qwen3-Embedding-8B (over the limit) | 4,096 | 61.6 | 51.1 | 86.1 |
| 1 | Qwen3-Embedding-8B @1,024 | 1,024 | 61.3 | 51.5 | 82.8 |
| 1 | Qwen3-Embedding-4B @1,536 | 1,536 | 61.3 | 50.9 | 84.4 |
| 1 | Qwen3-Embedding-4B (over the limit) | 2,560 | 60.7 | 50.7 | 85.1 |
| 1 | Qwen3-Embedding-4B @1,024 | 1,024 | 60.6 | 50.7 | 84.6 |
| 1 | snowflake-arctic-embed-l-v2.0 | 1,024 | 60.3 | 49.8 | 84.5 |
| 1 | snowflake-arctic-embed-l-v2.0 @512 | 512 | 60.3 | 49.4 | 84.9 |
| 1 | bge-m3 | 1,024 | 58.2 | 49.6 | 86.0 |
| 2 | harrier-oss-v1-0.6b | 1,024 | 58.1 | 50.4 | 84.9 |
| 2 | text-embedding-3-large | 1,536 | 54.2 | 49.4 | 87.0 |
| 3 | Qwen3-Embedding-0.6B | 1,024 | 52.6 | 48.8 | 85.5 |
| 3 | F2LLM-v2-0.6B | 1,024 | 52.1 | 50.3 | 86.9 |
| 3 | text-embedding-3-small | 1,536 | 49.4 | 49.6 | 84.0 |
| 3 | borealis-embed-212m | 768 | 48.1 | 48.7 | 83.9 |
| 4 | gte-multilingual-base | 768 | 46.6 | 47.1 | 83.7 |

Tiers come from the primary metric: a model starts a new tier only when it is significantly worse than the top of its tier, after correcting for every pair compared. The other columns are the secondary views.

## Paired differences against the current side

Each model minus text-embedding-3-large on the same questions. ✱ marks an interval that leaves out zero; the verdict is against a 2-point margin; *borderline* means the verdict or ✱ changed when rerun with two other seeds. Vectors alone and genki search: page MRR on the generated questions; full search: document MRR on the draft questions.

| Model | Vectors alone | genki search, no planner | Full search with planner | Detectable (points), vectors |
| --- | --- | --- | --- | --- |
| pplx-embed-v1-0.6b | +8.9 ✱ (+5.9 to +12.0), better | +1.0 (−0.8 to +2.7), not worse | −2.2 (−5.3 to +0.6), inconclusive | 4.3 |
| Qwen3-Embedding-8B @1,536 | +7.4 ✱ (+3.8 to +11.0), better | +1.8 ✱ (+0.1 to +3.5), better | −3.5 ✱ (−7.5 to 0.0), inconclusive, *borderline* | 5.2 |
| Qwen3-Embedding-8B (over the limit) | +7.4 ✱ (+3.8 to +11.0), better | +1.7 (−0.1 to +3.5), not worse | −1.0 (−4.1 to +2.0), inconclusive | 5.1 |
| Qwen3-Embedding-8B @1,024 | +7.1 ✱ (+3.6 to +10.6), better | +2.1 ✱ (+0.4 to +3.7), better | −4.2 ✱ (−8.7 to −0.4), inconclusive | 5.0 |
| Qwen3-Embedding-4B @1,536 | +7.1 ✱ (+3.3 to +10.8), better | +1.5 (−0.1 to +3.1), not worse | −2.6 (−5.5 to +0.1), inconclusive | 5.4 |
| Qwen3-Embedding-4B (over the limit) | +6.5 ✱ (+2.8 to +10.1), better | +1.3 (−0.4 to +2.9), not worse | −2.0 (−5.3 to +1.2), inconclusive | 5.3 |
| Qwen3-Embedding-4B @1,024 | +6.4 ✱ (+2.7 to +10.1), better | +1.2 (−0.4 to +2.9), not worse | −2.4 (−5.7 to +0.7), inconclusive | 5.3 |
| snowflake-arctic-embed-l-v2.0 | +6.1 ✱ (+2.4 to +9.7), better | +0.4 (−1.5 to +2.2), not worse | −2.5 (−5.6 to +0.4), inconclusive | 5.2 |
| snowflake-arctic-embed-l-v2.0 @512 | +6.1 ✱ (+2.4 to +9.8), better | 0.0 (−1.8 to +1.8), not worse | −2.1 (−5.1 to +0.7), inconclusive | 5.3 |
| bge-m3 | +4.0 ✱ (+0.6 to +7.3), better | +0.1 (−1.4 to +1.7), not worse | −1.0 (−4.5 to +2.4), inconclusive | 4.8 |
| harrier-oss-v1-0.6b | +3.8 ✱ (+0.5 to +7.2), better | +0.9 (−0.9 to +2.8), not worse | −2.1 (−6.3 to +1.8), inconclusive | 4.8 |
| Qwen3-Embedding-0.6B | −1.6 (−5.5 to +2.1), inconclusive | −0.6 (−2.2 to +1.0), inconclusive | −1.5 (−5.4 to +1.7), inconclusive | 5.4 |
| F2LLM-v2-0.6B | −2.1 (−5.0 to +1.2), inconclusive | +0.9 (−0.8 to +2.6), not worse | −0.1 (−2.7 to +2.6), inconclusive | 4.4 |
| text-embedding-3-small | −4.8 ✱ (−7.7 to −2.1), worse | +0.1 (−1.3 to +1.7), not worse | −3.0 (−6.7 to +0.7), inconclusive | 4.0 |
| borealis-embed-212m | −6.1 ✱ (−9.5 to −2.8), worse | −0.7 (−2.2 to +0.8), inconclusive | −3.1 (−7.2 to +0.5), inconclusive | 4.8 |
| gte-multilingual-base | −7.6 ✱ (−11.1 to −4.2), worse | −2.3 ✱ (−4.1 to −0.6), inconclusive | −3.4 ✱ (−7.0 to −0.3), inconclusive | 4.9 |

Every pair of models on the primary metric, with its interval, is in `differences.csv` (metric `pairwise`).

## Every view

### Vector search alone

| Model | Dimensions | Right page first | Right page in top 10 | Right page in top 100 | Page MRR | Right document in top 10 | Draft: document MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pplx-embed-v1-0.6b | 1,024 | 51.3 | 85.5 | 96.2 | 63.2 | 99.0 | 90.6 |
| Qwen3-Embedding-8B @1,536 | 1,536 | 50.3 | 84.2 | 97.7 | 61.7 | 99.0 | 94.6 |
| Qwen3-Embedding-8B | 4,096 | 50.0 | 85.0 | 97.5 | 61.6 | 99.0 | 93.5 |
| Qwen3-Embedding-8B @1,024 | 1,024 | 49.8 | 84.2 | 97.7 | 61.3 | 98.7 | 94.8 |
| Qwen3-Embedding-4B @1,536 | 1,536 | 49.7 | 82.7 | 97.0 | 61.3 | 97.8 | 96.1 |
| Qwen3-Embedding-4B | 2,560 | 48.7 | 82.8 | 97.3 | 60.7 | 98.2 | 94.1 |
| Qwen3-Embedding-4B @1,024 | 1,024 | 49.2 | 82.5 | 96.0 | 60.6 | 98.0 | 91.9 |
| snowflake-arctic-embed-l-v2.0 | 1,024 | 48.3 | 81.0 | 94.3 | 60.3 | 98.8 | 94.3 |
| snowflake-arctic-embed-l-v2.0 @512 | 512 | 49.3 | 80.3 | 94.2 | 60.3 | 98.7 | 93.0 |
| bge-m3 | 1,024 | 46.5 | 81.7 | 94.7 | 58.2 | 99.0 | 92.3 |
| harrier-oss-v1-0.6b | 1,024 | 46.3 | 80.7 | 94.7 | 58.1 | 97.3 | 91.8 |
| text-embedding-3-large | 1,536 | 40.8 | 77.7 | 93.5 | 54.2 | 98.2 | 86.9 |
| Qwen3-Embedding-0.6B | 1,024 | 41.2 | 73.7 | 92.7 | 52.6 | 97.5 | 90.9 |
| F2LLM-v2-0.6B | 1,024 | 39.5 | 74.3 | 93.5 | 52.1 | 98.0 | 81.1 |
| text-embedding-3-small | 1,536 | 36.3 | 73.5 | 91.2 | 49.4 | 97.2 | 86.4 |
| borealis-embed-212m | 768 | 36.3 | 72.3 | 92.2 | 48.1 | 97.5 | 88.4 |
| gte-multilingual-base | 768 | 35.2 | 68.5 | 89.0 | 46.6 | 98.5 | 87.0 |

Percentages of the 600 generated questions, except the last column (the 76 draft questions).

### genki search without the planner

| Model | Right page first | Right page in top 10 | Page MRR | Right document in top 10 | Draft: document MRR |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3-Embedding-8B @1,024 | 39.8 | 76.0 | 51.5 | 95.3 | 85.2 |
| Qwen3-Embedding-8B @1,536 | 39.8 | 76.0 | 51.2 | 95.5 | 85.3 |
| Qwen3-Embedding-8B | 39.8 | 75.8 | 51.1 | 95.3 | 87.5 |
| Qwen3-Embedding-4B @1,536 | 40.0 | 74.8 | 50.9 | 95.0 | 85.7 |
| Qwen3-Embedding-4B | 39.7 | 74.8 | 50.7 | 95.3 | 87.8 |
| Qwen3-Embedding-4B @1,024 | 40.0 | 74.7 | 50.7 | 94.0 | 86.2 |
| pplx-embed-v1-0.6b | 38.8 | 75.0 | 50.4 | 94.7 | 86.6 |
| harrier-oss-v1-0.6b | 39.0 | 74.8 | 50.4 | 94.7 | 86.3 |
| F2LLM-v2-0.6B | 39.8 | 72.8 | 50.3 | 94.2 | 86.2 |
| snowflake-arctic-embed-l-v2.0 | 38.5 | 73.8 | 49.8 | 95.7 | 86.4 |
| text-embedding-3-small | 39.0 | 72.3 | 49.6 | 95.2 | 84.2 |
| bge-m3 | 38.5 | 74.3 | 49.6 | 95.7 | 86.1 |
| text-embedding-3-large | 37.8 | 73.5 | 49.4 | 94.7 | 87.3 |
| snowflake-arctic-embed-l-v2.0 @512 | 38.0 | 73.2 | 49.4 | 95.7 | 86.4 |
| Qwen3-Embedding-0.6B | 38.5 | 71.0 | 48.8 | 94.3 | 84.8 |
| borealis-embed-212m | 37.8 | 72.0 | 48.7 | 94.7 | 89.5 |
| gte-multilingual-base | 37.0 | 68.8 | 47.1 | 94.2 | 84.6 |

### Full search with the planner

| Model | Recall@10 | MRR | nDCG@10 |
| --- | ---: | ---: | ---: |
| text-embedding-3-large | 96.1 | 87.0 | 89.1 |
| F2LLM-v2-0.6B | 96.9 | 86.9 | 89.3 |
| Qwen3-Embedding-8B | 96.5 | 86.1 | 88.3 |
| bge-m3 | 97.4 | 86.0 | 88.5 |
| Qwen3-Embedding-0.6B | 95.6 | 85.5 | 87.9 |
| Qwen3-Embedding-4B | 97.8 | 85.1 | 87.9 |
| harrier-oss-v1-0.6b | 95.8 | 84.9 | 87.3 |
| snowflake-arctic-embed-l-v2.0 @512 | 95.8 | 84.9 | 87.3 |
| pplx-embed-v1-0.6b | 97.4 | 84.8 | 87.9 |
| Qwen3-Embedding-4B @1,024 | 97.6 | 84.6 | 87.5 |
| snowflake-arctic-embed-l-v2.0 | 95.8 | 84.5 | 86.9 |
| Qwen3-Embedding-4B @1,536 | 97.6 | 84.4 | 87.6 |
| text-embedding-3-small | 96.1 | 84.0 | 86.4 |
| borealis-embed-212m | 96.1 | 83.9 | 86.7 |
| gte-multilingual-base | 98.0 | 83.7 | 87.1 |
| Qwen3-Embedding-8B @1,536 | 96.1 | 83.6 | 86.4 |
| Qwen3-Embedding-8B @1,024 | 95.4 | 82.8 | 85.6 |

The 76 draft questions, document level, each averaged over three rounds.

### What genki's search keeps of the vectors

| Model | Right page in top 10, vectors alone | In genki's search | Lost |
| --- | ---: | ---: | ---: |
| pplx-embed-v1-0.6b | 85.5 | 75.0 | 10.5 |
| Qwen3-Embedding-8B | 85.0 | 75.8 | 9.2 |
| Qwen3-Embedding-8B @1,024 | 84.2 | 76.0 | 8.2 |
| Qwen3-Embedding-8B @1,536 | 84.2 | 76.0 | 8.2 |
| Qwen3-Embedding-4B | 82.8 | 74.8 | 8.0 |
| Qwen3-Embedding-4B @1,536 | 82.7 | 74.8 | 7.8 |
| Qwen3-Embedding-4B @1,024 | 82.5 | 74.7 | 7.8 |
| bge-m3 | 81.7 | 74.3 | 7.3 |
| snowflake-arctic-embed-l-v2.0 | 81.0 | 73.8 | 7.2 |
| snowflake-arctic-embed-l-v2.0 @512 | 80.3 | 73.2 | 7.2 |
| harrier-oss-v1-0.6b | 80.7 | 74.8 | 5.8 |
| text-embedding-3-large | 77.7 | 73.5 | 4.2 |
| Qwen3-Embedding-0.6B | 73.7 | 71.0 | 2.7 |
| F2LLM-v2-0.6B | 74.3 | 72.8 | 1.5 |
| text-embedding-3-small | 73.5 | 72.3 | 1.2 |
| borealis-embed-212m | 72.3 | 72.0 | 0.3 |
| gte-multilingual-base | 68.5 | 68.8 | −0.3 |

### Which step loses the pages

genki's search without the planner taken apart for text-embedding-3-large and pplx-embed-v1-0.6b: vector search or keyword and vector search fused, each with and without ColBERT, then the whole search without ColBERT. Each step returns ten passages; the vector and fusion steps run one search of the passages and nothing else.

| Step | text-embedding-3-large: Right page in top 10 | text-embedding-3-large: Page MRR | pplx-embed-v1-0.6b: Right page in top 10 | pplx-embed-v1-0.6b: Page MRR |
| --- | ---: | ---: | ---: | ---: |
| Vector search alone (exact) | 77.7 | 54.2 | 85.5 | 63.2 |
| Vector search through genki | 77.0 | 53.4 | 84.7 | 62.5 |
| Vector search, then ColBERT | 75.7 | 52.1 | 78.7 | 52.4 |
| Keyword and vector search fused | 72.7 | 44.0 | 69.3 | 41.3 |
| Fused, then ColBERT | 71.8 | 48.0 | 70.5 | 47.4 |
| genki search without ColBERT | 79.5 | 51.0 | 79.5 | 49.2 |
| genki search | 73.5 | 49.4 | 75.0 | 50.4 |

| What the step adds | text-embedding-3-large: Right page in top 10 | text-embedding-3-large: Page MRR | pplx-embed-v1-0.6b: Right page in top 10 | pplx-embed-v1-0.6b: Page MRR |
| --- | --- | --- | --- | --- |
| genki's vector search (HNSW) instead of exact search | −0.7 ✱ (−1.4 to −0.2) | −0.9 ✱ (−1.0 to −0.7) | −0.8 ✱ (−1.6 to −0.2) | −0.6 ✱ (−1.1 to −0.2) |
| ColBERT on the vector results | −1.3 (−4.7 to +1.8) | −1.3 (−5.0 to +2.3) | −6.0 ✱ (−9.1 to −3.3) | −10.1 ✱ (−13.6 to −6.6) |
| Keyword search fused with the vectors | −4.3 ✱ (−7.6 to −1.1) | −9.3 ✱ (−12.7 to −6.0) | −15.3 ✱ (−18.8 to −11.8) | −21.2 ✱ (−24.1 to −18.3) |
| ColBERT on the fused results | −0.8 (−3.9 to +2.0) | +3.9 ✱ (+0.7 to +7.2) | +1.2 (−1.7 to +4.0) | +6.1 ✱ (+2.7 to +9.5) |
| The rest of genki's search: the metadata search, query-aware boosts, filters guessed from the question (the pilot has no search phrases) | +6.8 ✱ (+3.8 to +9.9) | +7.0 ✱ (+4.2 to +9.6) | +10.2 ✱ (+6.9 to +13.3) | +7.9 ✱ (+5.4 to +10.3) |
| ColBERT on the whole search | −6.0 ✱ (−8.6 to −3.5) | −1.5 (−5.2 to +2.2) | −4.5 ✱ (−7.2 to −2.0) | +1.2 (−2.3 to +4.8) |

Each difference is the step minus the one it adds to, in points, with its 95% interval; ✱ marks an interval that leaves out zero.

## Bokmål and Nynorsk (exploratory)

| Model | Bokmål (page MRR) | Nynorsk (page MRR) | Nynorsk − text-embedding-3-large |
| --- | ---: | ---: | --- |
| Qwen3-Embedding-8B @1,536 | 61.1 | 64.7 | +9.4 ✱ (+0.1 to +18.4) |
| Qwen3-Embedding-8B @1,024 | 60.7 | 64.6 | +9.3 ✱ (0.0 to +18.4) |
| Qwen3-Embedding-4B | 60.0 | 64.2 | +8.9 (−1.2 to +18.4) |
| Qwen3-Embedding-8B | 61.1 | 64.0 | +8.7 (−0.3 to +17.4) |
| Qwen3-Embedding-4B @1,536 | 60.8 | 63.9 | +8.6 (−1.5 to +18.1) |
| Qwen3-Embedding-4B @1,024 | 60.0 | 63.7 | +8.4 (−1.8 to +18.0) |
| pplx-embed-v1-0.6b | 63.1 | 63.2 | +7.9 (−0.4 to +16.0) |
| snowflake-arctic-embed-l-v2.0 | 60.2 | 61.0 | +5.7 (−4.2 to +15.1) |
| bge-m3 | 58.0 | 59.3 | +4.0 (−5.5 to +13.3) |
| snowflake-arctic-embed-l-v2.0 @512 | 60.6 | 58.6 | +3.3 (−6.2 to +12.3) |
| harrier-oss-v1-0.6b | 58.2 | 57.4 | +2.1 (−6.5 to +10.7) |
| F2LLM-v2-0.6B | 51.4 | 55.8 | +0.5 (−8.1 to +9.2) |
| Qwen3-Embedding-0.6B | 52.0 | 55.3 | 0.0 (−9.5 to +9.0) |
| text-embedding-3-small | 49.5 | 48.9 | −6.4 (−14.2 to +1.0) |
| borealis-embed-212m | 48.3 | 46.9 | −8.4 ✱ (−16.3 to −1.0) |
| gte-multilingual-base | 46.5 | 46.9 | −8.4 (−18.5 to +0.9) |

Vector search alone. text-embedding-3-large: Bokmål 54.0, Nynorsk 55.3.

## Where a model loses

Generated questions where one side has the right page in its top 10 by vector search alone and the other does not.

| Model | Only the model finds it | Only text-embedding-3-large finds it |
| --- | ---: | ---: |
| pplx-embed-v1-0.6b | 67 | 20 |
| Qwen3-Embedding-8B @1,536 | 69 | 30 |
| Qwen3-Embedding-8B | 74 | 30 |
| Qwen3-Embedding-8B @1,024 | 73 | 34 |
| Qwen3-Embedding-4B @1,536 | 67 | 37 |
| Qwen3-Embedding-4B | 69 | 38 |
| Qwen3-Embedding-4B @1,024 | 67 | 38 |
| snowflake-arctic-embed-l-v2.0 | 62 | 42 |
| snowflake-arctic-embed-l-v2.0 @512 | 59 | 43 |
| bge-m3 | 65 | 41 |
| harrier-oss-v1-0.6b | 63 | 45 |
| Qwen3-Embedding-0.6B | 55 | 79 |
| F2LLM-v2-0.6B | 45 | 65 |
| text-embedding-3-small | 33 | 58 |
| borealis-embed-212m | 44 | 76 |
| gte-multilingual-base | 43 | 98 |

### Only pplx-embed-v1-0.6b finds the page (67)

- `gen-0028` (nb): "Hva er målene for kompetanseutvikling i forbedringsarbeid ved Nordlandssykehuset i perioden 2023-2026?" Page 76 of "Strategisk utviklingsplan : = Strategijjalasj åvddånimpládna : revidert plan for perioden 2023-2026".
- `gen-0034` (nb): "Hva var sykefraværet ved Barratt Due Musikkinstitutt i 2017?" Page 39 of "Årsrapport Barratt Due Musikkinstitutt 2017 (KD)".
- `gen-0035` (nb): "Hvilke tiltak har blitt igangsatt som følge av Riksrevisjonens undersøkelse av helse- og omsorgstjenester til barn med funksjonsnedsettelser?" Page 79 of "Evaluering av Riksrevisjonens virksomhet".
- `gen-0051` (nb): "Hvordan balanserer noen kommuner utfordringene med tolk i foreldreveiledningskurs?" Page 77 of "Foreldrekurs og foreldreveiledning ved høye ankomster".
- `gen-0065` (nb): "Hva er hovedmålet med E2SOILAGRI-prosjektet som NIBIO er partner i?" Page 3 of "Enhancement of sustainable land soil resource management in agriculture - E2SOILAGRI. Final project implementation review (PIR)".
- `gen-0072` (nb): "På hvilke måter har Riksrevisjonen gitt veiledning til virksomheter om regnskapsrevisjon?" Page 143 of "Evaluering av Riksrevisjonens virksomhet".
- `gen-0082` (nb): "Hva var Vinmonopolets totale gjeld og egenkapital i 2023?" Page 67 of "Årsrapport Vinmonopolet 2023 (HOD)".
- `gen-0098` (nb): "Hvilke organisasjoner samarbeider Norad med i TVET-initiativet, og hvilke programmer er nevnt?" Page 35 of "Midtveisgjennomgang  av  norsk yrkesutdanningsportefølje".

### Only text-embedding-3-large finds the page (20)

- `gen-0033` (nb): "Hvor mange klagesaker rapporterte Statsforvalteren i Trøndelag i 2024 i forbindelse med introduksjonsordningen for nyankomne innvandrere, og hva var utfallet av disse?" Page 85 of "Årsrapport Statsforvalteren i Trøndelag 2024".
- `gen-0073` (nb): "Hvor mange saker har blitt registrert i TryggEst-pilotkommunene siden oppstarten i oktober 2019?" Page 54 of "TryggEst: Bedre beskyttelse av overgrepsutsatte voksne. Sluttrapport: To års forsøk med TryggEst.".
- `gen-0107` (nb): "Hva kreves av nye verger i Agder i 2024 når det gjelder opplæring?" Page 60 of "Årsrapport Statsforvalteren i Agder 2024".
- `gen-0118` (nn): "Kva immaterielle eigendelar hadde Dronning Mauds Minne Høgskole for barnehagelærarutdanning ved utgangen av 2020?" Page 51 of "Årsrapport Dronning Mauds Minne Høgskole 2020 (KD)".
- `gen-0129` (nb): "Hva er netto driftsresultat, og hvordan beregnes det for kommuner og fylkeskommuner?" Page 206 of "Rapport fra Det tekniske beregningsutvalg for kommunal og fylkeskommunal økonomi, november 2023".
- `gen-0140` (nn): "Kva er ansvaret til Kommunal- og moderniseringsdepartementet i samepolitikken?" Page 10 of "Meld. St. 31 (2019–2020)".
- `gen-0187` (nb): "Hva forventer regjeringen at universiteter og høyskoler gjør for å sikre kvalitet i praksis?" Page 62 of "Meld. St. 16 (2020–2021)".
- `gen-0220` (nn): "Kva var dei totale investeringskostnadane for Statens pensjonsfond utland i 2019, og kor mange basispunkt utgjorde dei?" Page 8 of "Rapport fra CEM Benchmarking om SPN i 2019".

## How the reference was made

The reference is `reference/questions.jsonl`: each question with its right page or documents. gpt-4o wrote one question per page for 600 pages drawn at random from the pilot's documents (`reference/generated-questions.json` keeps its model, seed and the pages it declined), every sixth in Nynorsk; the page is the answer. The draft questions are Kunnskapsassistenten's draft test set (`packages/eval/testsets/ka-kudos-draft.yaml`), matched to the pilot's documents by their old ids. No embedding model, and no search, had a hand in either. No person has reviewed them yet.

Generated questions by the stratum their document was drawn in: benchmark 270, decoy 161, test 169. Intervals resample whole documents within these strata.

## Instrument checks

- **No real difference (A/A).** pplx-embed-v1-0.6b's and text-embedding-3-large's results swapped at random within each document, 1000 times: the 95% interval left out zero 5.4% of the time. About 5% is right; much more would mean the intervals are too narrow.
- **A known loss.** pplx-embed-v1-0.6b with every question missed on a seeded share of documents, against intact: 5% of documents −3.3 ✱ (−6.7 to −1.0), inconclusive; 10% of documents −7.6 ✱ (−12.1 to −3.7), worse. A candidate with either loss would not pass as "not worse".

- **The full search varies from run to run.** A shortened model finds the same pages as its full-length model without the planner, so a gap between them with the planner comes from the run (gpt-4o plans differently each time, and the runs are from different days), not from the vectors:

| Shortened minus full length | Full search with planner | genki search, no planner |
| --- | --- | --- |
| snowflake-arctic-embed-l-v2.0 @512 − snowflake-arctic-embed-l-v2.0 | +0.4 (−1.3 to +2.1) | −0.4 (−1.3 to +0.5) |
| Qwen3-Embedding-4B @1,024 − Qwen3-Embedding-4B | −0.4 (−1.6 to +0.9) | 0.0 (−0.7 to +0.6) |
| Qwen3-Embedding-4B @1,536 − Qwen3-Embedding-4B | −0.7 (−3.1 to +1.5) | +0.2 (−0.6 to +1.0) |
| Qwen3-Embedding-8B @1,024 − Qwen3-Embedding-8B | −3.3 ✱ (−6.9 to −0.6) | +0.4 (−0.3 to +1.2) |
| Qwen3-Embedding-8B @1,536 − Qwen3-Embedding-8B | −2.5 (−5.7 to 0.0) | +0.1 (−0.5 to +0.7) |

## Limits

- No person has reviewed the questions. gpt-4o wrote the generated ones from single pages, so they may lean on the page's own wording, which favours models trained on machine-written questions.
- One page counts as right. If another page also answers a generated question, finding it counts as a miss, the same for every model.
- 300 documents, with look-alikes added on purpose; all of Kudos has over a hundred times more pages.
- The draft questions are near the ceiling, so the full search with the planner separates the models poorly; the planner was not run on the generated questions, since each search costs a gpt-4o call.
- Few Nynorsk questions (99), and most must find a Bokmål page. Slices other than the primary metric are exploratory: with this many comparisons, some differences marked ✱ will be chance.
- One setting of genki's search. Other fusion weights, more candidates or another reranker could change how much of a model's lead survives.
- Qwen3-Embedding-8B at full length (4,096 dimensions) was searched without an index, which pgvector can't build above 4,000; every other side was searched as genki searches it.
- pplx-embed-v1 gives int8 vectors by design and was graded on them; gte-multilingual-base ran its own repository code under transformers 4.46.
- The full-search runs are from four days (23, 24, 26 and 27 October 2026); gpt-4o's planning varies from run to run, which three rounds per question only partly evens out: see the run-to-run check under Instrument checks.
- The run records were written on 26 October 2026, after the runs: their code hash is of the code then, and the margin and the dimension limit were set after the first two rounds had run.
- The search steps were run for two sides only, text-embedding-3-large and pplx-embed-v1-0.6b, on 28 October 2026, after the other runs.

## Words used here

- **Reference**: the known-right answers every side is measured against, made without looking at any side's output.
- **Side**: one of the things compared: the current component, or a candidate for replacing it.
- **Paired difference**: both sides graded on exactly the same items, so the difference compares like with like.
- **95% interval**: the range the difference would likely fall in with another sample of documents, from resampling whole documents. If it leaves out zero, the difference is unlikely to be chance (✱).
- **Margin**: how much worse a candidate may be and still replace the current side, set before the run.
- **Verdict**: better: the whole interval is above zero. Not worse: the whole interval is above minus the margin. Worse: the whole interval is below minus the margin. Inconclusive: none of these; more items are needed.
- **Detectable**: the smallest difference this sample would find with 80% power. A difference smaller than this can hide in a sample this size.
- **Tier**: sides that the data can't tell apart, after correcting for comparing several pairs at once.
- **Embedding model**: a model that turns a text into a list of numbers (a vector) so that texts with similar meaning get similar vectors. It finds passages; it does not write answers.
- **Dimensions**: how many numbers each vector has. More can hold more nuance but cost more storage and memory.
- **Shortened (@1,024)**: a model trained so its vectors keep their meaning in the first numbers (Matryoshka), cut to that many and normalised again. Built here from the full vectors.
- **Vector search alone**: the question's vector against every page's vector, exactly, nothing else: the model on its own.
- **genki search**: genki's retrieval as it runs: keyword and vector search fused, then ColBERT reranking, ten passages. With the planner, gpt-4o first rewrites the question into several searches.
- **Fusion (RRF)**: merging the keyword and the vector results into one list; reciprocal rank fusion rewards passages that rank high in either.
- **ColBERT**: a second model that reads the question with each candidate passage and puts them in a new order (reranking).
- **Page MRR**: how high the right page sits: first place counts 1, second 1/2, third 1/3, not in the list 0, averaged over questions and shown on a 0 to 100 scale.
- **Recall@k**: the share of questions whose right page (or document) is among the first k results.
- **Generated questions**: 600 questions gpt-4o wrote, one per randomly drawn page, with that page as the answer. Not reviewed by a person.
- **Draft questions**: the 76 questions of Kunnskapsassistenten's draft test set that name the document that answers them. Not reviewed by a person.

## Notes: time and cost (not part of the ranking)

- text-embedding-3-large: embedded the 20,040 distinct pages in 8 min (27,522 tokens/s, Azure OpenAI, the ingest's wall time); genki search without the planner p50 1.0 s; with the planner p50 4.4 s.
- borealis-embed-212m: embedded the 20,040 distinct pages in 29 min (5,509 tokens/s, PyTorch MPS float32); genki search without the planner p50 1.0 s; with the planner p50 3.6 s.
- bge-m3: embedded the 20,040 distinct pages in 51 min (3,655 tokens/s, PyTorch MPS float16); genki search without the planner p50 1.0 s; with the planner p50 3.7 s.
- snowflake-arctic-embed-l-v2.0: embedded the 20,040 distinct pages in 61 min (3,080 tokens/s, PyTorch MPS float16); genki search without the planner p50 1.0 s; with the planner p50 3.7 s.
- Qwen3-Embedding-0.6B: embedded the 20,040 distinct pages in 113 min (2,216 tokens/s, MLX float16); genki search without the planner p50 1.4 s; with the planner p50 3.8 s.
- Qwen3-Embedding-4B: embedded the 20,040 distinct pages in 463 min (541 tokens/s, MLX float16); genki search without the planner p50 0.9 s; with the planner p50 5.2 s.
- Qwen3-Embedding-8B: embedded the 20,040 distinct pages in 842 min (298 tokens/s, MLX float16); genki search without the planner p50 1.3 s; with the planner p50 7.3 s.
- gte-multilingual-base: embedded the 20,040 distinct pages in 20 min (9,577 tokens/s, PyTorch MPS float16); genki search without the planner p50 0.6 s; with the planner p50 3.3 s.
- pplx-embed-v1-0.6b: embedded the 20,040 distinct pages in 223 min (1,132 tokens/s, PyTorch MPS float32); genki search without the planner p50 0.6 s; with the planner p50 4.2 s.
- F2LLM-v2-0.6B: embedded the 20,040 distinct pages in 67 min (3,744 tokens/s, MLX float16); genki search without the planner p50 0.8 s; with the planner p50 4.0 s.
- harrier-oss-v1-0.6b: embedded the 20,040 distinct pages in 68 min (3,713 tokens/s, MLX float16); genki search without the planner p50 0.8 s; with the planner p50 4.4 s.
- text-embedding-3-small: embedded the 20,040 distinct pages in 9 min (26,254 tokens/s, Azure OpenAI, the ingest's wall time); genki search without the planner p50 0.9 s; with the planner p50 4.7 s.
- snowflake-arctic-embed-l-v2.0 @512: genki search without the planner p50 0.8 s; with the planner p50 3.6 s.
- Qwen3-Embedding-4B @1,024: genki search without the planner p50 0.9 s; with the planner p50 5.6 s.
- Qwen3-Embedding-4B @1,536: genki search without the planner p50 0.9 s; with the planner p50 5.8 s.
- Qwen3-Embedding-8B @1,024: genki search without the planner p50 1.1 s; with the planner p50 7.8 s.
- Qwen3-Embedding-8B @1,536: genki search without the planner p50 1.3 s; with the planner p50 11.7 s.
- Times are from one MacBook Pro (M3 Pro, 36 GB): some runs shared its GPU with another, and a server with a proper GPU would be many times faster. Shortened models reuse the full model's vectors and embed nothing.
- Converting the 306 PDFs with Marker took 19.5 hours, once, for every model.
- Azure OpenAI: text-embedding-3-large for the pilot's ingest ($1.80), gpt-4o writing the questions ($2.50) and planning 3,876 full searches (about $11.17); everything else ran locally, ColBERT on Digdir's own server.

## Run record

| Model | Commit | Uncommitted changes | Published | Reference | Runtime | Scored |
| --- | --- | --- | --- | --- | --- | --- |
| text-embedding-3-large | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | Azure OpenAI (Foundry) | full search from full-search-3-large-and-small-models.json; search 2026-10-23; search-fusion 2026-10-28; search-fusion-colbert 2026-10-28; search-nocolbert 2026-10-28; search-vector 2026-10-28; search-vector-colbert 2026-10-28; vectors 2026-10-23 |
| borealis-embed-212m | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | PyTorch MPS | full search from full-search-3-large-and-small-models.json; search 2026-10-23; vectors 2026-10-23 |
| bge-m3 | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | PyTorch MPS | full search from full-search-3-large-and-small-models.json; search 2026-10-23; vectors 2026-10-23 |
| snowflake-arctic-embed-l-v2.0 | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | PyTorch MPS | full search from full-search-3-large-and-small-models.json; search 2026-10-23; vectors 2026-10-23 |
| Qwen3-Embedding-0.6B | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | MLX (pages), PyTorch MPS (questions) | full search from full-search-3-large-and-small-models.json; search 2026-10-23; vectors 2026-10-23 |
| Qwen3-Embedding-4B | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | MLX (pages), PyTorch MPS (questions) | full search from full-search-qwen3-4b.json; search 2026-10-24; vectors 2026-10-24 |
| Qwen3-Embedding-8B | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | MLX (pages), PyTorch MPS (questions) | full search from full-search-qwen3-8b.json; search 2026-10-24; vectors 2026-10-24 |
| gte-multilingual-base | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | PyTorch MPS | full search from full-search-gte-ml-base.json; search 2026-10-26; vectors 2026-10-26 |
| pplx-embed-v1-0.6b | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | PyTorch MPS | full search from full-search-pplx-0-6b.json; search 2026-10-27; search-fusion 2026-10-28; search-fusion-colbert 2026-10-28; search-nocolbert 2026-10-28; search-vector 2026-10-28; search-vector-colbert 2026-10-28; vectors 2026-10-27 |
| F2LLM-v2-0.6B | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | MLX (pages), PyTorch MPS (questions) | full search from full-search-f2llm-0-6b.json; search 2026-10-26; vectors 2026-10-26 |
| harrier-oss-v1-0.6b | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | MLX (pages), PyTorch MPS (questions) | full search from full-search-harrier-0-6b.json; search 2026-10-26; vectors 2026-10-26 |
| text-embedding-3-small | 6d7339a0d7da | yes | 2026-10-28T08:26:25+00:00 | eae429d25079 | Azure OpenAI (Foundry) | full search from full-search-te3-small.json; search 2026-10-27; vectors 2026-10-27 |
| snowflake-arctic-embed-l-v2.0 @512 | 6d7339a0d7da | yes | 2026-10-28T08:26:26+00:00 | eae429d25079 | cut from arctic-l-v2's stored vectors | full search from full-search-arctic-l-v2-512.json; search 2026-10-27; vectors 2026-10-27 |
| Qwen3-Embedding-4B @1,024 | 6d7339a0d7da | yes | 2026-10-28T08:26:26+00:00 | eae429d25079 | cut from qwen3-4b's stored vectors | full search from full-search-qwen3-4b-1024.json; search 2026-10-27; vectors 2026-10-27 |
| Qwen3-Embedding-4B @1,536 | 6d7339a0d7da | yes | 2026-10-28T08:26:26+00:00 | eae429d25079 | cut from qwen3-4b's stored vectors | full search from full-search-qwen3-4b-1536.json; search 2026-10-27; vectors 2026-10-27 |
| Qwen3-Embedding-8B @1,024 | 6d7339a0d7da | yes | 2026-10-28T08:26:26+00:00 | eae429d25079 | cut from qwen3-8b's stored vectors | full search from full-search-qwen3-8b-1024.json; search 2026-10-27; vectors 2026-10-27 |
| Qwen3-Embedding-8B @1,536 | 6d7339a0d7da | yes | 2026-10-28T08:26:26+00:00 | eae429d25079 | cut from qwen3-8b's stored vectors | full search from full-search-qwen3-8b-1536.json; search 2026-10-27; vectors 2026-10-27 |
