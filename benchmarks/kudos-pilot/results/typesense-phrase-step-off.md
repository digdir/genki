# Kudos pilot: retrieval on Typesense and Typesense, phrase step off

76 of 76 questions with an expected document. Rounds: Typesense 3, Typesense, phrase step off 3; each question's scores are averaged over its rounds. Each run asks its sides back to back, on one machine. Every service plans the search with a model and reranks with ColBERT; Typesense runs locally and holds only the pilot's 299 documents, copied from the shared test cluster.

Typesense's chunk ids are not unique across documents, so it can serve a passage under another document than the one it searched. The first table credits every pilot document that holds a chunk a Typesense side returned (its best case); as served, without that credit, follows.

| Metric (document level) | Typesense | Typesense, phrase step off | Difference | 95% CI |
| --- | --- | --- | --- | --- |
| Recall@10 | 85.5 | 89.7 | +4.2 | 0.0 to 8.8 |
| Recall@5 | 84.6 | 88.8 | +4.2 | -0.2 to 8.8 |
| MRR | 81.3 | 85.2 | +4.0 | -0.7 to 8.8 |
| nDCG@10 | 82.0 | 85.8 | +3.8 | -0.7 to 8.5 |

As served:

| Metric (document level) | Typesense | Typesense, phrase step off | Difference | 95% CI |
| --- | --- | --- | --- | --- |
| Recall@10 | 84.6 | 88.4 | +3.7 | -0.2 to 8.3 |
| Recall@5 | 83.8 | 87.5 | +3.7 | -0.4 to 8.3 |
| MRR | 80.9 | 84.7 | +3.8 | -0.9 to 8.6 |
| nDCG@10 | 81.6 | 85.1 | +3.5 | -0.9 to 8.2 |

Holdout only (17 questions), credited:

| Metric (document level) | Typesense | Typesense, phrase step off | Difference | 95% CI |
| --- | --- | --- | --- | --- |
| Recall@10 | 80.4 | 82.4 | +2.0 | -9.8 to 13.7 |
| Recall@5 | 80.4 | 82.4 | +2.0 | -9.8 to 13.7 |
| MRR | 77.5 | 77.6 | +0.2 | -11.8 to 11.9 |
| nDCG@10 | 78.2 | 77.9 | -0.3 | -12.1 to 11.7 |

Distinct pilot documents per answer: Typesense 3.0, Typesense, phrase step off 3.3.
Typesense: answers with a document outside the pilot 0 of 228; returned chunks held by more than one document 154.
Typesense, phrase step off: answers with a document outside the pilot 0 of 228; returned chunks held by more than one document 147.
Latency over every call: Typesense p50 6545 ms, p95 10341 ms; Typesense, phrase step off p50 3565 ms, p95 7343 ms.
