# Blocks benchmark, run 2 (11 Nov 2026): Marker 1.10.2 against Docling + Tesseract variants

Marker 1.10.2 on a T4 GPU, and Docling with Tesseract (Norwegian) in six variants on a 32-vCPU CPU host, on 39
Kudos documents (1,100 pages). Then a throughput test of Docling + Tesseract with several documents at once.
**Only this run counts:** the reference is this run's Marker 1.10.2 on the T4. The first run's conversions and
grades, the Kudos pilot's Marker side and the Mac sides were not used (earlier, not used).

## What ran

| Host label                             | VM                                            | Region         | $/h (list, Linux) | Parsers                                                                              |
| -------------------------------------- | --------------------------------------------- | -------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `azure-NC4as_T4_v3-francecentral-run2` | Standard_NC4as_T4_v3 (Tesla T4 16 GB, 4 vCPU) | France Central | 0.615             | `marker` (reference), `marker-strip`                                                 |
| `azure-D32as_v6-swedencentral-run2`    | Standard_D32as_v6 (32 vCPU, no GPU)           | Sweden Central | 1.552             | `docling-tess`, `-repair`, `-nocells`, `-egret`, `-noreng`, `-best`; throughput test |

Ubuntu 24.04, 256 GB Premium SSD, Docker 29.1.3; the T4 with NVIDIA driver 580-server and the container toolkit.
Images and settings as in `README.md` of this folder (the first run's record); the variants:

| Parser                     | Change on top of `docling-tess` (Tesseract CLI, `lang ["nor"]`, Heron layout, TableFormer accurate)                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `docling-tess-repair`      | `replace_broken_text_layer`: also OCR pages whose text layer Docling finds broken                                                     |
| `docling-tess-nocells`     | table cell matching off (TableFormer's own cells)                                                                                     |
| `docling-tess-egret`       | layout model Egret large instead of Heron                                                                                             |
| `docling-tess-noreng`      | Tesseract `nor` + `eng`                                                                                                               |
| `docling-tess-best`        | tessdata_best 4.1.0 Norwegian model (with `osd.traineddata` and `configs/` copied; no `KeyError` in the log, scans have text and æøå) |
| `marker-strip` (on Marker) | `strip_existing_ocr`: old OCR text layers dropped and read again by Marker's OCR                                                      |

**Documents:** `documents-run2.json`, the 15 of `documents.json` plus the 24 of `eras-test-set.json` (doc_num =
first 8 characters of the uuid), every PDF checked against its sha256. 24 of the 39 have scanned pages: the set
was picked to include scans and hard layouts, so it is slower than KUDOS as a whole (93% of KUDOS pages are
digital, `eras.md`).

**Every run converted all 39 documents; no document failed on any side.**

### Changes for this run

Environment and tooling only; no parser setting was changed.

| Change                                                                                                                 | Why                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| VMs: systemd-resolved set to 1.1.1.1 / 8.8.8.8                                                                         | Azure's resolver (168.63.129.16) timed out on both new VMs while the internet answered by IP; apt could not resolve its mirrors |
| Auto-shutdown 23:30 UTC instead of 19:00                                                                               | The VMs started 15:25 UTC; 19:00 would have stopped both runs                                                                   |
| SSH rule moved to the new client IP mid-run                                                                            | The client's public IP changed; the runs went on in tmux                                                                        |
| `run.sh`, `fetch.py`, `compare.py`: `DOCUMENTS=<list>`                                                                 | Another document list; `run.sh` mounts it into the container as `--documents`                                                   |
| `convert/common.py`: `started`/`ended` per document in `timings.jsonl`                                                 | Wall-clock windows for the throughput test                                                                                      |
| `convert/convert_docling.py`: `DOCLING_THREADS`                                                                        | Threads per container in the throughput test (default unchanged: all vCPUs)                                                     |
| New: `throughput.sh`, `throughput.py`, `page_tests_run2.py`, `heading_levels.py`; `headings_vs_outline.py --numbering` | Below                                                                                                                           |

## Quality: page tests

Graded by `page_tests_run2.py` with the opb scorer, each page cut out of the whole-document output
(`page_tests_extract.py`). Two test sets, each scored on its own, never pooled; full tables, every slice and
interval in `page-tests-run2.md`. Differences are side minus reference in points with document-resampled 95%
intervals; ✱ = the interval leaves out zero. Slices from fewer than 10 documents (†) are hints, without trusted
intervals.

### Era test set (24 documents, scored by its rule)

Text = present and order tests on the first round's pages (378 tests, 43 pages, 24 documents); tables =
table_cell tests on all pages (200 tests, 11 documents); all = both. Ranked by all.

| Side                                  |  All | Text | Tables | Digital (19 docs) | Scan + text† (4) | Image-only† (5) | All − reference     |
| ------------------------------------- | ---: | ---: | -----: | ----------------: | ---------------: | --------------: | ------------------- |
| Docling + Tesseract, tessdata_best    | 81.1 | 94.4 |   56.0 |              82.3 |             73.0 |            83.8 | +2.4 (−2.6 to +8.2) |
| Docling + Tesseract                   | 81.0 | 95.0 |   54.5 |              81.2 |             70.8 |            88.6 | +2.2 (−3.3 to +8.3) |
| Docling + Tesseract, repair           | 81.0 | 95.0 |   54.5 |              81.2 |             70.8 |            88.6 | +2.2 (−3.3 to +8.3) |
| Docling + Tesseract, Egret large      | 80.8 | 94.7 |   54.5 |              81.8 |             68.5 |            87.6 | +2.1 (−3.3 to +7.4) |
| Docling + Tesseract nor+eng           | 80.4 | 93.4 |   56.0 |              81.2 |             74.2 |            82.9 | +1.7 (−3.2 to +7.7) |
| **Marker 1.10.2 (reference)**         | 78.7 | 96.6 |   45.0 |              79.7 |             79.8 |            74.3 |                     |
| Marker 1.10.2, strip_existing_ocr     | 78.4 | 96.6 |   44.0 |              79.2 |             79.8 |            74.3 | −0.3 (−1.1 to 0.0)  |
| Docling + Tesseract, no cell matching | 76.5 | 93.7 |   44.0 |              74.0 |             73.0 |            88.6 | −2.2 (−6.7 to +3.6) |

Per era (all scored tests, 6 documents each, so hints):

| Side                               | Before 2000 | 2000–2009 | 2010–2019 | 2020 on |
| ---------------------------------- | ----------: | --------: | --------: | ------: |
| Docling + Tesseract                |        78.8 |      86.7 |      90.5 |    70.9 |
| Docling + Tesseract, tessdata_best |        80.5 |      86.7 |      86.2 |    73.2 |
| **Marker 1.10.2 (reference)**      |        85.6 |      80.0 |      87.9 |    67.0 |

"Text around tables" (text tests on the 33 added table pages, 303 tests from 12 documents, shown alone): Docling

- Tesseract 94.4, Egret 95.0, Marker 91.7.

### opb page tests (15 documents of `documents.json`, 287 tests)

| Side                                  |  All | Text | Tables† (8) | Digital (11) | Scan + text† (5) | Image-only† (4) | All − reference        |
| ------------------------------------- | ---: | ---: | ----------: | -----------: | ---------------: | --------------: | ---------------------- |
| Docling + Tesseract, Egret large      | 93.0 | 96.1 |        65.5 |         91.9 |            100.0 |            90.2 | +5.9 ✱ (+0.7 to +13.8) |
| Docling + Tesseract nor+eng           | 93.0 | 96.1 |        65.5 |         92.4 |            100.0 |            87.8 | +5.9 ✱ (+0.7 to +13.3) |
| Docling + Tesseract, tessdata_best    | 93.0 | 96.1 |        65.5 |         92.4 |            100.0 |            87.8 | +5.9 ✱ (+1.0 to +13.5) |
| Docling + Tesseract                   | 92.7 | 95.7 |        65.5 |         92.4 |            100.0 |            85.4 | +5.6 ✱ (+0.3 to +13.2) |
| Docling + Tesseract, repair           | 92.7 | 95.7 |        65.5 |         92.4 |            100.0 |            85.4 | +5.6 ✱ (+0.3 to +12.9) |
| Marker 1.10.2, strip_existing_ocr     | 87.5 | 89.9 |        65.5 |         88.9 |             81.2 |            87.8 | +0.3 (0.0 to +1.1)     |
| **Marker 1.10.2 (reference)**         | 87.1 | 89.5 |        65.5 |         88.9 |             79.2 |            87.8 |                        |
| Docling + Tesseract, no cell matching | 86.1 | 93.0 |        24.1 |         82.8 |            100.0 |            85.4 | −1.0 (−8.0 to +7.8)    |

### Reading

- **Docling + Tesseract is at least as good as Marker 1.10.2.** On the opb set every Docling + Tesseract variant
  except no-cell-matching is clearly ahead (+5.6 to +5.9, text +6.2 to +6.6). On the era set they are level:
  +1.7 to +2.4, every interval includes zero.
- **Which Docling variant:** none is clearly better than plain `docling-tess`. The five good ones are within
  0.7 points of each other on the era set and 0.3 on the opb set. `repair` gives byte-identical Markdown to
  `docling-tess` on all 39 documents (Docling found no broken text layer); tessdata_best (+0.1) costs 14% more
  time; Egret (−0.2) and nor+eng (−0.6, and era text −3.2 ✱ against the reference) bring nothing.
  **No cell matching is the one to avoid**: tables 24.1 against 65.5 on the opb set (8 documents), 44.0 against
  54.5 on the era set, and digital pages −5.7 ✱ on the era set.
- **Old and scanned documents (hints, 4–6 documents per slice):** it splits by kind of scan.
  - Scans _with_ an old text layer: Marker leads (79.8 against 70.8; before 2000 85.6 against 78.8). Docling
    reads the old OCR layer as it is.
  - Image-only scans: Docling leads (88.6 against 74.3 on the era set).
  - `marker-strip`, which re-reads old OCR layers, changes the output of 14 of the 39 documents (9 of the 10
    with scan + text pages, and 5 digital ones) but not the score (−0.3, within 1 point everywhere), and is 31%
    slower; on one 80-page digital document its time went from 63 s to 539 s.
  - Docling uses an existing text layer as it is, and its `repair` changed nothing here. Making it re-read a
    poor old OCR layer would take forcing OCR on whole pages, which was not tried (it would also replace exact
    digital text layers).
- **Tables:** Docling ahead on the era set (+9.5 to +11.0, from 11 documents; interval includes zero), level on
  the opb set. On scans the table tests come from 3 documents.

## Headings

`headings_vs_outline.py`: each outline entry (the PDF's own bookmarks) matched to a parser heading on the same
or next page; 16 of the 39 documents have an outline, 385 entries (levels 1–4).

| Side                                          | Outline headings found | Level changes followed | Same-level steps kept | All nesting steps right |
| --------------------------------------------- | ---------------------: | ---------------------: | --------------------: | ----------------------: |
| Marker 1.10.2                                 |        379 / 385 (98%) |         76 / 134 (57%) |       150 / 229 (66%) |         226 / 363 (62%) |
| Marker 1.10.2, strip_existing_ocr             |        379 / 385 (98%) |         68 / 134 (51%) |       150 / 229 (66%) |         218 / 363 (60%) |
| Docling + Tesseract (every variant but Egret) |        379 / 385 (98%) |           0 / 134 (0%) |      229 / 229 (100%) |         229 / 363 (63%) |
| Docling + Tesseract, Egret large              |        376 / 385 (98%) |           0 / 133 (0%) |      227 / 227 (100%) |         227 / 360 (63%) |

- **Every side finds the headings** (98%). Docling gives every heading level 1, so it follows no level change.
- **Numbering as a level source** (`--numbering`: level = depth of the heading's own section number, numbered
  headings only): on Docling's headings it follows 109 of 110 level changes, on Marker's 109 of 110; it covers
  286 of the 385 outline entries (74%), the numbered ones.

### Giving Docling's headings levels: `heading_levels.py` (prototype)

A step after conversion that rewrites `level` in the blocks, per document by the first rung that applies:
the PDF's outline (in production only), then section numbers (when at least 30% of headings carry one), then
text size (font size × the text matrix's scale from the PDF's text layer, bold as a 0.4 pt tie-break; box height
on scans). Scored against the outlines **without** the outline rung, since the outline is the reference:

| Side                                        | Level changes followed | All nesting steps right |     Level exact |
| ------------------------------------------- | ---------------------: | ----------------------: | --------------: |
| Docling + Tesseract, as it comes            |           0 / 134 (0%) |         229 / 363 (63%) | 110 / 379 (29%) |
| Marker 1.10.2, as it comes                  |         76 / 134 (57%) |         226 / 363 (62%) | 139 / 379 (37%) |
| **Docling + Tesseract + heading_levels.py** |    **132 / 134 (99%)** |     **358 / 363 (99%)** | 296 / 379 (78%) |
| Marker 1.10.2 + heading_levels.py           |        132 / 134 (99%) |         358 / 363 (99%) | 296 / 379 (78%) |

- Section numbers did most of it (108 of 113 level changes before the size rung was fixed).
- **The size rung was fitted on these documents:** at first it read every heading as size 1 (these PDFs scale
  text through the matrix) and followed 1 of 21 level changes; the matrix scale and the bold tie-break were
  added after looking at those failures. It rests on about 100 headings in a few documents; check it on outline
  documents it has not seen before trusting 99%. Scans are untested (the outline documents are digital).
- "Level exact" is lower because some documents start a level off (chapters as 2); nesting is right.
- With the outline rung (`--mode full`) the 16 outline documents are exact by construction.
- `docling-hierarchical-pdf` 0.2.0 (MIT) was tried on the stored output and dropped: it needs PyMuPDF, which is
  AGPL-licensed. On stored output, without the outline, it followed 87 of 134 level changes and turned about 100
  more blocks into headings.

## Notes: speed, throughput, cost

Not part of the ranking. Seconds per page are all 1,100 pages, one document at a time unless stated.

| Side                     | s/page | Digital-only docs | Docs with scans | Peak GPU | Mean GPU use |
| ------------------------ | -----: | ----------------: | --------------: | -------: | -----------: |
| T4 marker                |   3.95 |              1.45 |            6.01 |  11.4 GB |          80% |
| T4 marker-strip          |   5.18 |              2.83 |            7.11 |  10.1 GB |          82% |
| D32 docling-tess         |   1.85 |              1.03 |            2.54 |          |              |
| D32 docling-tess-repair  |   1.81 |              0.95 |            2.51 |          |              |
| D32 docling-tess-nocells |   1.81 |              0.95 |            2.52 |          |              |
| D32 docling-tess-egret   |   1.82 |              0.97 |            2.52 |          |              |
| D32 docling-tess-noreng  |   1.95 |              0.98 |            2.76 |          |              |
| D32 docling-tess-best    |   2.10 |              0.99 |            3.02 |          |              |

- **One Docling process uses about 6 of 32 vCPUs** (14–19% busy during `noreng`; no steal, 3.7 GHz, no CPU
  limit): not throttling. Docling works 4 pages at a time per stage and calls Tesseract once per text region in
  sequence; more threads only help the layout and table models.
- The T4 is busy with Marker (80% mean GPU use, sampled from container start), so running several documents at
  once on one T4 probably gains little; not measured.

### Throughput (`throughput.sh`, `throughput.md`)

`docling-tess` on all 39 documents split by pages across N containers, Docling threads = 32 / N. Round = all
containers started to all exited, model loading included. Single-stream is the `docling-tess` run above (same
image, settings, documents and VM); its 1-worker round was stopped and skipped as a repeat.

|                  Workers | Threads each |  Round | Pages/hour | × single |        CPU busy | Workers finished (s) |
| -----------------------: | -----------: | -----: | ---------: | -------: | --------------: | -------------------- |
| 1 (the docling-tess run) |           32 | 34 min |      1,946 |      1.0 | 14–19% (sample) |                      |
|                        4 |            8 |  972 s |      4,073 |      2.1 |             61% | 573–971              |
|                        8 |            4 |  732 s |      5,413 |      2.8 |             76% | 334–730              |

- Workers finish far apart: pages were split evenly, but scans take longer. A queue handing out documents one
  at a time would finish closer to the fastest worker; the 8-worker CPU is still 24% idle.

### Cost per 1,000 pages and projections

**Projections, not measurements:** list price × measured time, as if all of KUDOS behaved like these 39
documents (which over-represent scans, so the projections lean high). Phase 1 = 646,558 pages, all of KUDOS =
3,141,333 pages.

| Host, side                            | Pages/hour | $ / 1,000 pages | Phase 1: $ / VM-hours | All KUDOS: $ / VM-hours |
| ------------------------------------- | ---------: | --------------: | --------------------: | ----------------------: |
| T4, marker, one at a time             |        911 |           0.675 |             436 / 709 |           2,120 / 3,447 |
| T4, marker-strip, one at a time       |        695 |           0.885 |             572 / 930 |           2,780 / 4,520 |
| D32, docling-tess, one at a time      |      1,946 |           0.798 |             516 / 332 |           2,505 / 1,614 |
| D32, docling-tess-best, one at a time |      1,714 |           0.905 |             585 / 377 |           2,844 / 1,832 |
| D32, docling-tess, 4 workers          |      4,073 |           0.381 |             246 / 159 |             1,197 / 771 |
| **D32, docling-tess, 8 workers**      |      5,413 |       **0.287** |         **185 / 120** |           **901 / 581** |

## What the run cost

At list prices, VM created to deleted (from this session's timestamps); the billed amount shows in Cost
Management a day or so later and may differ.

| VM                       | Running (UTC) | Hours |     VM $ | Disk + IP $ (≈ $0.065/h) |
| ------------------------ | ------------- | ----: | -------: | -----------------------: |
| T4, France Central       | 15:26–18:52   |  3.43 |     2.11 |                     0.22 |
| D32as_v6, Sweden Central | 15:26–20:18   |  4.88 |     7.57 |                     0.32 |
| **Total**                |               |       | **9.68** |                 **0.54** |

About **$10.20**. Everything is deleted: resource group `genki-parser-bench` no longer exists and nothing tagged
`purpose=genki-parser-benchmark` is left in the subscription. Quotas stay and cost nothing.

## Files

- Small files per host: `results/azure-NC4as_T4_v3-francecentral-run2/`, `results/azure-D32as_v6-swedencentral-run2/`
  (meta, timings, GPU samples, `structure.md`, `throughput.md`/`.json`).
- Native output, blocks, logs: `.data/runs/<label>/` (local, not committed); throughput rounds under
  `throughput/n4`, `n8` (`n1-stopped-skipped` is the stopped round, not used).
- Page tests: `page-tests-run2.md`, grades in `.data/page-tests-run2/`.
- Heading levels: `heading_levels.py`, outputs in `.data/levels-run2/`.

No document text is in this file.
