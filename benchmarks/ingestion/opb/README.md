# Page tests: Marker vs KUDOS text

Which text should genki chunk for Kudos: the text KUDOS serves (`/documents/{uuid}/contents`), or Marker's markdown made from the PDF? This benchmark grades both against a reference of yes/no facts about 221 pages of the ingestion sample, written from the page images. The choice it informed: Marker for every document (22 October 2026).

## Results

Graded 26 October 2026; scores and differences are in [results/report.md](results/report.md), and what each run used (commit, reference hash, Marker version, scorer) is in `results/sides/<side>/record.json`.

Ranked by the headline (the mean of text and table scores): Marker first, KUDOS with page breaks ignored second, KUDOS as served third, each tier significantly apart. On text tests of digital pages, Marker is not worse than KUDOS at the 2-point margin. Marker is ahead on scans without a text layer, reading order, headings and tables, and behind on captions and photo credits. Across all pages of the sample, Marker keeps almost no text on about 1% of pages, mostly where its layout step reads the whole page as one picture.

## Sides

| Side                       | Text                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Marker (candidate)         | Marker 1.10.2's markdown from the Kudos pilot's stored conversions, split into pages as genki's page chunker splits it, then converted to HTML |
| KUDOS as served (current)  | KUDOS's text split on its page breaks; no text where a document has fewer pieces than pages                                                    |
| KUDOS, page breaks ignored | The same, but a document whose pieces don't match its pages gives its whole text on every page                                                 |

## Reference

1,933 tests on 221 pages (`reference/tests/`), drawn by `select_pages.py` (`reference/pages.json`: 150 random pages, one per document, 47 extra scanned pages, 30 extra pages with tables). The tests use the test types and scorer of [omni_parse_bench](https://github.com/datalab-to/omni_parse_bench): `present` (a passage or figure is there), `order` (A is read before B), `table_cell` (a cell sits under its column heading or beside its row label).

- **Written from page images only** (`reference/writing-tests.md`), never from a text extraction, so no side's text is the reference.
- **Checked blind:** every test the sides disagree on or both fail was checked against the page by a second reader who wasn't told how any side did (`reference/verifying-tests.md`; verdicts and every change in `reference/review-log.jsonl`).
- **The check was tested:** a fresh reader caught 7 of 7 tests broken on purpose and kept 7 of 7 real ones (`reference/canary/`).

## Decision rule

A candidate replaces the current side when its verdict is "not worse" or "better" at a margin of 2 points of pass rate, on text tests and on table tests. "Not worse" needs the whole 95% interval of the paired difference above −2 points. Set before any candidate runs; `MARGIN` in `report.py`.

## Method

- **Paired.** Every side is graded on the same tests; differences are candidate minus current.
- **Intervals** come from resampling whole documents 10,000 times with `benchlib.stats.compare` (seeded; the same numbers on Python 3.9 and 3.13). An interval that ends within 1 point of zero or of the margin is recomputed with two more seeds, and a verdict that changes is marked borderline.
- **Tiers** on the headline: a side starts a new tier only when it is significantly worse than its tier's top side after Holm correction.
- **Instrument checks** in every report: an A/A run (sides swapped at random within documents, 1,000 times; the interval should leave out zero about 5% of the time) and a known loss (Marker failed on 5% and 10% of pages).
- **Intervals recomputed on 26 October 2026** with 10,000 draws and linear percentiles; point estimates are unchanged from the first run, and the headline per slice now counts a resample without table tests as undefined instead of scoring text alone.

## Commands

```sh
cd benchmarks/ingestion/opb
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt   # Python 3.11 or later

.venv/bin/python select_pages.py   # draw the pages into reference/pages.json (seeded)
.venv/bin/python render.py         # page images for the test writers
.venv/bin/python validate.py       # the scorer's checks on every test file, plus ours
.venv/bin/python score.py          # grade every side; publish verdicts, run records and coverage to results/
.venv/bin/python verify_queue.py   # the tests the blind check reads (reference/verifying-tests.md)
.venv/bin/python apply_review.py   # apply its verdicts to reference/tests/, logged in reference/review-log.jsonl
.venv/bin/python report.py         # results/report.md, report.json and differences.csv, from results/ and reference/ alone
.venv/bin/python -m unittest test_report
```

`score.py` needs the ingestion benchmark's downloads (`fetch.py`: PDFs and KUDOS text), its committed page kinds (`../results/pages.csv`) and the Kudos pilot's Marker cache. `report.py` needs none of them.

To add a candidate, give it a side in `predict.py` and `common_opb.SIDES`, run `score.py` and `report.py`, and read its verdict against the current side.

## Settings

| Variable                   | Used by      | Notes                                                                            |
| -------------------------- | ------------ | -------------------------------------------------------------------------------- |
| `MARKER_CACHE_DIR`         | `score.py`   | The pilot's Marker cache; `benchmarks/kudos-pilot/.data/marker-cache` by default |
| `INGESTION_BENCHMARK_DATA` | every script | The ingestion benchmark's data; `../.data` by default                            |

## Files

| File                                                  | Holds                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `reference/pages.json`                                | The 221 pages with tests and 6 without, why each was drawn and its kind                    |
| `reference/tests/<page_id>.json`                      | The reference, one file per page                                                           |
| `reference/review-log.jsonl`                          | Every verdict of the blind check, with the test before and after                           |
| `reference/canary/`                                   | The test of the blind check: the batch, which tests were broken, the reader's verdicts     |
| `results/sides/<side>/verdicts.jsonl`                 | One line per test: pass or fail, and why                                                   |
| `results/sides/<side>/record.json`                    | What the run used: commit, code, reference and items hashes, side settings, scorer         |
| `results/coverage.json`                               | Whole-sample counts, no reference: pages where Marker keeps no text, scans each side reads |
| `results/report.md`, `report.json`, `differences.csv` | The report, its data, and every difference as a row                                        |
| `.data/opb/` (in `benchmarks/ingestion`)              | Page images, the scoring tool's dataset, each side's text per page and its grading         |

## Limits

- A text test that allows a slip or two also passes a single wrong digit inside it; wrong digits are caught by the number tests, which allow none.
- Running headers, footers and page numbers aren't tested.
- The tests come from one reading model, checked by a second; no person checked every test.
- Slices other than the headline are exploratory.
