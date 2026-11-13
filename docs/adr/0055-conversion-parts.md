# 0055 Conversion parts

Status: proposed, 2026-11-13 (units and places for every format, 2026-11-13; documents with more than one file, 2026-11-13)

Left: drawing a cited box on the page image, printed page labels in roman numerals, heading levels from a PDF's outline, and a check of reading order. Parts for formats other than PDF are built later, each in an issue of its own; this record says what they become (Formats, below). How an answer quotes the words it rests on is recorded in ADR 0052 when it is built (Citations, below).

## Context

A stored conversion (ADR 0042) holds per-page Markdown. The converter's native output in Blob storage holds what Markdown loses: each item's kind, its box on each page, and whether it is a page header or footer. Nothing reads that output after the page derivation. So a chunker can only cut on Markdown syntax, a table or a paragraph that crosses a page can be cut, and a citation points at a whole excerpt (ADR 0052) with no position inside it.

PDFs are not the only input. The platform reads Word files, web pages, Markdown and plain text, and Parquet tables (ADR 0039), and presentations and workbooks are likely next. Word files and web pages have no fixed pages, so the shape has to hold without them.

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
  | `regions`      | One per unit the part covers: the unit, the part's place in it, and the span in that unit (below)                                                                                                   |
  | `native`       | Where the part came from in the native output, such as Docling's `self_ref` (`#/texts/41`)                                                                                                          |

