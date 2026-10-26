# Kudos pilot: retrieval on Typesense, phrase step off and pgvector

76 of 76 questions with an expected document. Rounds: Typesense, phrase step off 3, pgvector 3; each question's scores are averaged over its rounds. Each run asks its sides back to back, on one machine. Every service plans the search with a model and reranks with ColBERT; Typesense runs locally and holds only the pilot's 299 documents, copied from the shared test cluster.

Typesense's chunk ids are not unique across documents, so it can serve a passage under another document than the one it searched. The first table credits every pilot document that holds a chunk a Typesense side returned (its best case); as served, without that credit, follows.

| Metric (document level) | Typesense, phrase step off | pgvector | Difference | 95% CI |
| --- | --- | --- | --- | --- |
| Recall@10 | 89.7 | 95.8 | +6.1 | -1.5 to 14.3 |
| Recall@5 | 88.8 | 95.6 | +6.8 | -1.1 to 14.9 |
| MRR | 85.2 | 86.5 | +1.3 | -7.2 to 10.0 |
| nDCG@10 | 85.8 | 88.7 | +3.0 | -4.9 to 11.1 |

As served:

| Metric (document level) | Typesense, phrase step off | pgvector | Difference | 95% CI |
| --- | --- | --- | --- | --- |
| Recall@10 | 88.4 | 95.8 | +7.5 | 0.4 to 15.1 |
| Recall@5 | 87.5 | 95.6 | +8.1 | 0.9 to 15.8 |
| MRR | 84.7 | 86.5 | +1.8 | -6.7 to 10.5 |
| nDCG@10 | 85.1 | 88.7 | +3.6 | -4.1 to 11.7 |

Holdout only (17 questions), credited:

| Metric (document level) | Typesense, phrase step off | pgvector | Difference | 95% CI |
| --- | --- | --- | --- | --- |
| Recall@10 | 82.4 | 100.0 | +17.6 | 0.0 to 35.3 |
| Recall@5 | 82.4 | 100.0 | +17.6 | 0.0 to 35.3 |
| MRR | 77.6 | 93.1 | +15.5 | -1.0 to 33.8 |
| nDCG@10 | 77.9 | 94.9 | +17.0 | 1.4 to 34.9 |

Distinct pilot documents per answer: Typesense, phrase step off 3.3, pgvector 3.6.
Typesense, phrase step off: answers with a document outside the pilot 0 of 228; returned chunks held by more than one document 147.
Latency over every call: Typesense, phrase step off p50 3565 ms, p95 7343 ms; pgvector p50 3742 ms, p95 6266 ms.
