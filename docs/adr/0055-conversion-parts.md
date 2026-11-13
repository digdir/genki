# 0055 Conversion parts

Status: proposed, 2026-11-13

Left: drawing a cited box on the page image, printed page labels in roman numerals, heading levels from a PDF's outline, a check of reading order, and parts for web pages, Markdown and Word files. How an answer quotes the words it rests on is recorded in ADR 0052 when it is built (below).

## Context

A stored conversion (ADR 0042) holds per-page Markdown. The converter's native output in Blob storage holds what Markdown loses: each item's kind, its box on each page, and whether it is a page header or footer. Nothing reads that output after the page derivation. So a chunker can only cut on Markdown syntax, a table or a paragraph that crosses a page can be cut, and a citation points at a whole excerpt (ADR 0052) with no position inside it.

## Decision

### The part

- **A conversion part is one piece of a stored conversion, in reading order:** a heading, paragraph, list item, table, picture, caption, footnote or piece of furniture. Every converter's parts have the same fields:

  | Field          | Holds                                                                                                                                                                                               |
  | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `seq`          | Reading order from 0, unique in the conversion                                                                                                                                                      |
  | `kind`         | DocLayNet's labels in Docling's spelling: `title`, `section_header`, `text`, `list_item`, `table`, `picture`, `caption`, `footnote`, `formula`, `code`, `page_header`, `page_footer`, `page_number` |
  | `layer`        | `body`, `furniture`, `notes` or `background`                                                                                                                                                        |
  | `level`        | A heading's level, else null                                                                                                                                                                        |
  | `heading_path` | The texts of the headings above the part, outermost first                                                                                                                                           |
  | `text`         | Plain text; a table as a Markdown table                                                                                                                                                             |
  | `html`         | Tables only: built from the converter's cells, with `colspan`, `rowspan` and header cells                                                                                                           |
  | `start`, `end` | The part's span in the conversion's text; null for furniture                                                                                                                                        |
  | `regions`      | One per page the part covers: the page, a box `[x0, y0, x1, y1]` as fractions of the page from the top left, and the span on that page                                                              |
  | `native`       | Where the part came from in the native output, such as Docling's `self_ref` (`#/texts/41`)                                                                                                          |

- **The conversion's text is the `text` of its body parts in `seq` order, joined by a blank line.** It is not stored: it is rebuilt from the parts.
- **Offsets count Unicode code points over NFC-normalised text,** from 0, end exclusive, as the W3C Web Annotation `TextPositionSelector` does. TypeScript reads them through one helper, never with `String.prototype.slice`, which counts UTF-16 units.
- **A part that crosses a page is one part, with a region on each page.**
- **Only body parts are chunked or cited.** Furniture (page headers and footers, page numbers) is kept so that it can be drawn. Its layer comes from the converter: Docling's `content_layer`. Text inside a picture follows `docling-pages` (ADR 0042): it counts only on a page with no other text.

### Derivations

- **`docling-parts` 1** is made from a `DoclingDocument` in Blob storage, with no download and no converter call. It computes the offsets itself while it joins the text, and does not use Docling's per-item `charspan`.
- **`text-layer-parts` 1** is made from a stored `text-layer` 1 conversion: one `text` part per page, its region the whole page. A file gets real parts once Docling replaces its text layer.
- Both are derivations as ADR 0042 defines them: stored beside `docling-pages` 1 and `text-layer` 1, chosen by the generation's recipe, and removed by `knowledge.cleanup` once no record or kept generation uses them.

### Pages and storage

- **A stored conversion gets a number,** `src_conversions.id bigserial unique`, and its parts are stored one row per page:

  ```sql
  create table src_conversion_pages (
    conversion bigint not null references src_conversions (id) on delete cascade,
    page       integer not null,  -- physical page, from 1
    label      text,              -- printed page number, when kept
    width      real not null,     -- points
    height     real not null,
    text_start integer,           -- the span of the conversion's text that this row's parts cover
    text_end   integer,
    seq_from   integer not null,  -- the parts that start on this page
    seq_to     integer not null,
    parts      jsonb not null,    -- those parts, in seq order
    primary key (conversion, page)
  );
  ```

