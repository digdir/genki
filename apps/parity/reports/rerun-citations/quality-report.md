# Answer-quality comparison: headless-rag and genki

**Provisional.** The test set (packages/eval/testsets/ka-kudos-draft.yaml) is a draft that nobody has reviewed yet. Treat the numbers as a first reading, not a gate.

84 questions, 3 repeats per system, generated 2026-10-08T22:21:47.153Z.

## Answers (Kunnskapsassistenten agent tool)

Judge: claude-opus-5-5, scores 0 to 1 against the reference answer.

|                                         | headless-rag         | genki                |
| --------------------------------------- | -------------------- | -------------------- |
| Judge score (mean, 95% CI)              | 0.601 [0.530, 0.671] | 0.569 [0.498, 0.639] |
| Answer matches expected pattern         | 70.6%                | 67.1%                |
| Cites the expected document             | 73.7%                | 75.4%                |
| Cites any source                        | 100.0%               | 100.0%               |
| Refuses when the answer is not in Kudos | 33.3%                | 33.3%                |
| Refuses when the answer is in Kudos     | 2.6%                 | 9.6%                 |
| Latency p50 / p90                       | 14.4 s / 41.5 s      | 13.0 s / 35.7 s      |
| Errors (calls / judge)                  | 0 / 0 of 252         | 0 / 0 of 252         |

Paired difference in judge score (platform minus headless-rag): -0.032 [-0.090, 0.026], n=84.

| Tag                        | n   | headless-rag | genki |
| -------------------------- | --- | ------------ | ----- |
| arsrapport                 | 32  | 0.542        | 0.528 |
| comparison                 | 6   | 0.325        | 0.282 |
| evaluering                 | 1   | 0.850        | 0.260 |
| factual                    | 70  | 0.596        | 0.559 |
| instruks                   | 4   | 0.690        | 0.721 |
| not-covered                | 8   | 0.846        | 0.873 |
| proposisjon-til-stortinget | 2   | 0.572        | 0.092 |
| statusrapport              | 23  | 0.535        | 0.506 |
| strategi-plan              | 2   | 0.850        | 0.808 |
| tildelingsbrev             | 12  | 0.631        | 0.610 |

## Notes

- Neither system reports token usage over MCP, so cost per answer is not compared here.
- headless-rag returns its top chunks after reranking (often 3 to 5); the platform returns up to 10, which limits overlap and favours the platform on recall at 10.
- Both systems plan queries with a language model, so retrieval varies between repeats; stability shows how much.
- Refusal rates use a keyword heuristic and undercount refusals worded in other ways; the judge scores on the not-covered tag are the better signal.
- Search profile recall uses the raw question with no planner and no auto-filters, so it measures the profiles alone, not the full pipeline.
