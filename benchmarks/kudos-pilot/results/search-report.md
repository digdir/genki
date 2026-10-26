# Kudos pilot: embedding models in genki's search, without the planner

Each question goes as asked to the model's kudos-pilot-<key>-noplan-retrieve-only service: keywords and vectors fused with RRF, then ColBERT, the answer's ten passages scored. No planner (no model call). Generated questions: one per page, written by gpt-4o, the page is the answer (unreviewed). Draft questions: the 76 ka-kudos-draft questions with an expected document. Differences are against text-embedding-3-large@1536, paired bootstrap, 95% interval.

## All generated questions

| Model | Dims | Page R@1 | Page R@10 | Page R@100 | Page MRR | Doc R@10 (gen.) | Doc R@10 (draft) | Doc MRR (draft) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| text-embedding-3-large | 1536 | 37.8 | 73.5 | 73.5 | 49.4 | 94.7 | 96.1 | 87.3 |
| NbAiLab/borealis-embed-212m | 768 | 37.8 (+0.0; -1.8 to +1.8) | 72.0 (-1.5; -3.8 to +0.8) | 72.0 (-1.5; -3.8 to +0.8) | 48.7 (-0.7; -2.4 to +0.9) | 94.7 (+0.0; -1.2 to +1.2) | 98.0 (+2.0; +0.0 to +5.3) | 89.5 (+2.2; -0.9 to +5.8) |
| BAAI/bge-m3 | 1024 | 38.5 (+0.7; -1.2 to +2.5) | 74.3 (+0.8; -1.5 to +3.2) | 74.3 (+0.8; -1.7 to +3.2) | 49.6 (+0.1; -1.6 to +2.0) | 95.7 (+1.0; -0.2 to +2.3) | 98.0 (+2.0; +0.0 to +5.3) | 86.1 (-1.2; -5.2 to +2.6) |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 1024 | 38.5 (+0.7; -1.3 to +2.7) | 73.8 (+0.3; -2.2 to +2.8) | 73.8 (+0.3; -2.2 to +2.8) | 49.8 (+0.4; -1.4 to +2.2) | 95.7 (+1.0; -0.2 to +2.2) | 96.7 (+0.7; +0.0 to +2.0) | 86.4 (-0.8; -4.3 to +2.6) |
| Qwen/Qwen3-Embedding-0.6B | 1024 | 38.5 (+0.7; -1.3 to +2.8) | 71.0 (-2.5; -5.2 to +0.2) | 71.0 (-2.5; -5.2 to +0.2) | 48.8 (-0.6; -2.6 to +1.2) | 94.3 (-0.3; -1.5 to +0.8) | 96.1 (+0.0; -3.9 to +3.9) | 84.8 (-2.5; -7.2 to +1.6) |
| Qwen/Qwen3-Embedding-4B | 2560 | 39.7 (+1.8; -0.2 to +4.0) | 74.8 (+1.3; -1.0 to +3.7) | 74.8 (+1.3; -1.0 to +3.7) | 50.7 (+1.3; -0.5 to +3.1) | 95.3 (+0.7; -0.5 to +2.0) | 98.0 (+2.0; +0.0 to +5.3) | 87.8 (+0.5; -3.1 to +4.4) |
| Qwen/Qwen3-Embedding-8B | 4096 | 39.8 (+2.0; +0.0 to +4.0) | 75.8 (+2.3; +0.0 to +4.7) | 75.8 (+2.3; +0.0 to +4.7) | 51.1 (+1.7; -0.1 to +3.4) | 95.3 (+0.7; -0.3 to +1.7) | 98.0 (+2.0; +0.0 to +5.3) | 87.5 (+0.2; -3.0 to +3.5) |

## Bokmål only

