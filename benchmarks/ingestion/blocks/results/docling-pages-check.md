# docling-pages against Docling's own pages

Each page's Markdown from genki's page builder `doclingPages` (derivation `docling-pages` 1) and from Docling's `export_to_markdown(page_no=n)` (**the reference**), both from the same DoclingDocument JSON of the Docling export, graded with the opb scorer on the page tests of `page_tests_run2.py`. Two test sets, each scored on its own and never pooled. Only this run's pages and grades are used. Made by `page_tests_docling_pages.py`.

## opb page tests (documents of documents.json)

Left out, not in the export: 1 document(s) (5944).

| Slice | Pages | Tests | Documents |
| --- | ---: | ---: | ---: |
| All | 31 | 267 | 14 |
| Text | 31 | 238 | 14 |
| Tables † | 9 | 29 | 8 |
| Digital | 21 | 198 | 11 |
| Scan + text † | 4 | 28 | 4 |
| Image-only † | 6 | 41 | 4 |

Pass rate in percent, ranked by the first column.

| Side | All | Text | Tables † | Digital | Scan + text † | Image-only † |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Docling export_to_markdown(page_no) (reference)** | 89.5 | 92.4 | 65.5 | 91.4 | 96.4 | 75.6 |
| docling-pages 1 | 89.5 | 92.4 | 65.5 | 91.4 | 96.4 | 75.6 |

docling-pages minus the reference in points, 95% interval from resampling documents; ✱ = interval leaves out zero (only marked on slices from 10+ documents). † = fewer than 10 documents: a hint only.

| Side | All | Text | Tables † | Digital | Scan + text † | Image-only † |
| --- | --- | --- | --- | --- | --- | --- |
| docling-pages 1 | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) |

**Verdict:** docling-pages is at or above the reference on all: 239 of 267 tests passed against 239.

## Era page tests (documents of the era test set)

Left out, not in the export: 2 document(s) (8a1cc78e, d71c0286).

| Slice | Pages | Tests | Documents |
| --- | ---: | ---: | ---: |
| All (scored) | 58 | 515 | 22 |
| Text | 40 | 355 | 22 |
| Tables † | 27 | 160 | 9 |
| Text around tables | 27 | 254 | 10 |
| Digital | 40 | 350 | 18 |
| Scan + text † | 7 | 60 | 3 |
| Image-only † | 11 | 105 | 5 |
| before 2000 † | 11 | 89 | 5 |
| 2000-2009 † | 18 | 165 | 6 |
| 2010-2019 † | 14 | 116 | 6 |
| 2020 on † | 15 | 145 | 5 |

Pass rate in percent, ranked by the first column.

| Side | All (scored) | Text | Tables † | Text around tables | Digital | Scan + text † | Image-only † | before 2000 † | 2000-2009 † | 2010-2019 † | 2020 on † |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Docling export_to_markdown(page_no) (reference)** | 75.5 | 87.0 | 50.0 | 79.9 | 77.4 | 66.7 | 74.3 | 76.4 | 82.4 | 77.6 | 65.5 |
| docling-pages 1 | 75.5 | 87.0 | 50.0 | 79.9 | 77.4 | 66.7 | 74.3 | 76.4 | 82.4 | 77.6 | 65.5 |

docling-pages minus the reference in points, 95% interval from resampling documents; ✱ = interval leaves out zero (only marked on slices from 10+ documents). † = fewer than 10 documents: a hint only.

| Side | All (scored) | Text | Tables † | Text around tables | Digital | Scan + text † | Image-only † | before 2000 † | 2000-2009 † | 2010-2019 † | 2020 on † |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| docling-pages 1 | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) |

**Verdict:** docling-pages is at or above the reference on all (scored): 389 of 515 tests passed against 389.

Slices: **All** = every test on the set's pages; **Text** = tests that a phrase is on the page (present) or that two phrases come in order (order); **Tables** = tests that a cell sits in the right row and column (table_cell); **Digital**, **Scan + text**, **Image-only** = pages by how the PDF holds their text (text layer, scanned image with a text layer, image without one); era slices = by publishing year. Era set (reference-eras/README.md): **Text** = present + order tests on the first round's pages; **Tables** = table_cell on all pages; **All (scored)** = both of those; **Text around tables** = text tests on the added table pages, shown alone. Page-kind and era slices use the scored tests.

No document text is in this file.
