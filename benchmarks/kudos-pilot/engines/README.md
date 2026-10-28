# Search engines: Typesense vs pgvector for Kudos

Should Kudos search move from Typesense to pgvector? This benchmark asks the 76 draft questions of Kunnskapsassistenten's test set, three rounds each, through the same retrieve-only service on both engines holding the same 299 documents, and grades the documents each returns. The choice it informs: the plan to retire Typesense for Kudos ([issue 92](https://github.com/digdir/genki/issues/92)).

## Results

Graded 23 October 2026, reported 26 October 2026; scores and differences are in [results/report.md](results/report.md), and what each run used is in `results/sides/<side>/record.json`.

By Recall@10 as served, pgvector and Typesense with the phrase step off share the first tier, and Typesense as it runs today is second. pgvector is better than Typesense at the 2-point margin. Turning off the planner's phrase step brings Typesense closer, and the sample can't tell it from pgvector.

## Sides

| Side                       | Search                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typesense (current)        | `kudos-pilot-typesense-retrieve-only` on a local Typesense 30.1 holding only the pilot's documents, chunks and phrases; the planner looks up stored phrases first     |
| pgvector (candidate)       | `kudos-pilot-retrieve-only` on `digdir/kudos-next`: Marker text, one passage per page, text-embedding-3-large at 1,536 dimensions, keyword and vector search with RRF |
| Typesense, phrase step off | The Typesense side with `planner.expansionMode: blind`: the planner writes its searches in one model call, as on pgvector                                             |

All three rerank with ColBERT and return ten passages.

## Reference

`reference/questions.jsonl`: the 76 questions of `packages/eval/testsets/ka-kudos-draft.yaml` that name the documents that answer them, by old Typesense id, with the KUDOS document (`../sample.json`) as the cluster that intervals resample. No side wrote them; they were written from Typesense passages, which may favour Typesense, and no person has reviewed them.

## Decision rule

pgvector replaces Typesense when its verdict on document Recall@10 as served is "not worse" or "better" at a margin of 2 points. Set on 26 October 2026, after the runs, when the benchmark moved to this layout; `MARGIN` in `report.py`.

## Method

- **Same documents, same path.** The local Typesense holds only the pilot's documents, copied read-only from the shared test cluster with its schema (`../copy_typesense.py`); both engines answer through Kunnskapsassistenten's retrieve-only service (`rag-single-shot`, no answer).
- **Rounds.** Each question goes to every side back to back, three times; a question's scores are averaged over its rounds, since the planner does not always plan the same search.
- **As served and credited.** Typesense's chunk ids are not unique across documents, so it can return a passage under another document than the one it found. As served counts the document returned; credited also counts every pilot document that holds the chunk.
- **Intervals** resample whole documents 10,000 times with `benchlib.stats.compare`; an interval within 1 point of zero or the margin is rerun with two more seeds. Tiers use Holm correction. Every report has an A/A run and a known loss.

## Commands

```sh
cd benchmarks/kudos-pilot/engines
../.data/embed-venv/bin/python build_reference.py   # reference/questions.jsonl
cd ../../..
npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts run 3                  # Typesense and pgvector
npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts run 3 typesense-blind  # the phrase step off
cd benchmarks/kudos-pilot/engines   # copy the run files into results/runs/, then:
../.data/embed-venv/bin/python publish.py           # verdicts and run records, from results/runs/
../.data/embed-venv/bin/python report.py            # results/report.md, report.json and differences.csv, from results/ and reference/ alone
../.data/embed-venv/bin/python -m unittest test_report
```

`run` needs the pilot's API, databases and local Typesense (`../README.md`); `publish.py` needs Node for `kudos-pilot-compare.ts verdicts`; `report.py` needs neither.

## Files

| File                                                  | Holds                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `reference/questions.jsonl`                           | The 76 questions, their documents and clusters                               |
| `results/runs/*.json`                                 | Each round's answers per side: sources in rank order, chunk holders, latency |
| `results/sides/<side>/verdicts.jsonl`                 | One line per question: document scores as served and credited, latencies     |
| `results/sides/<side>/record.json`                    | What the run used: commit, code, reference and items hashes, the service     |
| `results/report.md`, `report.json`, `differences.csv` | The report, its data, and every difference as a row                          |

## Limits

- 76 questions on 61 documents: only large differences show, and both engines are near the ceiling.
- The questions were written from Typesense passages; no person has reviewed them.
- 299 documents; all of Kudos is about 40,000.
