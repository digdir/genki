# marker-pdf-to-markdown

A small HTTP service that converts PDF files to Markdown with [Marker](https://github.com/datalab-to/marker). The API uses it when `DOCUMENT_CONVERTER=marker`: the `markerConverter` in `packages/ingest/src/converter.ts` sends each PDF here and joins the returned pages.

It is a Python service (Python 3.13, FastAPI, `marker-pdf` 1.10.2, PyTorch), so it is not an npm workspace and is not part of `npm run check` or the genki image. Build and run it on its own.

## Run it

With Docker, from this folder:

```sh
docker build -t marker-pdf-to-markdown .
docker run --rm -p 8080:8080 \
  -e MARKER_PDF_TO_MARKDOWN_API_KEY=change-me \
  -v marker-cache:/cache \
  marker-pdf-to-markdown
```

The build downloads the Marker models into the image, so the first build is slow and the image is large. Add `--gpus all` on a host with an NVIDIA GPU.

Without Docker, with [mise](https://mise.jdx.dev):

```sh
mise trust && mise install   # Python 3.13 and a venv in ./venv
mise run install             # pip install -r requirements.txt
MARKER_PDF_TO_MARKDOWN_API_KEY=change-me mise run dev
```

## Test it

The tests replace Marker with a fake, so they need neither PyTorch nor the models. CI runs them on every pull request.

```sh
pip install -r requirements-test.txt
python -m pytest
```

`requirements-web.txt` holds the web dependencies that both the service and the tests use, so the tests run against the same FastAPI version.

When Marker or its settings change, also convert a few real PDFs with real Marker through the service's own code. `check_real_marker.py` prints one line per PDF (pages, seconds per page, JSON size, OCR pages) and exits with 1 if the pages, the JSON and `page_stats` disagree or images are left in. In the image, from this folder:

```sh
docker run --rm --network none \
  -v "$PWD/main.py:/app/main.py:ro" -v "$PWD/check_real_marker.py:/app/check_real_marker.py:ro" \
  -v /path/to/pdfs:/in:ro marker-pdf-to-markdown python check_real_marker.py /in/report.pdf
```

## Point genki at it

In the API's `.env.local`:

```sh
DOCUMENT_CONVERTER=marker
MARKER_URL=http://localhost:8080/api/v1/marker-pdf-to-markdown
MARKER_API_KEY=change-me
```

## Settings

| Variable                         | Default  | Meaning                                                       |
| -------------------------------- | -------- | ------------------------------------------------------------- |
| `MARKER_PDF_TO_MARKDOWN_API_KEY` | none     | Required. Clients send it in the `X-API-Key` header           |
| `MARKER_WORKERS`                 | `2`      | Converters running at once. Each loads its own copy of models |
| `CACHE_DIR`                      | `/cache` | Where cached PDFs and results are kept, keyed by SHA-256 hash |
| `PORT`                           | `8080`   | HTTP port                                                     |

Marker is configured for Norwegian and English text, with image extraction turned off.

## API

Every `/api/v1` route needs the `X-API-Key` header.

| Route                                 | What it does                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/marker-pdf-to-markdown` | Converts the multipart `file`. Returns `{ success, pages, json, metadata, marker_version, settings, cached, file_hash }` |
| `GET /api/v1/cache/{file_hash}`       | Returns the cached result for a hash                                                                                     |
| `GET /api/v1/cache/{file_hash}/pdf`   | Returns the cached PDF for a hash                                                                                        |
| `DELETE /api/v1/cache/{file_hash}`    | Deletes the cached PDF and its result                                                                                    |
| `GET /`, `GET /health`, `GET /up`     | Status, queue sizes and liveness. No key needed                                                                          |

The conversion route takes two query flags:

- `cache=true` returns a stored result for a PDF it has seen before, and stores new results.
- `priority=true` puts the request ahead of requests without it.

Each PDF is converted once and rendered twice:

- `pages` is Marker's Markdown split on its page separator. Marker writes a `{n}` page marker and the separator before every page, so `pages` has one more entry than the PDF has pages: the first is just `{0}`, and each later one ends with the next page's marker. Joined back together, every marker stands before its page, which is what genki's `markerConverter` does.
- `json` is Marker's JSON rendering: one entry per page in `children`, each a tree of blocks with `block_type` (`SectionHeader`, `Text`, `Table`, `PageHeader`…), `html`, `polygon`, `bbox` and `section_hierarchy`. Images are left out.
- `metadata` holds `table_of_contents` and `page_stats`. A page's `text_extraction_method` is `pdftext` when its text came from the PDF and `surya` when Marker read it with OCR.
- `marker_version` and `settings` say what made the result. A cached result is served only when both match the running service; otherwise the PDF is converted again and the entry replaced. Entries written by older versions of this service hold pages only: the cache route returns them as pages, and a conversion request converts the PDF again.

A request waits until its PDF is converted, which can take minutes for a long document, so clients need a long timeout.
