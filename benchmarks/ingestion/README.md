# Ingestion benchmark: KUDOS text vs our pipeline

Compares the text KUDOS serves at `/documents/{uuid}/contents` with the text our own PDF-to-text pipeline (Marker) put in the Typesense index, page by page, on a frozen sample of 150 Kudos documents. It runs Steps 1 and 2 of the [evaluation plan](https://claude.ai/code/artifact/4acf69ec-b094-409a-a257-a750d440156f): pair the same documents, then run cheap automated checks that need no ground truth. The plan holds the results and what they mean for the decision.

## Commands

```sh
cd benchmarks/ingestion
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

.venv/bin/python fetch_lists.py   # KUDOS listing, our Typesense records, nb/nn dictionaries (~10 min)
.venv/bin/python pair.py          # pair on sha256 and draw a new sample.json
.venv/bin/python fetch.py         # KUDOS text, our chunks and the PDF for each sampled document (~900 MB)
.venv/bin/python checks.py        # Step 2 checks, per page (~3 min once the dictionary cache is warm)
.venv/bin/python summarize.py     # summary and the pages for Step 3
.venv/bin/python -m unittest -v   # tests for the text heuristics
```

To recheck the committed sample instead of drawing a new one, skip `pair.py` and run `fetch_lists.py dictionaries` instead of the full `fetch_lists.py`.

Everything downloaded or computed lands in `.data/` (git-ignored); `INGESTION_BENCHMARK_DATA` points it elsewhere. Python 3.9 or later.

## Settings

| Variable                         | Used by                      | Notes                                                                |
| -------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `TYPESENSE_URL`, `TYPESENSE_KEY` | `fetch_lists.py`, `fetch.py` | The search key genki uses; read from the environment or `.env.local` |

The KUDOS API needs no key. It allows 180 requests a minute and 50 documents a page, and `/documents/search` stops paging after 10,000 results, so the listing uses `/documents`.

## Output

| File                                 | Holds                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `sample.json`                        | The 150 sampled pairs, with stratum and corpus weight (committed)      |
| `.data/results/pages.csv`            | Every check per page, for both sources                                 |
| `.data/results/docs.csv`             | Page alignment, flag counts and verdicts per document                  |
| `.data/results/summary.json`         | Rates by check, PDF class and document type; weighted corpus estimates |
| `.data/results/step3-candidates.csv` | The pages the tuned checks flag, with their likely cause, for Step 3   |

## Method

- **Pairing.** A document pairs when its one file has the same sha256 as a KUDOS document's primary file, which also proves the file version is unchanged. Documents with several files are skipped.
- **Sample.** 18–19 documents per type, half from files over 150 KB per page to catch scans. Each carries a weight (stratum size / sampled) for corpus estimates with a stratified bootstrap 95% CI.
- **Our side.** Rebuilt from the Typesense chunks in `chunk_index` order and split on Marker's page markers (`{n}` and 48 dashes). Heading lines the chunker stripped go back from each chunk's metadata, onto the page their Marker anchor names. Tables of contents and chunks under 333 characters stay lost, so text KUDOS has and we lack is a hint, not a flag.
- **Checks.** Each check flags a page twice: once at the plan's starting threshold, in either direction, and once tuned, counting only pages where KUDOS is the worse side. The tuned rule strips repeated header and footer lines first and measures similarity as overlap of 5-word sequences, since edit distance punishes a moved block as heavily as a missing one. The docstring of `checks.py` lists every threshold; all are starting points.
