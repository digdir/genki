# Benchmarks

A benchmark compares the component genki uses now with a candidate for replacing it (a document converter, an embedding model, a search engine, an index, a reranker) against a **reference**: the known-right answers every side is measured against. It answers one question, such as "can Marker 1.11 replace 1.10.2 for Kudos?", in a way that can be rerun, checked and trusted. [ADR 0003](../docs/adr/0003-evaluation-is-part-of-the-platform.md) says when one is needed.

| Folder                                             | Question                                                                                              | Shape                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [`ingestion/opb`](ingestion/opb)                   | Marker or KUDOS text, graded on page tests                                                            | This one                           |
| [`ingestion`](ingestion)                           | Where KUDOS text and the indexed Marker text disagree; no reference. Also the data the page tests use | This one, without a reference      |
| [`kudos-pilot/engines`](kudos-pilot/engines)       | Typesense or pgvector for Kudos                                                                       | This one                           |
| [`kudos-pilot/embeddings`](kudos-pilot/embeddings) | Which embedding model for Kudos, at no more than 1,536 dimensions                                     | This one                           |
| [`kudos-pilot/indexes`](kudos-pilot/indexes)       | Which pgvector index, and how it scales                                                               | Measurements, no per-item verdicts |
| [`kudos-pilot`](kudos-pilot)                       | The three benchmarks' shared steps: sample, Marker, re-ingest, model servers                          | Not a benchmark                    |
| [`benchlib`](benchlib)                             | Shared code for all of them                                                                           |                                    |

## Rules

- **Same items for every side.** A difference is always paired: both sides graded on exactly the same items.
- **The reference never comes from a side.** Tests written from page images, questions with known pages, exact search for an index: never a side's own output, which would grade that side against itself. A reference used to tune a side is no longer a reference for that side.
- **The decision rule comes first.** The README states the primary metric and the margin (how much worse a candidate may be and still replace the current side) before a candidate runs.
- **Resample what clusters.** Items from one document move together, so intervals resample whole documents, within the strata the sample was drawn in.
- **Quality ranks; time and cost are notes.** Sides are ranked in tiers by the primary metric. Time and cost go in a notes section at the end and never change the ranking. Slices are exploratory.
- **Every number can be recomputed.** The per-item verdicts and a run record for each side are committed in `results/`, and `report.py` rebuilds the report from `results/` and `reference/` alone, byte for byte.
- **The instrument is checked.** Every report shows an A/A run (no real difference: the interval should leave out zero about 5% of the time) and a known loss that the benchmark must notice.
- **Every change to the reference is logged,** with the item before and after.

## A benchmark folder

```
benchmarks/<name>/
  README.md          the question and the decision it informs, results, sides, reference, decision rule,
                     method, commands, settings, files, limits
  requirements.txt   pinned with ==, or "standard library only" in the README
  common.py          paths (a <NAME>_DATA variable, .data/ by default); puts benchmarks/ on sys.path
  *.py               the steps: draw the items, build the reference, score each side, report
  reference/         committed: the reference, how it was made, its check log
  results/           committed, written by the scripts only:
    sides/<side>/verdicts.jsonl, record.json
    report.md, report.json, differences.csv
  .data/             git-ignored: downloads, caches, intermediate files
```

**README:** the Results section gives the tiers in plain words, the date, and a link to `results/report.md`. It never repeats the report's tables, which would go stale.

**Report, in this order:**

1. The answer in two sentences.
2. Tiers, quality only.
3. Paired differences with each verdict against the margin and the smallest detectable difference.
4. Where each side loses, with examples.
5. How the reference was made and checked.
6. Instrument checks.
7. Limits.
8. Words used here (start from `benchlib.tables.GLOSSARY`).
9. Notes: time and cost.
10. Run record.

## benchlib

Standard library only, Python 3.9 or later. A benchmark's `common.py` puts `benchmarks/` on `sys.path`, then `from benchlib import stats, record, tables, instrument`.

| Module       | Gives                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stats`      | `compare` (paired bootstrap over clusters, optional strata; seeded per label, so adding a side or slice moves no other interval), `decide`, `tiers`, `holm`, `latency`, `pair_items` |
| `record`     | `make` and `write` the run record (commit, uncommitted changes, code, reference and items hashes, settings, versions), `require_comparable`, `tree_hash`                             |
| `tables`     | Markdown tables, signed numbers, `diff_cell`, `glossary`, `notes`, and JSON, JSONL and CSV writers; all refuse em-dashes                                                             |
| `instrument` | `null_runs` (the A/A check) and `damage` (a known loss)                                                                                                                              |

Verdicts from `decide(difference, max_regression)`:

| Verdict      | When                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| better       | the whole interval is above zero                                          |
| not worse    | the whole interval is above minus the margin                              |
| worse        | the whole interval is below minus the margin                              |
| inconclusive | none of these: more items are needed, or an explicit, recorded acceptance |
| unreliable   | over 5% of resamples left the metric undefined                            |

"Not worse" has to be shown by the whole interval. That is stricter than a service's `no-regression` gate in `packages/eval`, which fails only when the whole interval is below the margin.

Run its tests with every Python a benchmark uses:

```sh
cd benchmarks && <venv>/bin/python -m unittest discover -s benchlib -t .
```

## Before committing

- `report.py` run after the last `score.py`, so `results/` matches the code and the reference.
- The benchmark's own tests and benchlib's pass.
- `npx prettier --write benchmarks/<name>` and `npm run format:check`. Prettier skips the data files (`benchmarks/**/*.json`, `results/`; see `.prettierignore`), which the scripts write and must rebuild byte for byte.
