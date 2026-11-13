# Conversion parts in the Docling export of KUDOS

The three scripts here read a sample of the Docling 2.123.1 export of KUDOS PDFs (`<2 hex>/<sha256>/docling.json`) and measure the facts ADR 0055 rests on. Each script sorts the export's files by path and then draws its sample with `random.sample` and a seed, so the same seed gives the same files. Run on 13 November 2026. No document text is in this file.

| Script              | Files | Seed 7 pages | Seed 11 pages |
| :------------------ | ----: | -----------: | ------------: |
| `stats.py`          |   200 |       11,175 |        12,178 |
| `labels_footers.py` |   200 |       11,175 |        12,178 |
| `storage.py`        |   300 |       18,199 |     (not run) |

## Parts (`stats.py`)

Parts are the blocks `normalise.py` makes (`docling_blocks`, then `finish`).

| Measure                                      |  Seed 7 | Seed 11 |
| :------------------------------------------- | ------: | ------: |
| Parts                                        | 121,274 | 137,340 |
| Parts a page                                 |    10.9 |    11.3 |
| Parts crossing a page (more than one page)   |  1.64 % |  1.60 % |
| Parts marked furniture                       |  15.0 % |  17.4 % |
| Pages with a character outside the BMP       |  0.05 % |  0.16 % |
| Tables                                       |   3,160 |   3,338 |
| Tables with merged cells                     |  26.4 % |  26.3 % |
| Table HTML, share of the parts' JSON         |   7.1 % |   7.1 % |
| Parts' JSON, bytes a page                    |   5,896 |   6,252 |
| Pages with a printed label (first pass)      |  71.5 % |  67.8 % |
| Of those, label differs from the page number |  47.8 % |  55.6 % |

## Labels and footers (`labels_footers.py`)

A page's label is the first furniture text on it that reads as a page number (`12`, `s. 12`, `side 3 av 9`). The rule keeps it when the nearest labelled page within 2 pages has the same offset from the physical page number. A running title left in the body is text that is not furniture, repeats on 3 or more pages of a file (digits folded) and sits only in the top 10 % or only in the bottom 10 % of the page (the strict same-band rule). A contact line is body text in the bottom 15 % of a page with a phone number, an e-mail address or a word such as `telefon` or `saksbehandler`.

| Measure                                                   | Seed 7 | Seed 11 |
| :-------------------------------------------------------- | -----: | ------: |
| Pages with a printed label                                | 71.5 % |  67.8 % |
| Pages the label rule keeps a label for (coverage)         | 70.5 % |  66.2 % |
| Labels the rule keeps (agreement with a neighbour)        | 98.6 % |  97.6 % |
| Pages with a running title left in the body (strict rule) |  4.8 % |   7.3 % |
| Files with one                                            |     36 |      36 |
| Files with a contact line in the bottom band              | 20.5 % |  24.5 % |
| Contact lines the same-band rule catches                  |   0/91 |   0/106 |
| Texts marked furniture                                    |  9.3 % |  11.4 % |

The script also prints the counts behind these shares, numbers in the body near the page edge, Roman numerals (none of the pages that have one get a label) and repeated text in the middle of the page.

## Storage (`storage.py`)

PostgreSQL 17.11 in a throwaway container, 300 files, seed 7: 18,199 pages and 201,078 parts. A keeps one row per page with the page's parts as a jsonb array; B keeps one row per part. Times are medians over 200 warm calls with random arguments, in ms.

| Measure                                          | A, a row a page |           B, a row a part |
| :----------------------------------------------- | --------------: | ------------------------: |
| Bytes a page (pglz)                              |           2,872 |                     6,238 |
| GB for 2.55 million pages                        |             7.3 |                      15.9 |
| GB for 3.14 million pages                        |             9.0 |                      19.6 |
| Bytes a page with lz4                            |           3,283 |                     6,300 |
| Read one page                                    |            0.18 |                      0.56 |
| Read `seq` ± 5                                   |            0.22 |                      0.19 |
| Read pages ± 1                                   |            0.27 |                      0.41 |
| Quote offset to part                             |            0.19 | 0.26 (0.17 with an index) |
| All body parts of a file                         |             3.5 |                       2.5 |
| All body parts of the largest file (8,496 parts) |              66 |                        43 |
| Count by kind over the sample                    |             173 |                        27 |
| Same, scaled to 2.55 million pages               |            24 s |                     3.8 s |
| Delete and write the largest file (medians, ms)  |          3 + 66 |                    5 + 69 |

## How to run

```sh
python3 -I stats.py <export root> 200 7
python3 -I labels_footers.py <export root> 200 7
docker run -d --name parts-measure -e POSTGRES_PASSWORD=x -p <port>:5432 postgres:17
PARTS_DSN='host=127.0.0.1 port=<port> user=postgres password=x dbname=postgres' <python with psycopg> -I storage.py <export root> 300 7
docker rm -f parts-measure
```

Use seed 11 for the second sample. `storage.py` drops and creates its own tables, so run it only against a throwaway database.
