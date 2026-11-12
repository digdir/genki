# Checking tests against the page

A second reader checks some of the reference's tests (see `verify_queue.py` for which). You get each test's claim about a page and decide, from the page image alone, whether the claim is true.

## What you may look at

- The page image: `benchmarks/ingestion/.data/opb/png/<page_id>.png`.
- Close-ups: `.venv/bin/python zoom.py <page_id> <x0> <y0> <x1> <y1>` from `benchmarks/ingestion/opb` (fractions of the page, origin top left) prints the path of a crop to open.
- `writing-tests.md`, for the rules the tests were written by.

Nothing else: no other folder under `benchmarks/ingestion/.data/`, no text extracted from a PDF, no test files in `reference/tests/`, no scores or verdicts in `results/`. You aren't told how any system did on a test, and must not try to find out.

## What to decide

Your batch is a file of JSON lines, each with `test_id`, `page_id`, `test_type`, `claim` (the test in words) and `args` (the test itself). For each line, zoom in on the text and decide:

- **ok**: the claim is true of the page as printed, and the test follows the rules in `writing-tests.md`.
- **fix**: the claim is meant right, but the text in it isn't exactly what is printed (a misread letter or number, a word missing or added, a hyphen at a line end not joined). Give the corrected `args`, same test type and roles.
- **drop**: the claim can't be made right: the text isn't on the page, the order is a matter of taste, the passage runs across two blocks (heading into paragraph, two cells), it is a running header, footer or page number, or the print is too unclear to be sure.

How to judge each type:

- `present`: is the text printed on the page, word for word? Case, spacing and a hyphen joining a word broken at a line end don't matter. Up to `max_diffs` small slips are allowed, but a slip you can see is still a **fix**.
- `order`: is each passage printed once, and would a person reading the page read the first before the second?
- `table_cell`: is the cell in a table, and is each other role right: `top_heading` is the column heading over it, `left_heading` the row label of its row, `left`/`right`/`up`/`down` the next cell that way.

## What to write

One line per test to the result file you're given, in the same order:

```json
{"test_id": "…", "verdict": "ok", "note": ""}
{"test_id": "…", "verdict": "fix", "args": {"content": {"text": "…", "max_diffs": 2}}, "note": "printed 'tilskudd', not 'tilskot'"}
{"test_id": "…", "verdict": "drop", "note": "the sidebar has no clear place in the reading order"}
```

A note is required for fix and drop: say what you saw.
