# Kudos pilot: embedding models by vector search alone

Each question is embedded with the model's query prompt and the nearest 100 passages are found by exact search in that model's own database (20,248 page passages from the same Marker text). No planner, keywords or reranker. Generated questions: one per page, written by gpt-4o, the page is the answer (unreviewed). Draft questions: the 76 ka-kudos-draft questions with an expected document. Differences are against text-embedding-3-large@1536, paired bootstrap, 95% interval.

## All generated questions

| Model | Dims | Page R@1 | Page R@10 | Page R@100 | Page MRR | Doc R@10 (gen.) | Doc R@10 (draft) | Doc MRR (draft) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| text-embedding-3-large | 1536 | 40.8 | 77.7 | 93.5 | 54.2 | 98.2 | 98.7 | 86.9 |
| NbAiLab/borealis-embed-212m | 768 | 36.3 (-4.5; -8.5 to -0.5) | 72.3 (-5.3; -8.8 to -1.7) | 92.2 (-1.3; -3.7 to +1.0) | 48.1 (-6.1; -9.1 to -3.1) | 97.5 (-0.7; -2.0 to +0.7) | 99.3 (+0.7; +0.0 to +2.0) | 88.4 (+1.6; -4.7 to +7.9) |
| BAAI/bge-m3 | 1024 | 46.5 (+5.7; +1.5 to +10.0) | 81.7 (+4.0; +0.7 to +7.3) | 94.7 (+1.2; -1.0 to +3.3) | 58.2 (+4.0; +0.8 to +7.2) | 99.0 (+0.8; -0.2 to +1.8) | 98.7 (+0.0; -3.3 to +2.6) | 92.3 (+5.5; +0.3 to +11.0) |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 1024 | 48.3 (+7.5; +3.0 to +11.7) | 81.0 (+3.3; +0.0 to +6.5) | 94.3 (+0.8; -1.3 to +3.0) | 60.3 (+6.1; +2.8 to +9.3) | 98.8 (+0.7; -0.3 to +1.7) | 100.0 (+1.3; +0.0 to +3.3) | 94.3 (+7.4; +1.4 to +13.7) |
| Qwen/Qwen3-Embedding-0.6B | 1024 | 41.2 (+0.3; -4.2 to +4.7) | 73.7 (-4.0; -7.7 to -0.2) | 92.7 (-0.8; -3.0 to +1.3) | 52.6 (-1.6; -5.0 to +1.7) | 97.5 (-0.7; -1.8 to +0.5) | 99.3 (+0.7; +0.0 to +2.0) | 90.9 (+4.1; -1.5 to +9.8) |
| Qwen/Qwen3-Embedding-4B | 2560 | 48.7 (+7.8; +3.5 to +12.2) | 82.8 (+5.2; +1.8 to +8.5) | 97.3 (+3.8; +2.0 to +5.7) | 60.7 (+6.5; +3.2 to +9.8) | 98.2 (+0.0; -1.0 to +1.0) | 100.0 (+1.3; +0.0 to +3.3) | 94.1 (+7.2; +2.0 to +12.8) |
| Qwen/Qwen3-Embedding-8B | 4096 | 50.0 (+9.2; +4.8 to +13.3) | 85.0 (+7.3; +4.0 to +10.7) | 97.5 (+4.0; +2.2 to +5.8) | 61.6 (+7.4; +4.2 to +10.5) | 99.0 (+0.8; -0.2 to +1.8) | 99.3 (+0.7; +0.0 to +2.0) | 93.5 (+6.7; +1.3 to +12.5) |

## Bokmål only

