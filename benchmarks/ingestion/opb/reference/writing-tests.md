# Writing the reference

How the tests in `reference/tests/` are written. Each page gets a handful of yes/no tests about what is printed on it. Several PDF-to-text systems are later graded on those tests. The writer works only from images of the page, so the tests can't favour any system's text.

## What you may look at

- The page image: `benchmarks/ingestion/.data/opb/png/<page_id>.png` (the whole page).
- Close-ups: `.venv/bin/python zoom.py <page_id> <x0> <y0> <x1> <y1>` from `benchmarks/ingestion/opb` crops the page's 300 dpi image (fractions of the page, origin top left) and prints the path of the crop, which you then open. Zoom on anything small before you copy it.
- The three worked examples: `reference/tests/kudos-51863-p30.json` (a landscape table), `reference/tests/kudos-90723-p51.json` (a report page with a table), `reference/tests/kudos-31205-p15.json` (a scanned report page).

Nothing else. Don't open other folders under `benchmarks/ingestion/.data/` (PDFs, text extractions, runs, caches) or `results/`, don't extract text from a PDF with any tool, and don't open other writers' test files. A test copied from a text extraction would grade that extraction against itself.

## What to write

One file per page, `reference/tests/<page_id>.json`:

```json
{
  "tests": [
    {
      "id": "<page_id>-t01",
      "test_type": "present",
      "output_type": "html",
      "derivation": "model_panel",
      "tags": ["nob", "Latn"],
      "args": { "content": { "text": "…", "max_diffs": 2 } },
      "settings": {}
    }
  ]
}
```

Every test has exactly these seven keys. `output_type` is always `html`, `derivation` always `model_panel`, `settings` always `{}`. Ids run `-t01`, `-t02`, … within the page.

Aim for 6–10 tests on a page full of text, fewer on a sparse one (a cover, a divider, a page with a few lines). Spread them over the page: top, middle and bottom, each column, boxes and sidebars, captions, footnotes. A page with nothing to test (blank, a photo without text, only a page number) gets `{"tests": [], "skipped": "<why>"}`.

### The test types

**present**: this text is on the page.

- A sentence or phrase of 6–20 words, copied exactly: `{"content": {"text": "Jordbrukssektoren står for cirka 70 prosent av det globale vannforbruket.", "max_diffs": 2}}`.
- Headings, names and other short distinctive text too, tagged `heading` where it is one.
- Important figures (amounts, percentages, counts, dates) as text with no edits: `{"text": "21,8 %", "max_diffs": 0}`. A whole number may instead be `{"number": "45 312"}`; never use `number` for a decimal with a comma.

**order**: passage A comes before passage B when the page is read as a person reads it.

- Two passages of 3–12 words, each printed once on the page, with the same `max_diffs`: `{"before": {"text": "…", "max_diffs": 1}, "after": {"text": "…", "max_diffs": 1}}`.
- Pick pairs where a converter could go wrong: the end of the left column before the start of the right column; a heading before its first paragraph; text before and after a box, figure or table; body text before the footnotes; a table's last row before the paragraph under it.
- Only pairs whose order is clear to a reader. Skip a sidebar whose place in the reading order is a matter of taste.

**table_cell**: a cell sits in a table under this column heading, beside this row label.

- On every page with a table (a grid with column headings or row labels), 2–5 of these: `{"cell": {"text": "21,8 %", "max_diffs": 0}, "left_heading": {"text": "Italia", "max_diffs": 0}, "top_heading": {"text": "Andel av salgsvolum", "max_diffs": 0}}`.
- Roles: `cell` (always), `top_heading` (the column heading), `left_heading` (the row label), `left`, `right`, `up`, `down` (the next cell). Give each test `cell` and at least one other role. All args of a test share one `max_diffs`.
- Prefer cells whose meaning depends on where they sit (a number is meaningless without its row and column).
- A heading printed over several lines is written as one line: "Lengde bekke-/løp" becomes "Lengde bekkeløp".
- Also write 1–2 `present` tests for figures in the table, so a system that keeps the numbers but loses the grid is still credited for the text.

Don't write `repeat` or `layout_kind` tests.

### Copying text

- Copy exactly what is printed: spelling, punctuation, æ ø å, numbers and units, including printing mistakes. Case is ignored in grading, but keep it.
- A word broken with a hyphen at a line end is written whole ("grense-/kontroll" becomes "grensekontroll"). A hyphen that belongs to the word stays ("Sør-Afrika", "Kultur- og idrettsbygg").
- Keep each passage inside one block: one paragraph, one heading, one list item, one cell. Never run a passage from a heading into its paragraph or across two cells.
- Leave out footnote marks (superscript numbers) and bullet glyphs: start or end the passage before the mark, or pick another passage.
- `max_diffs` (edits allowed for small copying slips): 0 for text under 20 characters and for numbers, then about one per 25 characters (40 characters → 1–2, 80 → 3, 150 → 4).
- Can't read it with certainty, even zoomed in? Don't test it.

### What not to test

- Running headers and footers (a report title or chapter name repeated in the margin), page numbers, logos.
- Text inside charts, diagrams, maps, photos and infographics: at most 2 tests per page, tagged `figure`.
- Handwriting, unless it is perfectly clear (tag it `handwriting`).

### Tags

- A language for every test: `nob` (Bokmål), `nno` (Nynorsk), `eng`, `sme` (Northern Sami), and the script `Latn`.
- Then what applies: `heading`, `caption`, `footnote`, `list`, `table`, `figure`, `multi_column` (inside one column of a page set in two or more columns), `tiny` (about 6 pt or smaller), `degraded` (a scan that is hard to read), `rotated`, `handwriting`.

## Check your files

```sh
.venv/bin/python validate.py reference/tests/<page_id>.json …
```

It runs the benchmark tool's own checks plus ours (ids, a language tag on each test). Fix every problem it prints.
