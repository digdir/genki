# Page tests for the era test set

A reference of yes/no tests about 77 pages of the 24 documents in `../results/eras-test-set.json` (per era: 2
scanned, 1 table-heavy, 1 two-column and 2 easy documents). It is a set of its own, apart from the opb page tests
(`../../opb/reference/`, 1,933 tests on Kudos sample pages); a parser run is graded on one set or the other, never
on both mixed.

The same method, test types, file format and scorer as opb:

- **Pages** (`pages.json`, seeded): per document one random page that isn't blank, one more scanned page where
  the document has one, one more table page where it has one (`../eras_tests.py select`), then up to 3 more
  table pages per document (`select-tables`, see below). Page kinds and table counts come from
  `../.data/eras/pages.jsonl`.
- **Written from page images only**, by `../../opb/reference/writing-tests.md`, one file per page in `tests/`.
- **Checked blind**, every test, by a second reader following `../../opb/reference/verifying-tests.md`; every
  verdict and change is in `review-log.jsonl`. (opb checked only the tests its sides disagreed on or both failed;
  no side has been graded here yet, so every test was read.)
- **Graded** with omni-parse-bench's scorer: `../eras_tests.py dataset` builds the dataset in
  `../.data/eras/dataset/`, and `opb grade <run> --dataset ../.data/eras/dataset --unsupported` grades a side.

The documents aren't in our index, so they have no doc_num. A page id is `eras-<8-character id>-p<page>`, the
8 characters being the start of the document's uuid (`id` in the test set and in `pages.json`).

## What it holds (11 Nov 2026)

881 tests on 76 pages from 24 documents: 504 present, 177 order and 200 table_cell tests. Text tests are the
681 present and order tests; table tests are the 200 table_cell tests. One drawn page, `eras-8a1cc78e-p6`,
has no tests: it was classed image-only but shows only scan speckle.

| Slice | Pages with tests | Documents | Text tests | Table tests (pages, documents) |
| --- | --- | --- | --- | --- |
| Digital | 54 | 19 | 485 | 124 (24, 8) |
| Scan + text layer | 11 | 4 | 103 | 35 (7, 2) |
| Image-only | 12 | 5 | 93 | 41 (4, 1) |
| Before 2000 | 17 | 6 | 148 | 35 (7, 2) |
| 2000-2009 | 23 | 6 | 221 | 43 (8, 3) |
| 2010-2019 | 16 | 6 | 138 | 33 (8, 3) |
| 2020 on | 20 | 6 | 174 | 89 (12, 3) |

`eras_tests.py counts` prints this table again.

**The pages were drawn in two rounds.**

- The first round drew 44 pages, as opb did: 24 random pages, 9 scanned pages and 11 table pages.
- The second round added 33 table pages and left the first 44 as they were (`eras_tests.py select-tables`).
  It took up to 3 more pages per document that has tables, so no document has more than 4 table pages.
  - 24 are digital pages where the PDF finds a table (reason `table-more`).
  - 9 are scanned pages (reason `scan-table`). The PDF's table count can't see a table that is only in the
    page image. So `eras_tests.py sheets` laid out every scanned page on contact sheets, and a reader marked
    which pages hold a table, looking at the images only. Those marks are in `scan-tables.json`: 51 of 183
    pages, all in 3 documents.
- The writers wrote 4 to 5 table tests on each table, the top of opb's 2 to 5.

**Table tests are still thin across documents.** Only 11 of the 24 documents have table tests; the other 13 showed no table where we looked.
Intervals resample whole documents, so 200 table tests from 11 documents are narrower than before but still
wide. On scans the tables come from 3 documents: two with a text layer (1980 and 1996) and one image-only
(2021). Table scores on scans therefore describe those three documents, not scans in general.

**The PDF's table count is a weak guide on digital pages.** 14 of the 35 pages it picked (both rounds) ended
up with no table tests:

- 3 covers;
- a contents page;
- 2 signature blocks;
- form-like boxes and fact boxes;
- spreads with charts.

The writers gave these pages the usual text tests. All 9 scanned pages picked from the image screen hold a
table.

**Score text on the first round's pages, tables on all pages.** The added table pages got the usual text
tests too: 303 of the 681 text tests, all from the 11 documents with tables. A pooled text score weighs each
test equally, so on all pages it would lean on how a parser reads those few documents. So:

- **Text** (present and order): the first round's 43 pages with tests, reasons `random`, `scan` and `table`.
  That is 378 tests from all 24 documents, drawn as opb drew its pages.
- **Tables** (table_cell): all pages, 200 tests.
- Text on the added pages (reasons `table-more` and `scan-table`) can be shown as its own slice. It is text
  around tables.

`pages.json` gives each page's reason, so the split needs no new data.

**The blind check read every test.**

- First round: 426 tests, 419 ok, 7 fixed, none dropped.
  - 4 fixes are order tests whose passage was printed twice. Case is ignored, so a heading word also
    matched the body text.
  - 1 copies a misspelling exactly as printed.
  - 2 are table tests that gave one line of a two-line cell. The scorer compares a neighbour role with the
    whole cell, so a correct parse would have failed them.
- Second round: 461 tests, 454 ok, 3 fixed, 4 dropped.
  - The 4 drops are table tests on a treaty's signature block (party, name, "(sign.)"). It has no headings,
    so it is not a table under the rules.
  - On a second look, the 2 table tests on the same treaty's other signature block, kept in the first round,
    were dropped too, so that both are judged the same way (marked `again` in `review-log.jsonl`).

**The check was tested** as opb's was (`canary/`, `eras_tests.py canary`). A fresh checker got 14 tests.
Seven had been broken on purpose: two digits changed, two words dropped, two orders swapped, two letters
swapped in a column heading. It caught all 7, and its fix gave back each original test exactly. It kept all 7
real tests. The canary was drawn from the first round's tests.

## What differs from opb's instructions, for writers and checkers

- The page image is `blocks/.data/eras/png/<page_id>.png`, and close-ups come from
  `../opb/.venv/bin/python eras_tests.py zoom <page_id> <x0> <y0> <x1> <y1>`, run in `blocks/`.
- "Nothing else" means here: don't open `blocks/.data/eras/pdf/`, `pages.jsonl`, any run or conversion under
  `blocks/.data/`, `blocks/results/`, or other writers' files in `reference-eras/tests/`. The worked examples
  in `opb/reference/tests/` named by `writing-tests.md` may be read.
- Check files with `../opb/.venv/bin/python eras_tests.py validate reference-eras/tests/<page_id>.json`.

## Commands

```sh
cd benchmarks/ingestion/blocks
P=../opb/.venv/bin/python
$P eras_tests.py select && $P eras_tests.py sheets      # pages; contact sheets for the scan table screen
$P eras_tests.py select-tables && $P eras_tests.py render   # more table pages (needs scan-tables.json); images
$P eras_tests.py validate                               # every test file
$P eras_tests.py verify-queue 6                         # .data/eras/verify/batch-NN.jsonl
$P eras_tests.py apply-review                           # result-NN.jsonl into tests/, logged
$P eras_tests.py dataset && $P eras_tests.py counts
```