- **The conversion's text is the `text` of its body parts in `seq` order, joined by a blank line.** It is not stored: it is rebuilt from the parts.
- **Offsets count Unicode code points over NFC-normalised text,** from 0, end exclusive, as the W3C Web Annotation `TextPositionSelector` does. TypeScript reads them through one helper, never with `String.prototype.slice`, which counts UTF-16 units.
- **A part that crosses a unit is one part, with a region in each unit.**
- **Only body parts are chunked or cited.** Furniture (page headers and footers, page numbers, a site's menu) is kept so that it can be drawn. Its layer comes from the converter: Docling's `content_layer` for PDFs. Text inside a picture follows `docling-pages` (ADR 0042): it counts only on a page with no other text. Speaker notes and other text a reader does not see on the page are in the `notes` layer.
- **A table's `html` is built by the derivation** from the cells it parsed, with their text escaped. It is never copied from the source, and a frontend renders it as data.

### Units and places

- **A unit is what a reader cites a place by, and what a read around a hit steps over:** a page for PDFs, scans and images; a slide for presentations; a sheet for workbooks. Formats that flow, such as web pages, Word files and Markdown, have no fixed pages (Word paginates only when it renders), so their unit is a section: the parts from one top-level heading to the next, split when it grows past a size the derivation sets.
- **A region gives the part's place in its unit,** beside `unit`, `start` and `end`:
  - `box`, `[x0, y0, x1, y1]` as fractions of the unit from the top left, where the unit has fixed coordinates: a page, a slide, an image;
  - `locator`, a W3C Web Annotation selector into the source, where it has none: a `CssSelector` for an element of a web page, a `FragmentSelector` for a line range of Markdown or plain text (`line=10,24`, RFC 5147), the paragraph's index in its section for Word, and a `FragmentSelector` naming the sheet and cell range for a workbook, since no standard covers that.
  - A region may hold both.
- **A locator into a live source can break** when the source changes its layout. The quote with its prefix and suffix is the durable anchor (Citations, below).

### Derivations

- **`docling-parts` 1** is made from a `DoclingDocument` in Blob storage, with no download and no converter call. It computes the offsets itself while it joins the text, and does not use Docling's per-item `charspan`.
- **`text-layer-parts` 1** is made from a stored `text-layer` 1 conversion: one `text` part per page, its region the whole page. A file gets real parts once Docling replaces its text layer.
- Both are derivations as ADR 0042 defines them: stored beside `docling-pages` 1 and `text-layer` 1, chosen by the generation's recipe, and removed by `knowledge.cleanup` once no record or kept generation uses them. Other formats get derivations of their own (Formats, below).

### Units and storage

- **A stored conversion gets a number,** `src_conversions.id bigserial unique`, and its parts are stored one row per unit:

  ```sql
  create table src_conversion_units (
    conversion bigint not null references src_conversions (id) on delete cascade,
    unit       integer not null,  -- from 1, in reading order
    kind       text not null,     -- page, slide, sheet or section
    label      text,              -- what a reader cites it by, when known
    width      real,              -- points, for units with fixed coordinates
    height     real,
    text_start integer,           -- the span of the conversion's text that this row's parts cover
    text_end   integer,
    seq_from   integer not null,  -- the parts that start in this unit
    seq_to     integer not null,
    parts      jsonb not null,    -- those parts, in seq order
    primary key (conversion, unit)
  );
  ```

- **A part is stored in the row of the unit where it starts.** The row's `text_start` and `text_end` cover its parts' text, so an offset finds its part's row, and the unit to cite comes from that part's region. A read of units u − 1 to u + 1 reads rows from u − 2, so that a part spilling into u − 1 is not missed.
- **A unit's label** is what a reader cites it by: a page's printed number, a slide's number, a sheet's name, a section's heading. A page's printed number is a number in a furniture part of the page, such as `12`, `s. 12` or `side 3 av 9`, kept only when the nearest labelled page within 2 pages has the same offset from the physical page number. A page without one is cited by its physical number.
- **Deleting a stored conversion deletes its units** through the cascade, so cleanup and withdrawal (ADR 0042) need no rule of their own.

### Chunks and reads

- **A chunker is a function from body parts to chunks,** named in the generation's recipe. `parts-unit` makes one chunk per unit, split at the recipe's size limit on part boundaries; for a PDF that is one chunk per page. `parts-section` starts a chunk at each `section_header` and takes parts up to the size limit; it never splits a table, and a table keeps its caption. A table over the limit is a chunk of its own, embedded by its start (ADR 0042).
- **A chunk made from parts records them.** `kn_chunks` gains `conversion`, `seq_from`, `seq_to`, `text_start` and `text_end`, and a chunk's text is its span of the conversion's text. `page_from`, `page_to` and `heading_path` come from its parts, the pages being its units. The chunk id stays as ADR 0042 has it.
- **`kn_parts(dataset, generation, chunk_id, read, n, file)` returns the parts around a hit:** `neighbours` (`seq` from the chunk's first minus n to its last plus n), `section` (from the nearest `section_header` at or before the hit to the next one) or `units` (parts with a region in the units before and after: the pages around a hit for a PDF), each under a character budget. It is a `SECURITY DEFINER` read function like the others (ADR 0042): it refuses a dataset outside `app.datasets`, starts from the chunk row in the dataset's own partition, and never takes a sha256 or a conversion id from its caller, so no caller can learn whether another organisation holds a file.
- **Each file of a document is read on its own.** A document can hold a main file and attachments, each with its own conversion, offsets and units. A `neighbours`, `section` or `units` read stays in the file that holds the hit and stops at its edge, so a unit number in one read always means one file.
- **A read lists the document's files.** With the parts around a hit, `kn_parts` returns the files of the hit's document in the source's order: each file's name as the document lists it, its number of units, and which one holds the hit. Given `file`, the position of another file in that list, it reads that file's units instead, such as an attachment a letter refers to. It reaches only files of the hit's own document, through the same dataset check.
- **Search never reads the parts.** It reads chunks and search phrases, which have the vector and full-text indexes. A search over headings or tables only is a recipe that writes them as chunks or search phrases when a file is indexed.

### Citations

- **A part's offsets let a citation name the exact words it rests on,** with their unit and place. ADR 0052 records how an answer carries such a quote when it is built: the model writes the words after the marker, the API keeps them only if they are in the excerpt word for word, sends the answer with plain `[N]`, and returns the quote and its W3C Web Annotation selectors (`TextQuoteSelector`, `TextPositionSelector`, and the place: a `FragmentSelector` with the page for a PDF, the region's locator otherwise) in `markers`. A quote that is not found leaves an excerpt citation, and the miss is counted.
- **A citation names the file it quotes as its document lists it,** with the unit's label, and links that file at the unit, such as «Prop. 1 S › Vedlegg 2, s. 3». The name and link come from the document's own file record (the source record ADR 0042 keeps with it), never from the stored conversion, which every document holding the file shares.
- **A citation links the file at its place.** The link is the file's URL from the document's file record with a fragment for the place: `#page=N` with the PDF's physical page, whatever label the reader is shown; a text fragment for a web page; a line anchor for Markdown in a repository. Where a source serves its own copy of a file, as KUDOS does, the link is that copy, whose sha256 is the one that was converted, not a publisher's copy that can change or move. A file with no public URL, such as an upload or a folder file, gets no link until the API serves it, and a folder file's path is never shown, since it can name a person (ADR 0042).

### Formats

Every format becomes the same parts; only its derivation, its unit and its place differ. PDFs are built first; each other format is an issue of its own.

| Format                  | Read today                                            | Parts from                                              | Unit    | Place                                       | Furniture                                                                 |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------- | ------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| PDF                     | Docling, or the text layer                            | `docling-parts` 1; `text-layer-parts` 1                 | page    | box                                         | Docling's: page headers and footers, page numbers                         |
| Scans and images        | PDFs only, through Docling's OCR                      | `docling-parts`, as a scanned page                      | page    | box                                         | as for PDFs                                                               |
| Web pages               | `packages/ingest/src/html.ts`, as one text            | that extractor, which already picks `main` or `article` | section | `CssSelector`, with the nearest `id` anchor | menus, banners and footers, which the extractor leaves out today          |
| Word (`.docx`)          | `mammoth`, as one page of Markdown                    | the document's styles, or Docling                       | section | the paragraph's index in its section        | the file's header and footer parts                                        |
| Presentations (`.pptx`) | not read                                              | Docling, which reads them                               | slide   | box, since slides have fixed coordinates    | slide numbers and the master's footer; speaker notes in the `notes` layer |
| Markdown and plain text | as text                                               | headings, paragraphs, list items and code blocks        | section | line range (RFC 5147)                       | front matter                                                              |
| Workbooks, CSV, Parquet | Parquet rows as documents (ADR 0039); others not read | a row, or a table                                       | sheet   | sheet and cell range, or the row's key      | none                                                                      |

- **A new format** needs a derivation that maps its items to the kinds and layers above and names its unit and place. Chunkers, `kn_parts` and citations do not change.
- **Web pages are cited on the live page.** A link with the quote as a text fragment (`#:~:text=`) scrolls to it and highlights it in the browsers that support text fragments; the stored quote is shown when the page no longer has the words. Telling the two apart needs the hash of the page as it was indexed (Open).

## Measured

On the Docling export seeded into stored conversions (Docling 2.123.1), 13 November 2026, with the scripts and results in [`benchmarks/ingestion/blocks/parts/`](../../benchmarks/ingestion/blocks/parts/). These are PDF numbers; no other format is measured yet.

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

## Open

- **How big a section is** for formats that flow: the unit a citation names and a `units` read steps over. It is set when the first such format is built, and measured like a chunk size.
- **Native output for formats that have none.** Docling's output is in Blob storage, so its parts can be derived again with no download, and the text layer's parts come from its stored pages. Web pages are read in the index job and nothing is stored (ADR 0042), and `mammoth` keeps no native output for Word files, so a new derivation version would need their sources again, and a web page may have changed by then. Storing a fetched page or file as native output under its sha256, as Docling's is, would close that and give the hash a web citation needs to tell a changed page; it amends ADR 0042 when web pages get parts.
- **Where the file comes from to draw a box.** The platform keeps no file it can fetch again (ADR 0042): a public PDF would be fetched from its source by the browser, which depends on that source's CORS headers (not checked), and an uploaded file comes from the platform's blob store through the API.
- **A workbook's locator** has no standard selector, so its `FragmentSelector` value is genki's own until one exists.
- **Presentations and images are not read today.** Reading them is a decision of its own, with its own converter settings.
- **The part format's version.** A change to the record is a new derivation version, such as `docling-parts` 2, derived again from Blob storage. Chunkers and `kn_parts` must read only versions they know. A generation already names the derivation and version it was built from (ADR 0042), so a candidate built from a new version is the natural boundary; whether `kn_parts` also checks the version on each read is open.
- **Quotes in the frontend contract.** When ADR 0052 is amended, `/v1`, MCP and `@genai/client` gain the quote, its selectors and its file and unit in `markers`. Today an excerpt names no file or page (`Excerpt` in `packages/client/src/types.ts`), and a source links to its document, so frontends that read `markers` need a migration note, as they got for excerpt markers.

## Why

- **Parts, not per-page Markdown.** Markdown keeps the words and loses the page, the box, the kind and the furniture. Without them a chunk cannot be cited to a place, a table cannot be kept whole, and a rechunk can split only on Markdown syntax.
- **One shape for every converter and format.** The converter or the format can change without touching chunkers, reads or citations. Turned down: reading each converter's native output directly, which gives every reader a path per converter.
- **Units, not pages.** A page-keyed table would make web pages and Word files invent pages they do not have. A unit is what a reader cites by in each format, so a PDF's unit is still its page and nothing is lost for PDFs.
- **W3C selectors for places.** Web Annotation already has selectors for an element, a text quote, a text position and a fragment of a PDF, a text file or a media file, so a citation needs no format of its own outside workbooks.
- **Offsets into one text, computed while it is joined.** A citation then names an exact span whatever the recipe, since a chunk is a span of the same text. Finding offsets afterwards with a text search goes wrong where the same text appears twice, and Docling's `charspan` counts within one item only.
- **Code points, not UTF-16 units.** They match W3C Web Annotation, PostgreSQL's `substr` and Python, so stored selectors are standard and need no conversion. The two differ only after a character outside the BMP, which 0.05 to 0.16 % of the sampled pages hold, so a slip would rarely show: hence one helper and a test for it.
- **One row per unit, not one row per part.** The planned reads (a citation, the parts around a hit, a rechunk, a withdrawal) are per document and take a few ms either way. On PDFs, one row per part takes 2.2 times the space (15.9 against 7.3 GB for the seed) and about 28 million rows instead of 2.55 million, because most part values are too short to compress. It is faster only for SQL over all parts of a dataset, such as counting kinds across Kudos (about 3.8 against 24 seconds at 2.55 million pages), which no planned read does.
- **One part with a region per unit.** A paragraph or table that crosses a page comes back whole, and still cites to each page. Splitting at the page break would cut a sentence in two.
- **Boxes as fractions from the top left.** Docling gives points from the bottom left; fractions from the top left draw on a rendering of any size.
- **Printed labels only when a neighbouring page agrees.** Of the labels found, 1.4 to 2.4 % disagree with the nearest labelled page: chapter numbers in page headers, years, and lone numbers. A citation with a wrong printed page sends the reader to the wrong page; one with no label falls back to the physical page.
- **Docling's layers, no rule of our own.** Docling marks 15 to 17 % of parts as furniture. A rule that turns text repeated in the same band of 3 or more pages into furniture would catch running titles left in the body on 4.8 to 7.3 % of pages, and also repeated legend text on drawings, while catching none of the contact lines in the bottom band of letters (0 of 91 and 0 of 106), which rarely repeat. Turned down until the retrieval checks show that the missed running titles hurt.
- **Each file on its own, and a list of the files.** In KUDOS, 1,530 of 45,902 documents (3.3 %) have attachments: 4,385 files with 5.8 % of the pages, each with its own URL, page count and a description such as "Vedlegg 1". A read that ran on into the next file would join a letter's last page to its attachment's first and make a unit number mean two files. The list of files lets the agent open an attachment on purpose, where search alone would miss an answer that only an attachment holds. Turned down: running on across files in the source's order, as `kn_range` positions do (issue 146).
- **File names from the document, not the conversion.** 305 KUDOS files are in more than one document, and 50 of them are the main file in one and an attachment in another, so only the document knows what to call a file.
- **HTML for tables, built by us.** 26 % of tables have merged cells, which a Markdown table can only repeat. Building the HTML from the parsed cells keeps the merges and lets nothing from a source's markup reach a frontend.

## Consequences

- Not built. PDFs are built in four steps, each an issue of its own, after Kudos is the active dataset on the knowledge database (issue 475): derive parts (a TypeScript derivation, `src_conversion_units`, parts derived from Blob storage when an index job needs them); chunk from parts (`parts-unit`, `parts-section`, the chunk columns, candidates ranked by the checks of issue 147); `kn_parts`; and quotes, with ADR 0052 amended. Each other format in Formats is an issue of its own after that.
- ADR 0042 changes with it: What is stored, Conversion, Identity and chunks, and its list of read functions. It changes again when web pages get parts and their fetched pages are stored (Open).
- `benchmarks/ingestion/blocks/normalise.py` (format `genki.blocks/1`) is where the PDF derivation starts, not its format: it gives each block one page and box, offsets into Markdown instead of plain text, a furniture flag instead of a layer, and table HTML from the repeated grid.
- The knowledge server holds about 7.3 GB more for the seeded Kudos files, and about 9 GB for all of KUDOS (3.14 million pages).
- Tests to add with the build, each named for its rule: "furniture never reaches a chunk", "a chunk's text is its span of the conversion's text", "a table is never split across chunks", "a paragraph across a page break is one part with a region on each page", "offsets count code points, not UTF-16 units", "a printed label is kept only when a neighbouring page agrees", "a merged table cell keeps its colspan in the html", "a table's html never carries the source's markup", "kn_parts refuses a dataset outside app.datasets", "kn_parts never reads a conversion by its hash", "a units read returns a part that starts in the unit before", "a read around a hit stops at the edge of its file", "kn_parts lists the files of the hit's document", "kn_parts reads another file of the hit's own document only", "a citation names a file as its document lists it", "a page link uses the physical page, not the printed label" and "a folder file's citation shows no path". Each new format adds "its parts have the same fields as a PDF's" and a test for its unit and place.
