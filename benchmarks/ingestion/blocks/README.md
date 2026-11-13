# Blocks: parser output in one format, for rechunking and citations

The page tests (`../opb`) graded how much of each page's text a parser gets right. They kept only Markdown, so
they say nothing about structure: headings and their levels, lists, tables as units, page headers and footers,
or reading order across pages. A chunker lives on that structure, and a citation needs to point back to a page
and a place on it.

This folder converts 15 whole Kudos documents with each parser on the hardware we would run it on, keeps each
parser's own structured output, and normalises it to one block format. Any chunking can then be run from the
blocks without converting again, and every chunk can be cited back to its page, its boxes and its span of text.

## The documents

`documents.json`: 15 documents (332 pages, 64 MB) from the ingestion sample, one to three of every Kudos type,
with table pages, scans with a text layer (5) and image-only scans (5). Each has pages in the opb page tests.
`fetch.py` downloads them from KUDOS and checks each against its sha256.

## The block format

`normalise.py` writes, per parser and document, `blocks.jsonl`, `text.md` and `pages.json`; the docstring has
every field. In short, each block has its page, its box (fractions of the page, origin top left), a kind
(heading, paragraph, list item, table, figure, caption, footnote, page furniture, ...), its heading level and
heading path, its text (a table as a Markdown table, with its HTML too), and `start`/`end`, where that text sits
in `text.md`.

A chunk made from blocks carries its block ids, pages, boxes and span of `text.md`. That is what a citation
needs: the cited phrase can be shown inside the text around it (`text.md`, or the neighbouring blocks), and
highlighted on the page image by its blocks' boxes. Boxes are per block, not per word; a phrase inside a block is
found by its offsets in the block's text.

Page headers, footers and page numbers are kept, marked `furniture`, and left out of `text.md`, so they never end
up inside a chunk.

## Running it

On a Linux host with Docker (and the NVIDIA driver and container toolkit for a GPU):

```sh
HOST_LABEL=azure-NC4as_T4_v3-swedencentral ./run.sh            # docling, docling-no, mineru, marker
HOST_LABEL=azure-D8as_v6-westeurope ./run.sh --cpu docling docling-no marker
```

Each parser runs in its own container (`docker/`), one at a time, with the versions and settings the page tests
graded. The smallest document is converted once before timing, so model downloads and loading are not counted;
`nvidia-smi` is sampled every 2 s for GPU memory and use. The run writes `.data/runs/<HOST_LABEL>/` (native
output, blocks, logs) and copies `structure.md`, `meta.json`, `timings.jsonl` and `gpu.csv` to
`results/<HOST_LABEL>/`. Copy `.data/runs/<HOST_LABEL>` back with `rsync` to look at the blocks.

`compare.py run-a run-b ...` puts several hosts' seconds per page side by side.

On a Mac, the converters run in the opb venvs without containers (`convert/convert_*.py <pdfs> <out> --device
mps`, MinerU with `--device mlx`), as the smoke run below did.

### Azure

No subscription we use has GPU quota yet (checked 11 Nov 2026 in Altinn-AI-Assistant: 0 vCPUs for every NC,
ND and current NV family in Sweden Central, West Europe and Norway East). A quota request comes first. The sizes
issue 337 priced: `Standard_NC4as_T4_v3` (T4, Sweden Central or West Europe), `Standard_NC24ads_A100_v4`
(A100 80 GB), and `Standard_D8as_v6` for the CPU run. Use an Ubuntu image with the NVIDIA driver (or the
`NvidiaGpuDriverLinux` extension), install Docker and the NVIDIA container toolkit, clone this branch, and run.
Delete the VM afterwards.

## Smoke run (M3 Pro Mac, 3 documents, 11 Nov 2026)

`.data/runs/mac-smoke`, documents 33245 (digital, tables), 8562 (image-only scan) and 5944 (scan with a text
layer). Not a result, but it shows what the page tests could not:

- **Docling's default OCR drops æ, ø and å.** The default resolves to EasyOCR with English only in the smoke run and the containers; the page tests' graded `docling` side was RapidOCR instead (see `results/README.md`). On both scans its text has none ("okonomiregelverket",
  "Narings-"), 0 per 1,000 letters against about 21 for Marker and MinerU. On the digital document it reads the
  text layer and keeps them. The run therefore includes `docling-no` (EasyOCR with Norwegian).
- **Heading levels:** Docling gives every heading level 1, MinerU level 2 (the title 0), Marker levels 1 to 4.
  Only Marker gives a heading path deeper than one heading.
- **MinerU merged a heading into the paragraph under it** on 8562 ("2 Instruksens formål ..."), so that section's
  blocks sit under the previous heading, and it gives lists as paragraphs starting with "- ".
- Every block of all three parsers has a box, and every offset gives back its block's text.

## Files

| File                                                              | What it does                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents.json`                                                  | The 15 documents                                                                                                                                                                                                          |
| `fetch.py`                                                        | Downloads or copies the PDFs, checked by sha256                                                                                                                                                                           |
| `convert/convert_{docling,mineru,marker}.py`, `convert/common.py` | Whole-document conversion, native output kept                                                                                                                                                                             |
| `docker/Dockerfile.*`                                             | One image per parser, pinned to the versions the page tests ran                                                                                                                                                           |
| `normalise.py`, `test_normalise.py`                               | Native output to blocks (`python3 -m unittest test_normalise`)                                                                                                                                                            |
| `compare.py`                                                      | `structure.md`: blocks, headings, levels, lists, tables, furniture, æøå, seconds per page                                                                                                                                 |
| `run.sh`                                                          | All of it on one host                                                                                                                                                                                                     |
| `headings_vs_outline.py`                                          | Heading quality against the PDFs' own outlines (`results/headings-vs-outline.md`)                                                                                                                                         |
| `page_tests.py`, `page_tests_extract.py`                          | The opb page tests on the Azure runs: pages cut from whole documents, graded with the opb scorer (`results/page-tests-azure.md`)                                                                                          |
| `eras_tests.py`, `reference-eras/`                                | Page tests for the era test set (`results/eras-test-set.json`), opb's method and scorer, a set of its own (`reference-eras/README.md`)                                                                                    |
| `results/README.md`                                               | The Azure run of 11 Nov 2026: configs, fixes, results                                                                                                                                                                     |
| `results/run2.md`                                                 | Run 2 (11 Nov 2026): Marker 1.10.2 (T4, reference) against six Docling + Tesseract variants on 39 documents, throughput, cost, heading levels                                                                             |
| `documents-run2.json`                                             | Run 2's 39 documents (`DOCUMENTS=documents-run2.json ./run.sh ...`)                                                                                                                                                       |
| `throughput.sh`, `throughput.py`                                  | Docling + Tesseract with N containers at once on one CPU host (`results/<host>/throughput.md`)                                                                                                                            |
| `page_tests_run2.py`                                              | Run 2 graded on the opb and era page tests, each on its own (`results/page-tests-run2.md`)                                                                                                                                |
| `heading_levels.py`                                               | Prototype: heading levels after conversion (outline, then section numbers, then text size)                                                                                                                                |
| `eras_sample.py`                                                  | 50 random documents per era of the KUDOS listing (back before 2000), every page classified; `results/eras.md` (page kinds per era), `results/eras-sample.json`, `results/eras-test-set.json` (24 hard and easy documents) |
