# Text checks: KUDOS text vs the indexed Marker text

Could the text KUDOS serves (`/documents/{uuid}/contents`) replace our own PDF-to-text for the Kudos import? This folder runs Steps 1 and 2 of the [evaluation plan](https://claude.ai/code/artifact/4acf69ec-b094-409a-a257-a750d440156f) on 150 sampled documents: it pairs the same files and runs checks that compare the two texts page by page. The choice it informed: Marker for every document (22 October 2026).

**There is no reference here.** The checks find where KUDOS's text and the indexed Marker text disagree, not which one is right. [`opb/`](opb/README.md) grades both against a reference written from the page images. This folder is also the data the page tests build on: the sample, the downloads and each page's kind (`results/pages.csv`).

## Results

Checked 21 October 2026 and rerun 26 October with identical per-page and per-document results. The numbers are in [`results/summary.json`](results/summary.json); what the run used is in `results/record.json`.

KUDOS text is the PDF's own text layer. On ordinary pages it matches the indexed text. It loses the page breaks of scans and comes back empty on image pages: those failures hit 8.4% of documents, corpus-weighted. The checks flag 57.9% of pages at the plan's starting thresholds, and 21.6% counting only pages where KUDOS is the worse side. The evaluation plan holds what this meant for the decision.

## Sides

| Side           | Text                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KUDOS          | `/documents/{uuid}/contents`, split on its page breaks                                                                                                                 |
| Indexed Marker | The text genki's Typesense index holds (`KUDOS_preprod_v4_*`), rebuilt into pages from its chunks: the Marker output of the old pipeline, not the Kudos pilot's Marker |

## Reference

None: the two texts are compared with each other. The page tests in `opb/` are the version with a reference.

## Method

- **Pairing.** A document pairs when its one file has the same sha256 as a KUDOS document's primary file, which also proves the file version is unchanged. Documents with several files are skipped.
- **Sample.** 18–19 documents per type, half from files over 150 KB per page to catch scans. Each carries a weight (stratum size / sampled) for corpus estimates.
- **Our side.** Rebuilt from the Typesense chunks in `chunk_index` order and split on Marker's page markers (`{n}` and 48 dashes). Heading lines the chunker stripped go back from each chunk's metadata, onto the page their Marker anchor names. Tables of contents and chunks under 333 characters stay lost, so text KUDOS has and we lack is a hint, not a flag.
- **Checks.** Each check flags a page twice: once at the plan's starting threshold, in either direction, and once tuned, counting only pages where KUDOS is the worse side. The tuned rule strips repeated header and footer lines first and measures similarity as overlap of 5-word sequences, since edit distance punishes a moved block as heavily as a missing one. The docstring of `checks.py` lists every threshold; all are starting points.
- **Corpus estimates** are weighted shares of documents with a 95% interval from resampling documents within each stratum, 10,000 times (`benchlib.stats.compare`, seeded per estimate). Recomputed this way on 26 October 2026; the shares are unchanged, and interval ends moved by at most 0.6 points.

## Commands

```sh
cd benchmarks/ingestion
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # Python 3.9 or later

.venv/bin/python fetch_lists.py   # KUDOS listing, our Typesense records, nb/nn dictionaries (~10 min)
.venv/bin/python pair.py          # pair on sha256 and draw a new sample.json; results/pairing-summary.json
.venv/bin/python fetch.py         # KUDOS text, our chunks and the PDF for each sampled document (~900 MB)
.venv/bin/python checks.py        # every check per page: results/pages.csv, docs.csv, record.json (~3 min)
.venv/bin/python summarize.py     # results/summary.json, from results/ and sample.json alone
.venv/bin/python -m unittest -v   # tests for the text heuristics
```

To recheck the committed sample instead of drawing a new one, skip `pair.py` and run `fetch_lists.py dictionaries` instead of the full `fetch_lists.py`.

## Settings

| Variable                         | Used by                      | Notes                                                                |
| -------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `TYPESENSE_URL`, `TYPESENSE_KEY` | `fetch_lists.py`, `fetch.py` | The search key genki uses; read from the environment or `.env.local` |
| `INGESTION_BENCHMARK_DATA`       | every script                 | Where downloads go; `.data/` by default                              |

The KUDOS API needs no key. It allows 180 requests a minute and 50 documents a page, and `/documents/search` stops paging after 10,000 results, so the listing uses `/documents`.

## Files

| File                           | Holds                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `sample.json`                  | The 150 sampled pairs, with stratum and corpus weight                                                   |
| `results/pairing-summary.json` | How the KUDOS listing and our index paired                                                              |
| `results/pages.csv`            | Every check per page, for both sides                                                                    |
| `results/docs.csv`             | Page alignment, flag counts and verdicts per document                                                   |
| `results/summary.json`         | Rates by check, PDF class and document type; weighted corpus estimates                                  |
| `results/record.json`          | What the run used: commit, code and sample hashes, the texts read, thresholds and package versions      |
| `.data/` (git-ignored)         | Listings, downloads, the dictionary cache, and `step3-candidates.csv` (the pages the tuned checks flag) |

## Limits

- No reference: a page where both texts agree can still be wrong, and a flag says only that they differ.
- The indexed Marker text is a reconstruction from search chunks: 32 pages are missing and large tables may be lost.
- The thresholds are starting points, not tuned against a reference.
