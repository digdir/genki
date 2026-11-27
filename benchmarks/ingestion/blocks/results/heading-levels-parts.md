# Heading levels of `docling-parts` 2 against PDF outlines (issue 516)

How well the TypeScript port (`doclingParts(document, { layout, outline: false })` with `readPdfLayout`) levels
Docling's headings, 27 Nov 2026. The PDF's outline (bookmarks) is the reference. The outline rung is off, so the
score is what section numbers and text size alone give. The bar is 89 %, the prototype's result on 14 Nov
([issue 516 comment](https://github.com/digdir/genki/issues/516#issuecomment-6873132902)).

The measure is "level changes followed": take the outline entries matched to a Docling heading, in order. Wherever
the reference level changes from one entry to the next, the port must move the same way (deeper or shallower).

## Result

On the held-out sample (600 PDFs, scored once after the rules were frozen), the port follows **88 %** of the
level changes (2,889 / 3,274), **under the 89 % bar**. The prototype on the same files gets 83 %. On the dev
sample the rules were tuned on, the port went from 87 % to 91 %.

On the grilling page for issue 516 (27 Nov 2026) this was accepted as passing: the 89 % was the prototype on another
sample, and on these 600 files the port is 4.8 points above the prototype.

| Held-out, seed 517 | Level changes followed | Numbered documents | Unnumbered documents | Same-level steps kept |
| --- | ---: | ---: | ---: | ---: |
| Port, text size | **2,889 / 3,274 (88.2 %)** | 2,349 / 2,576 (91.2 %), 164 docs | 540 / 698 (77.4 %), 117 docs | 4,892 / 5,094 (96 %) |
| Prototype, text size | 2,731 / 3,274 (83.4 %) | 2,191 / 2,576 (85.1 %) | 540 / 698 (77.4 %) | 4,905 / 5,094 (96 %) |
| Port, box height only | 2,664 / 3,274 (81.4 %) | 2,313 / 2,576 (89.8 %) | 351 / 698 (50.3 %) | 4,685 / 5,094 (92 %) |
| Prototype, box height only | 2,527 / 3,274 (77.2 %) | 2,172 / 2,576 (84.3 %) | 355 / 698 (50.9 %) | 4,705 / 5,094 (92 %) |
| Docling as is (every heading level 1) | 0 / 3,274 (0 %) | 0 % | 0 % | 100 % |

- 281 of the 600 PDFs have an outline: 10,721 entries and 3,274 level changes. 83 more entries have no page index and are skipped.
- 8,622 entries (80 %) match a Docling heading. Only matched entries are scored.
- 13 PDFs have no text layer.
- The port does better than the prototype in 28 documents (+171 level changes) and worse in 5 (−13).
- The gap between the two is almost all in numbered documents: 91 % for the port against 85 % for the prototype.
- Unnumbered documents score the same as the prototype (77 %) and are what keeps the total under the bar.

### Compared with the earlier runs

| | 14 Nov prototype (old sample, 299) | Dev, port before | Dev, port after | Held-out, port after |
| --- | ---: | ---: | ---: | ---: |
| Documents with an outline | 170 | 156 | 156 | 281 |
| Level changes | 1,753 | 1,825 | 1,825 | 3,274 |
| Followed | 89 % | 86.5 % | 90.7 % | **88.2 %** |
| Numbered / unnumbered | 92 % / 78 % | 88.0 % / 81.2 % | 93.1 % / 82.2 % | 91.2 % / 77.4 % |
| Box height only | 81 % | 79.7 % | 83.1 % | 81.4 % |

## Rules added (dev sample)

All of them are in `packages/ingest/src/heading-levels.ts`, for `docling-parts` 2 only. The walk's `numberDepth`
and `docling-pages` 1 are unchanged. Each step below adds one rule to the one before. Dev = 299 PDFs, 156 with an
outline, 1,825 level changes.

| Step | Rule | Test | Followed | Numbered | Unnumbered | Box height only |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 0 | Port as on 27 Nov, first run | – | 1,579 (86.5 %) | 88.0 % | 81.2 % | 1,455 (79.7 %) |
| 1 | In a numbered document, `Kapittel`/`Kap.`/`Chapter`/`Del`/`Part` with a number, roman numeral or number word (Norwegian, English) is depth 1. It does not count towards the 30 % numbered share. | `in a numbered document, a chapter word with a number is level 1`; `a chapter word does not count as a section number towards the numbered share` | 1,605 (87.9 %) | 89.8 % | 81.2 % | 1,484 |
| 2 | Trailing zero parts do not count: `2.0` is depth 1, `2.1.0` depth 2 | `a section number ending in zero parts counts without them, so «2.0» is depth 1` | 1,618 (88.7 %) | 90.7 % | 81.2 % | 1,491 |
| 3 | In a numbered document, an unnumbered heading smaller than the deepest numbered level's median by more than 0.5 pt is one level below it | `in a numbered document, an unnumbered heading smaller than the deepest numbered level goes one below it` | 1,631 (89.4 %) | 91.6 % | 81.2 % | 1,500 |
| 4 | A section number with a space around its dots counts every part: `3 .1. 1`, `4 . 4 . 2` is depth 3 | `a section number with spaces around its dots counts every part` | 1,640 (89.9 %) | 92.2 % | 81.2 % | 1,509 |
| 5 | In a numbered document with a `Del`/`Part` heading, parts are level 1 and every other depth (numbers, `Kapittel`) goes one down | `in a numbered document with parts, «Del II» is level 1 and the numbered chapters go one level down` | 1,652 (90.5 %) | 93.1 % | 81.2 % | 1,522 |
| 6 | Without section numbers, a chapter or part word with a number is level 1, and the other headings rank by size from level 2 | `without section numbers, a chapter word with a number is level 1 and the other headings rank below it` | **1,656 (90.7 %)** | 93.1 % | 82.2 % | 1,516 (83.1 %) |

A further test, `reads section numbers and chapter words in linear time on long adversarial headings`, holds the
new patterns to linear time. All regular expressions are anchored, with bounded or disjoint quantifiers.

Contribution of each rule alone, on top of step 0: rule 1 +26, rule 2 +10, rule 3 +13 (+7 with a 1 pt gap
instead of 0.5), rule 4 +9, rule 5 +12 (+3 without rule 4), rule 6 +4. Rules 3 to 6 each come mostly from 1 to 4
dev documents.

Tried on dev and not kept:

- **All capitals count as bigger.** Bonuses of +0.4, +1 and +2 pt were tried. Each gave fewer level changes followed (1,646, 1,648 and 1,641, against 1,652).
- **One level below the numbered heading before it, when smaller.** This was tried in place of rule 3 and gave 1,616 against 1,618.
- **One level below the deepest numbered level, when the same size and right after a heading of that level.** This gave +18 on dev, 16 of them in one document. It was dropped because it contradicts the existing test `in a numbered document, an unnumbered heading takes the numbered level nearest its size`.

## Misses left on the held-out sample

There are 385 misses in 89 documents, and the 10 worst documents hold 161 of them. Below they are sorted roughly
by the text of the two headings in the step that was missed.

| Cause | Misses | Documents | Example (sha prefix: reference → got) |
| --- | ---: | ---: | --- |
| Unnumbered heading in a numbered document, levelled by size | 157 | 46 | `08a8d3f597`: `2.2.4 Faktorer …` 3 → 3, then `Gebyr / straff` 4 → 3 (same size as level 3) |
| Unnumbered document, size ranks off the outline | 108 | 24 | `0fcccd9ff4`: `SANITATION` 4, `Findings:` 5, `PROGRAMME MANAGEMENT` 3: all 4 |
| Appendix, `Vedlegg`, `Annex`, `Note` headings | 69 | 31 | `0ba06063e5`: `APPENDIX 1: QUESTIONS GUIDE …` 1 → 1, then `Political Decision Making` 2 → 1 |
| Both numbered, the numbers disagree with the outline | 30 | 12 | `14b26b4883`: `5 Riksrevisjonens sluttmerknad` 2, then `1 Innledning` 4 (a second report starts) |
| Letter prefixes `A)`, `B)` | 15 | 1 | `878557775f`: `A) NASJONALE STYRINGSPARAMETERE` 7 → 3, then `1.1 Andel …` 8 → 3 |
| Roman numeral prefixes `II.`, `IV.` | 6 | 2 | `5d05c5e503`: `IV. Styring og kontroll` 1 → 4 |

- **Compilations.** The worst document, `28df8cf059` (36 misses), joins several evaluation reports. Each report restarts at `1 Introduction`, and the outline puts each report's title above its chapters. Numbers alone cannot see that.
- **Rule 6 hurts in one held-out document.** In `5d05c5e503` (an annual report, 10 misses against the prototype's 2), budget references `KAP. 275 POST 21` and a table heading `DEL I` count as chapter words. Every other heading is then pushed one rank down and capped at level 4, so levels 3 and 4 collapse into one.

### Suggested next fixes (not made; the rules were frozen before the held-out run)

- In rule 6, allow one more level when chapter words push the ranks down (cap at 5, not 4). Count a chapter word only when the token after it ends the heading or is followed by `:`, `.`, `-` or a title, not by `POST`.
- Roman numeral prefixes (`II.`, `IV.`) and letter prefixes (`A)`) as a level above the numbered chapters. This is the same idea as `Del`/`Part`.
- `Vedlegg`/`Appendix`/`Annex`/`Bilag` with a number as level 1.
- Restarted numbering (`1 Introduction` after `11 Conclusion`) as the start of a new part, with the unnumbered heading before it as its level-1 title.
- Before adding these, measure on a new held-out sample. This one has been seen.

## Timing of `readPdfLayout`

Each sample was timed in its own run, one document after another in Node on a Mac laptop, with nothing else
running.

| | Dev (299) | Held-out (600) |
| --- | ---: | ---: |
| Median per document | 355 ms | 393 ms |
| p95 | 2.1 s | 2.0 s |
| Max | 3.6 s (`79385cc8d4`: 108 pages, 26.7 MB) | 7.8 s (`8edcc87d4a`: 36 pages, 22.8 MB) |
| Per page, median / p95 | 9.9 / 67 ms | 10.4 / 37 ms |
| Pages, median / max / total | 39 / 150 / 14,370 | 40 / 150 / 28,995 |
| All documents | 184 s | 387 s |

## Samples

Both samples are in `heading-levels-sample.json`, under `dev` and `heldout`. Both are unique primary Kudos PDFs:

- taken from the KUDOS listing of 21 Oct 2026 (`benchmarks/ingestion/.data/kudos-listing.jsonl` in the main checkout);
- with Docling output in the 11 Nov Kudos Docling export (`~/kudos-docling/json/docling`);
- at most 150 pages by `done.json`;
- drawn by sorting the candidates by sha256, shuffling them with Python `random.Random(seed)` and keeping the first N.

| Sample | Seed | Files | Size | Excludes |
| --- | ---: | ---: | ---: | --- |
| Dev | 516 | 299 | 717 MB | the 39 sha256s of `documents.json` and `documents-run2.json` (the prototype's tuning set) |
| Held-out | 517 | 600 | 1.34 GB | those 39 and the 299 dev files |

- The held-out sample was drawn and fetched while the rules were still being tuned, and scored only after they were frozen. The file's sha1 was checked before scoring.
- Every PDF was fetched from its KUDOS `pdf_url`, which is public and needs no credentials. All of them matched their sha256.
- The PDFs were deleted after scoring.

## Method

1. `heading_levels_parts.ts` does the following for each document:
   - reads `docling.json` and the PDF and runs `readPdfLayout`;
   - runs `doclingParts(document, { layout, outline: false })`;
   - writes the body layer's title and section-header parts as blocks.jsonl: page = the first region's unit, bbox = its box, and the level;
   - writes the box-height variant by passing `{ outline, runs: [] }`.

   With a fourth argument it keeps each layout (outline and text sizes, no text), so rules can be tried again
   without reading the PDFs.
2. The prototype is run as follows:
   - `normalise.py` on the same `docling.json` files;
   - then `heading_levels.py --mode number-size`;
   - for box height only, the same with its `text_size` replaced by the box height.
3. `heading_levels_score.py` scores every variant:
   - It uses `headings_vs_outline.py`'s matching and its "Level changes followed".
   - It splits by document. A document counts as numbered when at least 30 % of its section headers carry a section number, as `heading_levels.py` reads one.
   - It skips outline entries with no page index, where `headings_vs_outline.py` stops with a TypeError. On the PDFs without such entries, the two scripts give the same counts.

```sh
npx tsx --conditions=source benchmarks/ingestion/blocks/heading_levels_parts.ts ~/kudos-docling/json/docling <pdfs> <run> [<layout cache>]
<python with pypdfium2> benchmarks/ingestion/blocks/heading_levels_score.py <pdfs> <run> parts parts-box
```

## First run (before the rules)

The first run, on the dev sample with the port as it was, gave 86.5 % against the prototype's 86.4 %
(1,577 / 1,825). The two gave the same level to 97 % of the section headers they share (19,962 / 20,626). Where
they differed, it was the size read from pdf.js text runs instead of pdfium characters, and bold from the font
name instead of the font weight.