- **A part is stored in the row of the page where it starts.** The row's `text_start` and `text_end` cover its parts' text, so an offset finds its part's row, and the page to cite comes from that part's region. A read of pages p − 1 to p + 1 reads rows from p − 2, so that a part spilling into p − 1 is not missed.
- **The printed page label** is a number in a furniture part of the page, such as `12`, `s. 12` or `side 3 av 9`, kept only when the nearest labelled page within 2 pages has the same offset from the physical page number. A page without one is cited by its physical number.
- **Deleting a stored conversion deletes its pages** through the cascade, so cleanup and withdrawal (ADR 0042) need no rule of their own.

### Chunks and reads

- **A chunker is a function from body parts to chunks,** named in the generation's recipe. `parts-page` makes one chunk per page, split at the recipe's size limit on part boundaries. `parts-section` starts a chunk at each `section_header` and takes parts up to the size limit; it never splits a table, and a table keeps its caption. A table over the limit is a chunk of its own, embedded by its start (ADR 0042).
- **A chunk made from parts records them.** `kn_chunks` gains `conversion`, `seq_from`, `seq_to`, `text_start` and `text_end`, and a chunk's text is its span of the conversion's text. `page_from`, `page_to` and `heading_path` come from its parts. The chunk id stays as ADR 0042 has it.
- **`kn_parts(dataset, generation, chunk_id, read, n)` returns the parts around a hit:** `neighbours` (`seq` from the chunk's first minus n to its last plus n), `section` (from the nearest `section_header` at or before the hit to the next one) or `pages` (parts with a region on the pages before and after), each under a character budget. It is a `SECURITY DEFINER` read function like the others (ADR 0042): it refuses a dataset outside `app.datasets`, starts from the chunk row in the dataset's own partition, and never takes a sha256 or a conversion id from its caller, so no caller can learn whether another organisation holds a file.
- **Search never reads the parts.** It reads chunks and search phrases, which have the vector and full-text indexes. A search over headings or tables only is a recipe that writes them as chunks or search phrases when a file is indexed.

### Citations

- **A part's offsets let a citation name the exact words it rests on,** with their page and box. ADR 0052 records how an answer carries such a quote when it is built: the model writes the words after the marker, the API keeps them only if they are in the excerpt word for word, sends the answer with plain `[N]`, and returns the quote and its W3C Web Annotation selectors (`TextQuoteSelector`, `TextPositionSelector`, and the page as a `FragmentSelector`) in `markers`. A quote that is not found leaves an excerpt citation, and the miss is counted.

## Measured

On the Docling export seeded into stored conversions (Docling 2.123.1), 13 November 2026, with the scripts and results in [`benchmarks/ingestion/blocks/parts/`](../../benchmarks/ingestion/blocks/parts/):

| Measure                                     | Value                                                                                   | Sample                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Parts a page                                | 10.9 and 11.3                                                                           | Two samples of 200 files, 11,175 and 12,178 pages |
| Parts that cross a page                     | 1.6 %                                                                                   | same                                              |
| Parts marked furniture                      | 15.0 and 17.4 %                                                                         | same                                              |
| Pages with a character outside the BMP      | 0.05 and 0.16 %                                                                         | same                                              |
| Tables with merged cells                    | 26 %                                                                                    | same                                              |
| Pages with a printed label kept by the rule | 70.5 and 66.2 %                                                                         | same                                              |
| Pages with a running title left in the body | 4.8 and 7.3 %                                                                           | same                                              |
| Stored, one row per page (pglz)             | 2,872 bytes a page: 7.3 GB for 2.55 million pages                                       | 300 files, 18,199 pages, PostgreSQL 17            |
| Stored, one row per part (pglz)             | 6,238 bytes a page: 15.9 GB                                                             | same                                              |
| Reads, one row per page (medians)           | one page 0.18 ms, `seq` ± 5 0.22 ms, pages ± 1 0.27 ms, all body parts of a file 3.5 ms | same                                              |

## Why

- **Parts, not per-page Markdown.** Markdown keeps the words and loses the page, the box, the kind and the furniture. Without them a chunk cannot be cited to a place, a table cannot be kept whole, and a rechunk can split only on Markdown syntax.
- **One shape for every converter.** The converter can change, per file or for good, without touching chunkers, reads or citations. Turned down: reading each converter's native output directly, which gives every reader a path per converter.
- **Offsets into one text, computed while it is joined.** A citation then names an exact span whatever the recipe, since a chunk is a span of the same text. Finding offsets afterwards with a text search goes wrong where the same text appears twice, and Docling's `charspan` counts within one item only.
- **Code points, not UTF-16 units.** They match W3C Web Annotation, PostgreSQL's `substr` and Python, so stored selectors are standard and need no conversion. The two differ only after a character outside the BMP, which 0.05 to 0.16 % of the sampled pages hold, so a slip would rarely show: hence one helper and a test for it.
- **One row per page, not one row per part.** The planned reads (a citation, the parts around a hit, a rechunk, a withdrawal) are per document and take a few ms either way. One row per part takes 2.2 times the space (15.9 against 7.3 GB for the seed) and about 26 million rows instead of 2.55 million, because most part values are too short to compress. It is faster only for SQL over all parts of a dataset, such as counting kinds across Kudos (about 3.8 against 24 seconds at 2.55 million pages), which no planned read does.
- **One part with a region per page.** A paragraph or table that crosses a page comes back whole, and still cites to each page. Splitting at the page break would cut a sentence in two.
- **Boxes as page fractions from the top left.** Docling gives points from the bottom left; fractions from the top left draw on a rendering of any size.
- **Labels only when a neighbouring page agrees.** Of the labels found, 1.4 to 2.4 % disagree with the nearest labelled page: chapter numbers in page headers, years, and lone numbers. A citation with a wrong printed page sends the reader to the wrong page; one with no label falls back to the physical page.
- **Docling's layers, no rule of our own.** Docling marks 15 to 17 % of parts as furniture. A rule that turns text repeated in the same band of 3 or more pages into furniture would catch running titles left in the body on 4.8 to 7.3 % of pages, and also repeated legend text on drawings, while catching none of the contact lines in the bottom band of letters (0 of 91 and 0 of 106), which rarely repeat. Turned down until the retrieval checks show that the missed running titles hurt.
- **HTML for tables.** 26 % of tables have merged cells, which a Markdown table can only repeat. The HTML is built from the converter's cells; building it from the Markdown grid would lose the merges again.

## Consequences

- Not built. It is built in four steps, each an issue of its own, after Kudos is the active dataset on the knowledge database (issue 475): derive parts (a TypeScript derivation, `src_conversion_pages`, parts derived from Blob storage when an index job needs them); chunk from parts (`parts-page`, `parts-section`, the chunk columns, candidates ranked by the checks of issue 147); `kn_parts`; and quotes, with ADR 0052 amended.
- ADR 0042 changes with it: What is stored, Conversion, Identity and chunks, and its list of read functions.
- `benchmarks/ingestion/blocks/normalise.py` (format `genki.blocks/1`) is where the derivation starts, not its format: it gives each block one page and box, offsets into Markdown instead of plain text, a furniture flag instead of a layer, and table HTML from the repeated grid.
- The knowledge server holds about 7.3 GB more for the seeded Kudos files, and about 9 GB for all of KUDOS (3.14 million pages).
- Tests to add with the build, each named for its rule: "furniture never reaches a chunk", "a chunk's text is its span of the conversion's text", "a table is never split across chunks", "a paragraph across a page break is one part with a region on each page", "offsets count code points, not UTF-16 units", "a printed label is kept only when a neighbouring page agrees", "a merged table cell keeps its colspan in the html", "kn_parts refuses a dataset outside app.datasets", "kn_parts never reads a conversion by its hash" and "a page read returns a part that starts on the page before".
- Drawing a cited box on the page image needs the file in the browser, since the platform keeps no file it can fetch again (ADR 0042). That is its own decision.