| Model | Dims | Page R@1 | Page R@10 | Page R@100 | Page MRR | Doc R@10 (gen.) |
| --- | --- | --- | --- | --- | --- | --- |
| text-embedding-3-large | 1536 | 39.9 | 78.2 | 93.6 | 54.0 | 98.2 |
| NbAiLab/borealis-embed-212m | 768 | 36.5 (-3.4; -7.8 to +1.0) | 73.7 (-4.6; -8.4 to -1.0) | 92.6 (-1.0; -3.4 to +1.4) | 48.3 (-5.7; -9.0 to -2.3) | 97.6 (-0.6; -2.0 to +0.8) |
| BAAI/bge-m3 | 1024 | 46.3 (+6.4; +1.8 to +11.0) | 82.0 (+3.8; +0.0 to +7.4) | 94.4 (+0.8; -1.6 to +3.2) | 58.0 (+4.0; +0.5 to +7.5) | 99.4 (+1.2; +0.2 to +2.4) |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 1024 | 47.9 (+8.0; +3.4 to +12.6) | 81.6 (+3.4; -0.2 to +7.0) | 94.6 (+1.0; -1.4 to +3.4) | 60.2 (+6.2; +2.8 to +9.6) | 99.2 (+1.0; -0.2 to +2.2) |
| Qwen/Qwen3-Embedding-0.6B | 1024 | 40.1 (+0.2; -4.6 to +5.0) | 73.5 (-4.8; -9.0 to -0.8) | 92.4 (-1.2; -3.6 to +1.2) | 52.0 (-2.0; -5.5 to +1.7) | 97.6 (-0.6; -1.8 to +0.6) |
| Qwen/Qwen3-Embedding-4B | 2560 | 47.5 (+7.6; +3.2 to +12.2) | 83.0 (+4.8; +1.2 to +8.4) | 97.2 (+3.6; +1.6 to +5.6) | 60.0 (+6.0; +2.6 to +9.5) | 98.4 (+0.2; -0.8 to +1.2) |
| Qwen/Qwen3-Embedding-8B | 4096 | 49.3 (+9.4; +4.8 to +14.0) | 85.6 (+7.4; +4.0 to +11.0) | 97.4 (+3.8; +2.0 to +5.8) | 61.1 (+7.1; +3.7 to +10.6) | 99.2 (+1.0; +0.0 to +2.2) |

## Nynorsk only

| Model | Dims | Page R@1 | Page R@10 | Page R@100 | Page MRR | Doc R@10 (gen.) |
| --- | --- | --- | --- | --- | --- | --- |
| text-embedding-3-large | 1536 | 45.5 | 74.7 | 92.9 | 55.3 | 98.0 |
| NbAiLab/borealis-embed-212m | 768 | 35.4 (-10.1; -20.2 to +0.0) | 65.7 (-9.1; -19.2 to +1.0) | 89.9 (-3.0; -9.1 to +3.0) | 46.9 (-8.4; -16.0 to -0.8) | 97.0 (-1.0; -4.0 to +2.0) |
| BAAI/bge-m3 | 1024 | 47.5 (+2.0; -9.1 to +13.1) | 79.8 (+5.1; -2.0 to +12.1) | 96.0 (+3.0; -2.0 to +8.1) | 59.3 (+4.0; -4.2 to +12.2) | 97.0 (-1.0; -3.0 to +0.0) |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 1024 | 50.5 (+5.1; -7.1 to +17.2) | 77.8 (+3.0; -6.1 to +12.1) | 92.9 (+0.0; -6.1 to +6.1) | 61.0 (+5.7; -3.7 to +15.0) | 97.0 (-1.0; -3.0 to +0.0) |
| Qwen/Qwen3-Embedding-0.6B | 1024 | 46.5 (+1.0; -11.1 to +13.1) | 74.7 (+0.0; -10.1 to +10.1) | 93.9 (+1.0; -5.1 to +7.1) | 55.3 (+0.0; -9.0 to +9.4) | 97.0 (-1.0; -5.1 to +2.0) |
| Qwen/Qwen3-Embedding-4B | 2560 | 54.5 (+9.1; -3.0 to +20.2) | 81.8 (+7.1; -2.0 to +16.2) | 98.0 (+5.1; +0.0 to +10.1) | 64.2 (+8.9; -0.6 to +18.3) | 97.0 (-1.0; -5.1 to +2.0) |
| Qwen/Qwen3-Embedding-8B | 4096 | 53.5 (+8.1; -2.0 to +19.2) | 81.8 (+7.1; -1.0 to +15.2) | 98.0 (+5.1; +0.0 to +10.1) | 64.0 (+8.7; +0.2 to +17.1) | 98.0 (+0.0; -3.0 to +3.0) |

## Time

| Model | Dims | Passages | Question embedding (s, all questions) | Exact search p50 (ms) |
| --- | --- | --- | --- | --- |
| text-embedding-3-large | 1536 | 20248 | 9.4 | 51.8 |
| NbAiLab/borealis-embed-212m | 768 | 20248 | 3.2 | 30.1 |
| BAAI/bge-m3 | 1024 | 20248 | 10.8 | 39.2 |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 1024 | 20248 | 10.8 | 36.4 |
| Qwen/Qwen3-Embedding-0.6B | 1024 | 20248 | 16.8 | 37.2 |
| Qwen/Qwen3-Embedding-4B | 2560 | 20248 | 89.5 | 94.0 |
| Qwen/Qwen3-Embedding-8B | 4096 | 20248 | 153.9 | 118.2 |
