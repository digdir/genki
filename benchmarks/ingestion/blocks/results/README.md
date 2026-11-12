# Blocks benchmark on Azure, 11 Nov 2026

Five parsers and three config variants on three Azure hosts, 15 Kudos documents (332 pages). This page records
what ran (hosts, each parser's version and settings, what was changed to make the containers run) and the results. Each run's own record is `results/<host>/<parser>/meta.json` (versions, settings, models, device,
machine), written by the converter at the start of the run.

## Hosts

| Host label | VM | GPU | vCPU / RAM | Region | $/h (list, Linux) | Parsers |
| --- | --- | --- | --- | --- | --- | --- |
| `azure-NC4as_T4_v3-francecentral` | Standard_NC4as_T4_v3 | Tesla T4 16 GB (Turing, compute 7.5, no bf16) | 4 / 28 GB | France Central | 0.615 | all eight |
| `azure-NC24ads_A100_v4-swedencentral` | Standard_NC24ads_A100_v4 | A100 80GB PCIe (Ampere, compute 8.0) | 24 / 216 GB | Sweden Central | 4.775 | all eight |
| `azure-D8as_v6-swedencentral` | Standard_D8as_v6 | none (`run.sh --cpu`) | 8 / 31 GB | Sweden Central | 0.388 | docling, docling-no, docling-tess, docling-rapid; marker stopped after 5 documents |

All: Ubuntu 24.04 LTS, 256 GB Premium SSD, Docker 29.1.3 (Ubuntu's `docker.io`). GPU hosts: NVIDIA driver
580.178.04 server (CUDA 13.0) from `ubuntu-drivers install --gpgpu nvidia:580-server`, NVIDIA container toolkit.
The T4 is in France Central because T4 quota was refused in Sweden Central, Norway East, North Europe and Germany
West Central, and West Europe (approved) had no T4 capacity in any zone.

## Parsers

Every parser runs in its own container (`docker/Dockerfile.*`), one at a time, as the host user, with model
caches in `.data/home`. The smallest document (33245) is converted once before timing. Timings cover the 15
documents after that; `gpu.csv` samples `nvidia-smi` every 2 s from container start, so it includes model loading.

| | docling | docling-no | mineru | marker | marker2 |
| --- | --- | --- | --- | --- | --- |
| Package | docling 2.146.0 (core 2.105.0, ibm-models 4.0.4) | same image | mineru 4.1.6, mineru-vl-utils 2.0.8, docvortex 0.6.21 | marker-pdf 1.10.2 | marker-pdf 2.1.0, surya-ocr 0.23.0 |
| Python / torch | 3.13 / 2.15.0 (cu132) | same | 3.12 / 2.13.0 (cu130) | 3.13 / 2.14.1 | 3.13 / 2.15.0 |
| Layout | Heron (`docling-project/docling-layout-heron`) | same | MinerU-4 small models (`MinerU-4_models_torch`) | Surya layout | Surya 2.5 VLM (layout and OCR in one model) |
| Text | text layer where there is one | same | auto: text layer or OCR per page (`ocr_mode auto`) | text layer, OCR where needed | text layer, VLM OCR where needed |
| OCR for bitmaps | EasyOCR 1.7.2, **English only** (see below) | EasyOCR 1.7.2, Norwegian + English | MinerU2.5-Pro VLM (`MinerU2.5-Pro-2605-1.2B`) | Surya OCR, `languages "no,en"` | `datalab-to/surya-ocr-2.5` |
| Tables | TableFormer, mode accurate | same | MinerU's | Marker's table processor | Surya 2.5 |
| Settings | default `PdfPipelineOptions`, `do_ocr` on, threads = vCPUs | + `EasyOcrOptions(lang=["no","en"])` | tier `standard`, `image_analysis` on, telemetry off | the Marker service's (PR 91): `languages "no,en"`, `disable_image_extraction`, `paginate_output`, Markdown; no LLM | `mode "balanced"` (the page tests' setting, Marker 2.1's default on CUDA), `disable_image_extraction`, `paginate_output`, Markdown; no LLM |
| Inference engine | torch on the device | same | vLLM 0.30.0 inside the container (`vllm-async-engine`) | torch on the device | vLLM `vllm/vllm-openai:v0.25.1`, a sibling container Surya starts |
| Device flag | `--device cuda` / `cpu` | same | `--device auto` (MinerU picks vLLM on CUDA) | `TORCH_DEVICE=cuda` / `cpu` | `TORCH_DEVICE=cuda` for Marker's own models |
| Native output kept | `DoclingDocument.export_to_dict()` | same | `ParseResult.to_dict()` (docvortex.middle) | `JSONRenderer` block tree | `JSONRenderer` block tree |

### Variants for better results (added 11 Nov, not in the page tests)

The five parsers above keep the page tests' settings, so the two benchmarks can be compared. Three variants try
settings that should suit Norwegian Kudos PDFs better; each is otherwise identical to its parent.

| Variant | Parent | Change | Why | Hosts |
| --- | --- | --- | --- | --- |
| `docling-tess` | docling | `TesseractCliOcrOptions(lang=["nor"])`, Tesseract from Debian (`tesseract-ocr`, `tesseract-ocr-nor`) | Chosen before this run: Docling's EasyOCR and RapidOCR setups had read scans poorly in earlier tests, and Tesseract has a Norwegian model | all three |
| `docling-rapid` | docling | image `Dockerfile.docling-rapid` = Docling image + `onnxruntime==1.31.1`; OCR options left at default, so Docling's automatic choice is RapidOCR with its default models (`lang ["ch"]`, small) | Docling's own first choice on Linux when onnxruntime is there; whether it reads æøå is unknown. onnxruntime is the CPU build, so RapidOCR runs on the CPU on every host | all three |
| `mineru-noimg` | mineru | `image_analysis=False` | With image analysis on, MinerU writes model-generated descriptions of pictures into the text, which would be indexed as document text | T4, A100 |

Not tried: MinerU tier `advanced` (MinerU's guide: not necessarily better, much more compute, meant for pages
where standard fails), Docling `force_full_page_ocr` (throws away the exact text layer on digital pages, 167 of
the page tests' 227 pages), Docling's VLM pipeline, Marker `force_ocr` or `use_llm`.

### Docling's default OCR: EasyOCR in English here, RapidOCR in the page tests

`docling` passes no OCR options, so Docling uses `OcrAutoOptions`, which takes the first engine that is installed:
ocrmac (macOS), Nemotron OCR (Linux), RapidOCR with onnxruntime, EasyOCR, and last RapidOCR with torch. The image
has none of ocrmac, Nemotron or onnxruntime, and has EasyOCR, so the engine is EasyOCR. `OcrAutoOptions` carries no
languages, and Docling's EasyOCR wrapper then uses English (`_EASYOCR_DEFAULT_LANGUAGE = "en"` in
`docling/models/stages/ocr/easyocr_model.py`). This comes from reading Docling's code; the run's log does not print
the choice. So in these containers the only difference between `docling` and `docling-no` is EasyOCR's language
list. The Mac smoke run (11 Nov) used EasyOCR English as well.

**The earlier page tests' `docling` side (4 Nov) was not this config.** When it ran, the opb venv had no EasyOCR
either (it was installed later that day for `docling-no`), so Docling fell through to its last choice, RapidOCR
with torch: its log has RapidOCR lines, and `docling-rapid` gives byte-identical Markdown on 220 of 221 pages
(found by the Parser session, 11 Nov). EasyOCR English has never been graded. The blocks `docling` is therefore
not that config; `docling-rapid` (RapidOCR with onnxruntime) is the closest match.

### vLLM settings

Neither MinerU's nor Surya's vLLM settings were changed by hand except where Surya's own settings ask for the GPU.

| | mineru on T4 | mineru on A100 | marker2 on T4 | marker2 on A100 |
| --- | --- | --- | --- | --- |
| dtype | float16 (`auto`; the T4 has no bf16) | bfloat16 (`auto`) | float16 (`VLLM_DTYPE`, set by run.sh: compute < 8.0) | bfloat16 (Surya's default) |
| GPU memory reserved | MinerU's default: a 6 GB budget, 0.38 of 16 GB | 6 GB budget with a 0.1 floor: 0.1 of 80 GB = 8 GB | `VLLM_GPU_MEMORY_UTILIZATION` 0.85 (Surya default) ≈ 13.6 GB | 0.85 ≈ 68 GB |
| Batch | MinerU's | MinerU's | `VLLM_GPU_TYPE=t4`: 16 sequences, 4,096 batched tokens | `VLLM_GPU_TYPE=a100-80`: 104 sequences, 16,384 batched tokens |
| Max model length | 8,192 | 8,192 | 24,576 | 24,576 |
| Other | attention TRITON_ATTN (T4) | attention FLASH_ATTN, FlashInfer sampler | MTP speculation auto (2 tokens), prefix caching, max 6,291,456 pixels | same |

`VLLM_GPU_TYPE` is Surya's way to size the server for the card; left at its default (`4090`) it would size for
24 GB. The mineru columns are confirmed by the run logs (dtype, attention, sampler, max model length). The marker2
columns come from the settings and Surya's sizing table: Surya does not log its vLLM command line, and the VMs are
deleted.

**Peak GPU memory for mineru and marker2 is mostly vLLM's reservation, not what the parser needs.** It cannot be
used to rule out a smaller GPU.

## What was changed to make the containers run

Only the environment, in the Dockerfiles and `run.sh`; no parser setting was changed. Each failed run's log is
kept as `.data/runs/<host>/logs/<parser>-failed-<cause>.log`.

| Change | Why | Hit on |
| --- | --- | --- |
| `Dockerfile.marker`, `Dockerfile.marker2`: fetch Marker's font at build time (`marker.util.download_font()`) | Marker downloads a font into site-packages on first load; the container runs as the host user, who can't write there (`PermissionError`) | marker on A100 and T4, marker2 on A100 |
| `Dockerfile.marker`, `Dockerfile.marker2`: install `build-essential` | Triton compiles its launcher with a C compiler at run time (`Failed to find C compiler`); MinerU's image already had it | marker on T4 |
| `Dockerfile.mineru`: install `flashinfer-jit-cache==0.6.18.post1+cu130` from flashinfer.ai | On the A100, vLLM's FlashInfer sampler compiles its kernels on first use: first no `nvcc`, then (with pip's nvcc 13.5 on `CUDA_HOME`) `CUDA compiler and CUDA toolkit headers are incompatible`. The prebuilt kernels for this FlashInfer version and CUDA 13.0 skip the compile. The T4 never used the FlashInfer sampler. | mineru on A100 |
| `run.sh` (marker2 only): mount the Docker socket, add the socket's group, host network, `SURYA_INFERENCE_BACKEND=vllm`, `VLLM_GPU_TYPE` from the GPU name, `VLLM_DTYPE=float16` below compute 8.0, vLLM model cache in `.data/vllm-hf` | Surya starts vLLM as its own container and must reach it | marker2 everywhere |

The T4's MinerU image was built before the FlashInfer change; its run did not need it.

## Results

Every run on the T4 and the A100 converted all 15 documents; so did every Docling run on the CPU host. Marker
1.10.2 on the CPU host was stopped by hand after 5 documents (31 pages): image-only pages took about 350 s each
(8562: 4 pages in 1,389 s), digital pages about 21 s, so the remaining image-only documents would have taken many
hours (`azure-D8as_v6-swedencentral/marker/STOPPED.txt`). Marker 2.1 and MinerU need vLLM on a GPU and did not run
on the CPU host.

### Speed and GPU

| Host | Parser | Docs | s/page (all pages) | s/page (median doc) | Peak GPU GB | Mean GPU use | Failed docs |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| T4 | docling | 15 | 0.61 | 0.59 | 8.6 | 46% | 0 |
| T4 | docling-no | 15 | 0.61 | 0.60 | 7.2 | 48% | 0 |
| T4 | docling-tess | 15 | 1.18 | 1.08 | 1.7 | 10% | 0 |
| T4 | docling-rapid | 15 | 1.26 | 1.14 | 1.8 | 9% | 0 |
| T4 | mineru | 15 | 0.89 | 0.79 | 7.5 | 31% | 0 |
| T4 | mineru-noimg | 15 | 0.89 | 0.79 | 7.7 | 45% | 0 |
| T4 | marker | 15 | 4.15 | 0.94 | 10.0 | 78% | 0 |
| T4 | marker2 | 15 | 2.77 | 2.09 | 15.5 | 45% | 0 |
| A100 | docling | 15 | 0.40 | 0.40 | 11.8 | 27% | 0 |
| A100 | docling-no | 15 | 0.40 | 0.40 | 11.8 | 33% | 0 |
| A100 | docling-tess | 15 | 0.96 | 0.86 | 2.1 | 5% | 0 |
| A100 | docling-rapid | 15 | 0.77 | 0.74 | 2.1 | 7% | 0 |
| A100 | mineru | 15 | 0.45 | 0.45 | 10.9 | 12% | 0 |
| A100 | mineru-noimg | 15 | 0.44 | 0.44 | 10.9 | 16% | 0 |
| A100 | marker | 15 | 1.54 | 0.40 | 9.9 | 56% | 0 |
| A100 | marker2 | 15 | 0.64 | 0.64 | 70.6 | 21% | 0 |
| D8as_v6 (CPU) | docling | 15 | 4.75 | 4.41 |  |  | 0 |
| D8as_v6 (CPU) | docling-no | 15 | 4.80 | 4.43 |  |  | 0 |
| D8as_v6 (CPU) | docling-tess | 15 | 1.61 | 1.22 |  |  | 0 |
| D8as_v6 (CPU) | docling-rapid | 15 | 2.02 | 2.12 |  |  | 0 |
| D8as_v6 (CPU) | marker | 5 | 62.59 | 20.99 |  |  | 0 |

- **One document at a time, one parser per VM.** These are single-stream numbers. The GPUs were mostly idle
  (5–78% mean use), so a service running several documents at once would get more pages per VM-hour than this.
- **Peak GPU** for mineru and marker2 is mostly vLLM's up-front reservation (see vLLM settings), not need.
  `gpu.csv` is sampled from container start, so mean use includes model loading.
- **All pages against median document:** Marker 1.10.2's time goes to the image-only scans. On the T4, 3 of 15
  documents take 75% of its time (102474 and 75814, both with image-only pages, and 372605); on the A100 71%.
  The other parsers spread more evenly.
- **CPU:** Docling with Tesseract (1.61 s/page) or RapidOCR (2.02) is about 3× faster than with EasyOCR (4.75),
  which is slow without a GPU. On the GPUs it is the other way round: EasyOCR runs on the GPU, Tesseract and
  RapidOCR (onnxruntime CPU build) on the CPU.
- **mineru-noimg** is the same speed as mineru (and gives the same output, see below).

### Cost per 1,000 pages and projections

**These are projections**, not measurements: list price (Linux, pay-as-you-go, without the disk) × the measured
seconds per page above, assuming the whole corpus behaves like these 15 documents and runs one document at a time.
Phase 1 = 646,558 pages, all of KUDOS = 3,141,333 pages (KUDOS listing of 21 Oct 2026).

| Host | Parser | $ per 1,000 pages | Phase 1 (646,558 p): $ / VM-hours | All KUDOS (3,141,333 p): $ / VM-hours |
| --- | --- | ---: | ---: | ---: |
| T4 | docling | 0.104 | 67 / 109 | 325 / 529 |
| T4 | docling-no | 0.105 | 68 / 110 | 330 / 536 |
| T4 | docling-tess | 0.201 | 130 / 212 | 632 / 1,028 |
| T4 | docling-rapid | 0.216 | 139 / 227 | 677 / 1,102 |
| T4 | mineru | 0.151 | 98 / 159 | 476 / 774 |
| T4 | mineru-noimg | 0.152 | 98 / 159 | 476 / 774 |
| T4 | marker | 0.708 | 458 / 745 | 2,225 / 3,618 |
| T4 | marker2 | 0.474 | 306 / 498 | 1,489 / 2,421 |
| A100 | docling | 0.532 | 344 / 72 | 1,672 / 350 |
| A100 | docling-no | 0.536 | 347 / 73 | 1,684 / 353 |
| A100 | docling-tess | 1.278 | 826 / 173 | 4,015 / 841 |
| A100 | docling-rapid | 1.023 | 662 / 139 | 3,215 / 673 |
| A100 | mineru | 0.595 | 385 / 81 | 1,869 / 391 |
| A100 | mineru-noimg | 0.589 | 381 / 80 | 1,850 / 387 |
| A100 | marker | 2.038 | 1,318 / 276 | 6,403 / 1,341 |
| A100 | marker2 | 0.853 | 551 / 115 | 2,679 / 561 |
| D8as_v6 (CPU) | docling | 0.512 | 331 / 854 | 1,609 / 4,148 |
| D8as_v6 (CPU) | docling-no | 0.518 | 335 / 863 | 1,627 / 4,192 |
| D8as_v6 (CPU) | docling-tess | 0.173 | 112 / 289 | 544 / 1,403 |
| D8as_v6 (CPU) | docling-rapid | 0.218 | 141 / 363 | 683 / 1,762 |
| D8as_v6 (CPU) | marker | 6.746 | 4,361 / 11,241 | 21,190 / 54,613 |

What moves these numbers most:
- **The share of image-only pages.** 9 of the 15 documents have scanned pages, 5 of them image-only pages: they
  were picked to include scans (`documents.json`), not drawn at random, and the share in all of KUDOS is not
  measured here. Marker's time is mostly those pages, so its projection moves most with that share; Docling's and
  MinerU's move less.
- **Running documents in parallel** on one GPU would lower every GPU figure; this benchmark did not measure it.
- The CPU Marker row is from 5 documents only, one of them image-only.

### Structure

All hosts give the same structure for the same parser (the T4 is shown; `structure-all-hosts.md` has every
document; each host's `structure.md` is in its folder).

| Parser | Documents | Blocks | Characters | Headings | Heading levels | List items | Tables | Furniture | Empty | æøå per 1,000 letters |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| docling | 15 | 4282 | 789942 | 659 | [1] | 464 | 92 | 976 | 10 | 16.1 (median) |
| docling-no | 15 | 4277 | 789214 | 660 | [1] | 456 | 92 | 976 | 10 | 19.8 (median) |
| docling-rapid | 15 | 4311 | 796120 | 661 | [1] | 477 | 92 | 987 | 10 | 19.7 (median) |
| docling-tess | 15 | 4315 | 801838 | 662 | [1] | 477 | 92 | 971 | 10 | 20.0 (median) |
| marker | 15 | 4209 | 756375 | 671 | [1, 2, 3, 4] | 383 | 116 | 753 | 67 | 20.0 (median) |
| marker2 | 15 | 4148 | 757127 | 708 | [1, 2, 3, 4, 5] | 206 | 157 | 1048 | 61 | 20.1 (median) |
| mineru | 15 | 4278 | 762161 | 627 | [2] | 0 | 122 | 915 | 0 | 20.0 (median) |
| mineru-noimg | 15 | 4278 | 762161 | 627 | [2] | 0 | 122 | 915 | 0 | 20.0 (median) |

- **Heading levels:** every Docling config gives every heading level 1, MinerU level 2 (plus 50 `title` blocks),
  Marker 1.10.2 levels 1–4, Marker 2.1 levels 1–5. Only the two Markers give a heading path deeper than one
  heading.
- **Lists:** MinerU gives no list items in any document; it writes lists as paragraphs (82 paragraphs start
  with "- "). Marker 2.1 finds about half as many list items as Marker 1.10.2 (206 against 383).
- **Tables:** Marker 2.1 finds the most (157); it could not read 4 of the 99 tables in 102474 on both GPUs, in
  float16 (T4) and bfloat16 (A100), so that is the model, not the T4.
- **Furniture** (page headers, footers, page numbers, kept out of `text.md`): every parser marks some; Marker 2.1
  the most (1,048 blocks), Marker 1.10.2 the fewest (753).
- **Text inside pictures:** Docling puts 24,680 characters into figure blocks (text it reads inside pictures),
  MinerU about 4,700, Marker about 3,300. That text reaches chunks unless figures are left out.
- **mineru-noimg** gives the same blocks as mineru: 13 of 15 documents byte-identical, 2 with one short string
  different. MinerU finds 151 pictures here, and no model-written description reached the output with image
  analysis on. Untested on documents with charts.

### Heading quality against the PDFs' own outlines

The counts above say how many headings and levels each parser gives, not whether they are right. 6 of the 15
PDFs carry an outline (bookmarks: 197 headings, levels 1–3: 51, 79, 67), made by whoever exported the document, so
it is a reference for headings (two of the 6, 31196 and 46870, also have scanned pages). `headings_vs_outline.py` matches
each outline entry to a parser heading on the same or the next page (text normalised, section numbers dropped,
difflib ratio ≥ 0.85), then compares levels. Full tables per host: `headings-vs-outline.md`. A100 shown:

| Parser | Outline headings found | Level changes followed | Same-level steps kept | All nesting steps right |
| --- | ---: | ---: | ---: | ---: |
| docling (every config) | 194 / 197 (98%) | 0 / 75 (0%) | 113 / 113 (100%) | 113 / 188 (60%) |
| mineru | 191 / 197 (97%) | 30 / 76 (39%) | 103 / 109 (94%) | 133 / 185 (72%) |
| marker | 195 / 197 (99%) | 36 / 75 (48%) | 83 / 114 (73%) | 119 / 189 (63%) |
| marker2 | 194 / 197 (98%) | 43 / 76 (57%) | 90 / 112 (80%) | 133 / 188 (71%) |

- **Every parser finds the headings** (97–99% of the outline). About a third of each parser's headings are not
  in the outline; the outline stops at level 3, so many of those are real smaller headings.
- **None gets the nesting right reliably.** "Level changes followed": where the outline goes a level deeper or
  back up from one heading to the next, does the parser go the same way? Docling never does (everything is level
  1), MinerU only between its title and the rest, Marker 1.10.2 about half the time, Marker 2.1 about 6 in 10.
  A flat parser still gets 60% of all steps right, because most steps stay at the same level; that is why the
  last column flatters Docling.
- On the T4, Marker 1.10.2 and 2.1 give slightly different headings from the A100 (marker 49%, marker2 61% of
  level changes): the GPUs do not give byte-identical output.
- 6 documents and 197 headings: exploratory, no intervals.

### Quality: page tests on today's outputs

Only this run's outputs count, the reference included: the reference is **this run's Marker 1.10.2 on the A100**
(all 15 documents). Graded by the Parser session with the opb scorer on the page tests that fall inside these
documents: 287 tests on 33 pages (one sampled page has no tests), each page cut out of the whole-document output.
Method and every side: `page-tests-azure.md`. Exploratory: 33 pages from 15 documents.

| Side (today's run) | All tests | Text | Tables† | Digital | Scan + text† | Image-only† | All − reference |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Marker 1.10.2, A100 (reference) | 87.5 | 89.1 | 72.4 | 88.9 | 79.2 | 90.2 | |
| Marker 1.10.2, T4 | 87.1 | 89.5 | 65.5 | 88.9 | 79.2 | 87.8 | −0.3 (−2.1 to +1.0) |
| Docling + Tesseract Norwegian, every host | 92.7 | 95.7 | 65.5 | 92.4 | 100.0 | 85.4 | +5.2 (−1.1 to +13.3); text **+6.6 (+1.2 to +14.6)** |
| Docling + RapidOCR, every host | 89.5 | 92.2 | 65.5 | 90.4 | 93.8 | 80.5 | +2.1 |
| Docling + EasyOCR Norwegian, every host | 89.5 | 92.2 | 65.5 | 91.9 | 89.6 | 78.0 | +2.1 |
| Docling + EasyOCR English, every host | 85.7 | 88.0 | 65.5 | 90.4 | 87.5 | 61.0 | −1.7 (−11.6 to +8.4) |
| MinerU (vLLM), A100 = T4 | 91.3 | 95.3 | 55.2 | 92.9 | 87.5 | 87.8 | +3.8 (−4.8 to +13.4) |
| Marker 2.1 (vLLM), A100 | 87.8 | 92.6 | 44.8 | 87.9 | 87.5 | 87.8 | +0.3 (−6.8 to +7.5) |

Tests per slice: text 258 (15 documents), tables 29 (8), digital 198 (11), scan with a text layer 48 (5),
image-only 41 (4). † fewer than 10 documents: point differences are hints only, the intervals cannot be trusted.

- **On all tests no side is clearly ahead of or behind the reference.** The one significant difference is Docling
  with Tesseract on text: +6.6.
- **The reference is best on tables** (72.4 against 65.5 for every Docling setup, 55.2 MinerU, 44.8 Marker 2.1) and
  **on image-only pages** (90.2 against 85.4 for Docling with Tesseract). Both are hints (8 and 4 documents).
- **Docling's OCR matters on image-only pages:** Tesseract 85.4, RapidOCR 80.5, EasyOCR Norwegian 78.0, EasyOCR
  English 61.0 (the container default).
- **Hosts do not change the result.** Docling is identical on CPU, T4 and A100; MinerU identical on T4 and A100;
  Marker 2.1 differs on 1 test and Marker 1.10.2 on 5 between T4 and A100. The T4's float16 costs nothing
  measurable.
- **mineru-noimg** gives the same result as mineru on every test and can be dropped.
- Earlier page-test runs (the Kudos pilot's Marker conversions, the Mac sides in `../opb`) are not used here.

### The smoke run's findings, across all 15 documents

Checked by counts on the T4 and A100 blocks (the same on both); no document text quoted.

| Smoke run (3 documents, Mac) | All 15 documents |
| --- | --- |
| Docling's default OCR drops æ, ø and å on scans | Holds: about 0 per 1,000 letters on 4 of the 9 documents with scanned pages (EasyOCR English). `docling-no`, `docling-tess` and `docling-rapid` keep them (about 21–22, as Marker and MinerU). One scanned document has about 0 for every parser. |
| Docling: every heading level 1; Marker levels 1–4 | Holds (Marker 2.1: 1–5; MinerU: 2). |
| MinerU merged a heading into the paragraph under it | Likely more than once, not proven: MinerU has 40 long paragraphs that start with a section number, in 12 documents, against 3–11 for the others; some may be numbered list items, which MinerU also writes as paragraphs. |
| MinerU read a footer with a person's name and phone number as body text | Not specific to MinerU: every parser has 4–7 phone-style numbers (`dd dd dd dd`) in body paragraphs, in 4–6 documents. Counts cannot tell a footer from a real contact section. Marker never marks one as a footer; Docling and MinerU sometimes do. |

## What the run cost

From the activity log (VM created to VM deleted) at list prices; the subscription's billed amount (Enterprise
Agreement) shows in Cost Management a day or so later and may differ.

| VM | Running (UTC) | Hours | VM $ | Disk + IP $ |
| --- | --- | ---: | ---: | ---: |
| T4, France Central | 07:50–10:48 | 2.97 | 1.83 | 0.20 |
| A100, Sweden Central | 08:17–10:19 | 2.04 | 9.73 | 0.13 |
| D8as_v6, Sweden Central | 08:53–11:44 | 2.85 | 1.11 | 0.18 |
| **Total** | | | **12.67** | **0.51** |

About **$13.20** in all. The West Europe attempts never got a VM (no capacity), so they cost nothing. Everything is
deleted: resource group `genki-parser-bench` no longer exists, and nothing tagged `purpose=genki-parser-benchmark`
is left in the subscription. The approved quota (T4 16 vCPUs in West Europe and France Central, A100 24 in Sweden
Central) stays and costs nothing.
