# Kudos pilot: retrieval on Typesense and pgvector

76 of 76 questions with an expected document. Rounds: Typesense 3, pgvector 3; each question's scores are averaged over its rounds. Each run asks its sides back to back, on one machine. Every service plans the search with a model and reranks with ColBERT; Typesense runs locally and holds only the pilot's 299 documents, copied from the shared test cluster.

Typesense's chunk ids are not unique across documents, so it can serve a passage under another document than the one it searched. The first table credits every pilot document that holds a chunk a Typesense side returned (its best case); as served, without that credit, follows.

| Metric (document level) | Typesense | pgvector | Difference | 95% CI |
| --- | --- | --- | --- | --- |
| Recall@10 | 85.5 | 95.8 | +10.3 | 2.9 to 18.2 |
| Recall@5 | 84.6 | 95.6 | +11.0 | 3.3 to 19.1 |
| MRR | 81.3 | 86.5 | +5.2 | -2.6 to 13.6 |
| nDCG@10 | 82.0 | 88.7 | +6.7 | -0.6 to 14.6 |

As served:

| Metric (document level) | Typesense | pgvector | Difference | 95% CI |
| --- | --- | --- | --- | --- |
| Recall@10 | 84.6 | 95.8 | +11.2 | 4.2 to 18.9 |
| Recall@5 | 83.8 | 95.6 | +11.8 | 4.6 to 19.7 |
| MRR | 80.9 | 86.5 | +5.6 | -2.4 to 14.0 |
| nDCG@10 | 81.6 | 88.7 | +7.1 | -0.2 to 14.9 |

Holdout only (17 questions), credited:

| Metric (document level) | Typesense | pgvector | Difference | 95% CI |
| --- | --- | --- | --- | --- |
| Recall@10 | 80.4 | 100.0 | +19.6 | 5.9 to 37.3 |
| Recall@5 | 80.4 | 100.0 | +19.6 | 5.9 to 37.3 |
| MRR | 77.5 | 93.1 | +15.7 | 1.0 to 32.4 |
| nDCG@10 | 78.2 | 94.9 | +16.7 | 2.5 to 32.8 |

Distinct pilot documents per answer: Typesense 3.0, pgvector 3.6.
Typesense: answers with a document outside the pilot 0 of 228; returned chunks held by more than one document 154.
Latency over every call: Typesense p50 6545 ms, p95 10341 ms; pgvector p50 3742 ms, p95 6266 ms.
