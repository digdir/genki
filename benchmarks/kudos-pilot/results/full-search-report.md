# Kudos pilot: the full genki search per embedding model

Kunnskapsassistenten's retrieve-only service (planner, keywords + vectors with RRF, ColBERT) on each model's own database, 3 rounds of the 76 ka-kudos-draft questions, scored per document. Differences are against the same service on text-embedding-3-large@1536, paired bootstrap, 95% interval.

| Model | Recall@10 | MRR | nDCG@10 | p50 per search | p95 |
| --- | --- | --- | --- | --- | --- |
| text-embedding-3-large | 96.1 | 87.0 | 89.1 | 4.4 s | 7.2 s |
| NbAiLab/borealis-embed-212m | 96.1 (-0.0; -1.1 to 0.9) | 83.9 (-3.1; -6.5 to 0.2) | 86.7 (-2.4; -5.0 to -0.0) | 3.6 s | 5.7 s |
| BAAI/bge-m3 | 97.4 (+1.3; 0.0 to 3.1) | 86.0 (-1.0; -4.5 to 2.3) | 88.5 (-0.7; -3.4 to 2.0) | 3.7 s | 6.3 s |
| Snowflake/snowflake-arctic-embed-l-v2.0 | 95.8 (-0.2; -0.7 to 0.0) | 84.5 (-2.5; -6.1 to 0.8) | 86.9 (-2.2; -4.8 to 0.1) | 3.7 s | 6.0 s |
| Qwen/Qwen3-Embedding-0.6B | 95.6 (-0.4; -4.4 to 3.5) | 85.5 (-1.5; -5.3 to 1.7) | 87.9 (-1.2; -4.8 to 1.8) | 3.8 s | 6.3 s |
| Qwen/Qwen3-Embedding-4B | 97.8 (+1.8; 0.0 to 4.8) | 85.1 (-2.0; -5.3 to 1.2) | 87.9 (-1.2; -3.9 to 1.4) | 5.2 s | 6.3 s |
| Qwen/Qwen3-Embedding-8B | 96.5 (+0.4; 0.0 to 1.3) | 86.1 (-1.0; -4.1 to 2.0) | 88.3 (-0.8; -3.1 to 1.3) | 7.3 s | 8.9 s |
