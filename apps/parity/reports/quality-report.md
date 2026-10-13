# Answer-quality comparison: headless-rag and genki

**Provisional.** The test set (packages/eval/testsets/ka-kudos-draft.yaml) is a draft that nobody has reviewed yet. Treat the numbers as a first reading, not a gate.

84 questions, 3 repeats per system, generated 2026-10-06T22:25:08.273Z.

## Retrieval (Kunnskapsassistenten retrieve-only tool)

|                                      | headless-rag    | genki           |
| ------------------------------------ | --------------- | --------------- |
| Expected source in top 10            | 45.0%           | 50.9%           |
| Expected source in top 20            | 45.0%           | 50.9%           |
| Chunks returned (mean)               | 3.8             | 10.0            |
| Same chunks across repeats (Jaccard) | 0.434           | 0.425           |
| Latency p50 / p90                    | 14.4 s / 19.1 s | 11.2 s / 16.1 s |
| Errors                               | 0 of 252        | 0 of 252        |

Overlap between the systems' top 10: 0.603 [0.542, 0.664]. Recall difference (platform minus headless-rag): 0.059 [-0.004, 0.123], n=76.

## Answers (Kunnskapsassistenten agent tool)

Judge: claude-opus-5-5, scores 0 to 1 against the reference answer.

|                                         | headless-rag         | genki                |
| --------------------------------------- | -------------------- | -------------------- |
| Judge score (mean, 95% CI)              | 0.601 [0.530, 0.671] | 0.609 [0.536, 0.681] |
| Answer matches expected pattern         | 70.6%                | 72.4%                |
| Cites the expected document             | 73.7%                | 58.3%                |
| Cites any source                        | 100.0%               | 80.3%                |
| Refuses when the answer is not in Kudos | 33.3%                | 29.2%                |
| Refuses when the answer is in Kudos     | 2.6%                 | 6.1%                 |
| Latency p50 / p90                       | 14.4 s / 41.5 s      | 12.2 s / 39.0 s      |
| Errors (calls / judge)                  | 0 / 0 of 252         | 0 / 0 of 252         |

Paired difference in judge score (platform minus headless-rag): 0.008 [-0.061, 0.076], n=84.

| Tag                        | n   | headless-rag | genki |
| -------------------------- | --- | ------------ | ----- |
| arsrapport                 | 32  | 0.542        | 0.605 |
| comparison                 | 6   | 0.325        | 0.183 |
| evaluering                 | 1   | 0.850        | 0.760 |
| factual                    | 70  | 0.596        | 0.610 |
| instruks                   | 4   | 0.690        | 0.471 |
| not-covered                | 8   | 0.846        | 0.919 |
| proposisjon-til-stortinget | 2   | 0.572        | 0.200 |
| statusrapport              | 23  | 0.535        | 0.557 |
| strategi-plan              | 2   | 0.850        | 0.700 |
| tildelingsbrev             | 12  | 0.631        | 0.594 |

## Search profiles on Norwegian questions (M.2)

Raw question, no planner, top 30 per profile, 76 questions with a known source.

| Profile     | Expected source found | Only this profile found it |
| ----------- | --------------------- | -------------------------- |
| phrase      | 3.3%                  | 3                          |
| metadata    | 0.0%                  | 0                          |
| content     | 6.6%                  | 5                          |
| any profile | 10.5%                 |                            |

## Notes

- Neither system reports token usage over MCP, so cost per answer is not compared here.
- headless-rag returns its top chunks after reranking (often 3 to 5); the platform returns up to 10, which limits overlap and favours the platform on recall at 10.
- Both systems plan queries with a language model, so retrieval varies between repeats; stability shows how much.
- Refusal rates use a keyword heuristic and undercount refusals worded in other ways; the judge scores on the not-covered tag are the better signal.
- About one in five platform answers carries no sources in its MCP result, and those answers score low. That is the main gap to investigate before Kunnskapsassistenten switches.
- Search profile recall uses the raw question with no planner and no auto-filters, so it measures the profiles alone, not the full pipeline.