| Model | Dims | Page R@1 | Page R@10 | Page R@100 | Page MRR | Doc R@10 (gen.) |
| --- | --- | --- | --- | --- | --- | --- |
| text-embedding-3-large | 1536 | 37.7 | 74.7 | 74.7 | 49.8 | 94.8 |
| NbAiLab/borealis-embed-212m | 768 | 38.1 (+0.4; -1.6 to +2.4) | 73.3 (-1.4; -4.0 to +1.0) | 73.3 (-1.4; -3.8 to +1.2) | 49.4 (-0.5; -2.2 to +1.3) | 94.6 (-0.2; -1.4 to +1.0) |
| BAAI/bge-m3 | 1024 | 39.1 (+1.4; -0.8 to +3.6) | 75.2 (+0.6; -2.0 to +3.0) | 75.2 (+0.6; -1.8 to +3.2) | 50.4 (+0.5; -1.3 to +2.4) | 95.6 (+0.8; -0.4 to +2.0) |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 1024 | 39.1 (+1.4; -0.8 to +3.8) | 75.0 (+0.4; -2.2 to +3.0) | 75.0 (+0.4; -2.2 to +3.0) | 50.7 (+0.9; -1.0 to +2.9) | 95.6 (+0.8; -0.2 to +2.0) |
| Qwen/Qwen3-Embedding-0.6B | 1024 | 39.1 (+1.4; -1.0 to +3.8) | 70.7 (-4.0; -7.0 to -1.0) | 70.7 (-4.0; -7.0 to -1.0) | 49.2 (-0.6; -2.8 to +1.6) | 94.0 (-0.8; -2.0 to +0.4) |
| Qwen/Qwen3-Embedding-4B | 2560 | 40.1 (+2.4; +0.0 to +4.8) | 74.9 (+0.2; -2.4 to +2.8) | 74.9 (+0.2; -2.4 to +2.8) | 51.0 (+1.2; -0.9 to +3.2) | 95.0 (+0.2; -1.0 to +1.6) |
| Qwen/Qwen3-Embedding-8B | 4096 | 40.5 (+2.8; +0.8 to +5.0) | 76.6 (+2.0; -0.6 to +4.6) | 76.6 (+2.0; -0.6 to +4.6) | 51.9 (+2.0; +0.2 to +4.0) | 95.4 (+0.6; -0.4 to +1.6) |

## Nynorsk only

| Model | Dims | Page R@1 | Page R@10 | Page R@100 | Page MRR | Doc R@10 (gen.) |
| --- | --- | --- | --- | --- | --- | --- |
| text-embedding-3-large | 1536 | 38.4 | 67.7 | 67.7 | 47.4 | 93.9 |
| NbAiLab/borealis-embed-212m | 768 | 36.4 (-2.0; -6.1 to +2.0) | 65.7 (-2.0; -9.1 to +5.1) | 65.7 (-2.0; -9.1 to +5.1) | 45.4 (-2.0; -6.4 to +2.1) | 94.9 (+1.0; -2.0 to +5.1) |
| BAAI/bge-m3 | 1024 | 35.4 (-3.0; -8.1 to +1.0) | 69.7 (+2.0; -5.1 to +9.1) | 69.7 (+2.0; -5.1 to +9.1) | 45.6 (-1.8; -6.7 to +2.7) | 96.0 (+2.0; -2.0 to +6.1) |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 1024 | 35.4 (-3.0; -8.1 to +1.0) | 67.7 (+0.0; -7.1 to +7.1) | 67.7 (+0.0; -7.1 to +7.1) | 45.1 (-2.3; -7.3 to +2.0) | 96.0 (+2.0; -2.0 to +6.1) |
| Qwen/Qwen3-Embedding-0.6B | 1024 | 35.4 (-3.0; -8.1 to +1.0) | 72.7 (+5.1; +0.0 to +11.1) | 72.7 (+5.1; +0.0 to +11.1) | 46.6 (-0.7; -5.0 to +3.1) | 96.0 (+2.0; +0.0 to +5.1) |
| Qwen/Qwen3-Embedding-4B | 2560 | 37.4 (-1.0; -5.1 to +2.0) | 74.7 (+7.1; +2.0 to +13.1) | 74.7 (+7.1; +2.0 to +13.1) | 49.2 (+1.8; -2.0 to +5.7) | 97.0 (+3.0; +0.0 to +7.1) |
| Qwen/Qwen3-Embedding-8B | 4096 | 36.4 (-2.0; -7.1 to +3.0) | 71.7 (+4.0; -2.0 to +10.1) | 71.7 (+4.0; -2.0 to +10.1) | 47.3 (-0.1; -5.0 to +4.6) | 94.9 (+1.0; -2.0 to +4.1) |

## Time

| Model | Dims | Questions | Errors | p50 per search (ms) | p95 (ms) | Sum of searches (s) |
| --- | --- | --- | --- | --- | --- | --- |
| text-embedding-3-large | 1536 | 676 | 0 | 959 | 1593 | 714.6 |
| NbAiLab/borealis-embed-212m | 768 | 676 | 0 | 967 | 1459 | 674.2 |
| BAAI/bge-m3 | 1024 | 676 | 0 | 1022 | 1534 | 707.6 |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 1024 | 676 | 0 | 1033 | 1436 | 717.0 |
| Qwen/Qwen3-Embedding-0.6B | 1024 | 676 | 0 | 1381 | 1818 | 928.9 |
| Qwen/Qwen3-Embedding-4B | 2560 | 676 | 0 | 857 | 1101 | 582.1 |
| Qwen/Qwen3-Embedding-8B | 4096 | 676 | 0 | 1270 | 1648 | 870.2 |
