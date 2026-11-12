# Page tests on run 2 (11 Nov 2026)

Run 2's whole-document conversions, one page cut out at a time (`page_tests_extract.py`), graded with the opb scorer. Two test sets, each scored on its own and never pooled. **Reference: run 2's Marker 1.10.2 on the T4.** Only run 2's conversions are used. Made by `page_tests_run2.py`.

## opb page tests (15 documents of documents.json)

| Slice | Pages | Tests | Documents |
| --- | ---: | ---: | ---: |
| All | 33 | 287 | 15 |
| Text | 33 | 258 | 15 |
| Tables † | 9 | 29 | 8 |
| Digital | 21 | 198 | 11 |
| Scan + text † | 6 | 48 | 5 |
| Image-only † | 6 | 41 | 4 |

Pass rate in percent, ranked by the first column.

| Side | All | Text | Tables † | Digital | Scan + text † | Image-only † |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Docling, Tesseract nor, Egret large | 93.0 | 96.1 | 65.5 | 91.9 | 100.0 | 90.2 |
| Docling, Tesseract nor+eng | 93.0 | 96.1 | 65.5 | 92.4 | 100.0 | 87.8 |
| Docling, Tesseract nor, tessdata_best | 93.0 | 96.1 | 65.5 | 92.4 | 100.0 | 87.8 |
| Docling, Tesseract nor | 92.7 | 95.7 | 65.5 | 92.4 | 100.0 | 85.4 |
| Docling, Tesseract nor, repair | 92.7 | 95.7 | 65.5 | 92.4 | 100.0 | 85.4 |
| Marker 1.10.2, strip_existing_ocr | 87.5 | 89.9 | 65.5 | 88.9 | 81.2 | 87.8 |
| **Marker 1.10.2 (reference)** | 87.1 | 89.5 | 65.5 | 88.9 | 79.2 | 87.8 |
| Docling, Tesseract nor, no cell matching | 86.1 | 93.0 | 24.1 | 82.8 | 100.0 | 85.4 |

Side minus reference in points, 95% interval from resampling documents; ✱ = interval leaves out zero (only marked on slices from 10+ documents). † = fewer than 10 documents: a hint only.

| Side | All | Text | Tables † | Digital | Scan + text † | Image-only † |
| --- | --- | --- | --- | --- | --- | --- |
| Docling, Tesseract nor, Egret large | +5.9 ✱ (+0.7 to +13.8) | +6.6 ✱ (+1.4 to +15.1) | 0.0 (−10.0 to +9.7) | +3.0 (0.0 to +6.5) | +20.8 (+1.9 to +65.8) | +2.4 (−4.1 to +40.0) |
| Docling, Tesseract nor+eng | +5.9 ✱ (+0.7 to +13.3) | +6.6 ✱ (+1.5 to +14.5) | 0.0 (−17.7 to +15.4) | +3.5 (0.0 to +7.3) | +20.8 (+1.9 to +65.8) | 0.0 (−5.9 to +20.0) |
| Docling, Tesseract nor, tessdata_best | +5.9 ✱ (+1.0 to +13.5) | +6.6 ✱ (+1.6 to +14.8) | 0.0 (−18.2 to +15.4) | +3.5 (0.0 to +7.4) | +20.8 (+1.9 to +65.8) | 0.0 (−5.9 to +20.0) |
| Docling, Tesseract nor | +5.6 ✱ (+0.3 to +13.2) | +6.2 ✱ (+1.1 to +14.2) | 0.0 (−18.2 to +15.4) | +3.5 (0.0 to +7.3) | +20.8 (+1.9 to +65.8) | −2.4 (−11.8 to +20.0) |
| Docling, Tesseract nor, repair | +5.6 ✱ (+0.3 to +12.9) | +6.2 ✱ (+1.2 to +13.9) | 0.0 (−17.9 to +15.4) | +3.5 (0.0 to +7.3) | +20.8 (+1.9 to +65.8) | −2.4 (−11.8 to +20.0) |
| Marker 1.10.2, strip_existing_ocr | +0.3 (0.0 to +1.1) | +0.4 (0.0 to +1.2) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | +2.1 (0.0 to +4.2) | 0.0 (0.0 to 0.0) |
| Docling, Tesseract nor, no cell matching | −1.0 (−8.0 to +7.8) | +3.5 (−2.0 to +11.8) | −41.4 (−66.7 to −16.0) | −6.1 (−12.4 to 0.0) | +20.8 (+2.1 to +65.8) | −2.4 (−11.8 to +20.0) |

## Era page tests (24 documents of the era test set)

| Slice | Pages | Tests | Documents |
| --- | ---: | ---: | ---: |
| All (scored) | 67 | 578 | 24 |
| Text | 43 | 378 | 24 |
| Tables | 35 | 200 | 11 |
| Text around tables | 33 | 303 | 12 |
| Digital | 45 | 384 | 19 |
| Scan + text † | 11 | 89 | 4 |
| Image-only † | 11 | 105 | 5 |
| before 2000 † | 15 | 118 | 6 |
| 2000-2009 † | 18 | 165 | 6 |
| 2010-2019 † | 14 | 116 | 6 |
| 2020 on † | 20 | 179 | 6 |

Pass rate in percent, ranked by the first column.

| Side | All (scored) | Text | Tables | Text around tables | Digital | Scan + text † | Image-only † | before 2000 † | 2000-2009 † | 2010-2019 † | 2020 on † |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Docling, Tesseract nor, tessdata_best | 81.1 | 94.4 | 56.0 | 94.4 | 82.3 | 73.0 | 83.8 | 80.5 | 86.7 | 86.2 | 73.2 |
| Docling, Tesseract nor | 81.0 | 95.0 | 54.5 | 94.4 | 81.2 | 70.8 | 88.6 | 78.8 | 86.7 | 90.5 | 70.9 |
| Docling, Tesseract nor, repair | 81.0 | 95.0 | 54.5 | 94.4 | 81.2 | 70.8 | 88.6 | 78.8 | 86.7 | 90.5 | 70.9 |
| Docling, Tesseract nor, Egret large | 80.8 | 94.7 | 54.5 | 95.0 | 81.8 | 68.5 | 87.6 | 79.7 | 82.4 | 92.2 | 72.6 |
| Docling, Tesseract nor+eng | 80.4 | 93.4 | 56.0 | 94.4 | 81.2 | 74.2 | 82.9 | 81.4 | 86.1 | 86.2 | 70.9 |
| **Marker 1.10.2 (reference)** | 78.7 | 96.6 | 45.0 | 91.7 | 79.7 | 79.8 | 74.3 | 85.6 | 80.0 | 87.9 | 67.0 |
| Marker 1.10.2, strip_existing_ocr | 78.4 | 96.6 | 44.0 | 90.8 | 79.2 | 79.8 | 74.3 | 85.6 | 80.0 | 86.2 | 67.0 |
| Docling, Tesseract nor, no cell matching | 76.5 | 93.7 | 44.0 | 90.8 | 74.0 | 73.0 | 88.6 | 80.5 | 77.0 | 83.6 | 68.7 |

Side minus reference in points, 95% interval from resampling documents; ✱ = interval leaves out zero (only marked on slices from 10+ documents). † = fewer than 10 documents: a hint only.

| Side | All (scored) | Text | Tables | Text around tables | Digital | Scan + text † | Image-only † | before 2000 † | 2000-2009 † | 2010-2019 † | 2020 on † |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Docling, Tesseract nor, tessdata_best | +2.4 (−2.6 to +8.2) | −2.1 (−4.3 to 0.0) | +11.0 (−2.2 to +23.2) | +2.6 (−0.6 to +5.6) | +2.6 (−1.6 to +8.0) | −6.7 (−9.2 to 0.0) | +9.5 (−16.9 to +20.9) | −5.1 (−8.1 to 0.0) | +6.7 (−1.7 to +17.8) | −1.7 (−4.5 to +2.9) | +6.1 (−5.0 to +16.6) |
| Docling, Tesseract nor | +2.2 (−3.3 to +8.3) | −1.6 (−4.8 to +1.2) | +9.5 (−5.3 to +22.5) | +2.6 (−0.4 to +5.6) | +1.6 (−2.9 to +7.3) | −9.0 (−15.2 to 0.0) | +14.3 (−1.2 to +24.1) | −6.8 (−12.2 to 0.0) | +6.7 (−1.7 to +17.6) | +2.6 (−3.9 to +8.5) | +3.9 (−5.8 to +16.4) |
| Docling, Tesseract nor, repair | +2.2 (−3.3 to +8.3) | −1.6 (−4.8 to +1.2) | +9.5 (−5.1 to +22.8) | +2.6 (−0.4 to +5.6) | +1.6 (−2.9 to +7.4) | −9.0 (−15.2 to 0.0) | +14.3 (−1.2 to +24.1) | −6.8 (−12.2 to 0.0) | +6.7 (−1.8 to +17.7) | +2.6 (−3.9 to +8.6) | +3.9 (−5.9 to +16.6) |
| Docling, Tesseract nor, Egret large | +2.1 (−3.3 to +7.4) | −1.9 (−5.3 to +1.1) | +9.5 (−3.4 to +20.9) | +3.3 ✱ (+0.9 to +5.9) | +2.1 (−2.0 to +6.3) | −11.2 (−18.8 to −6.2) | +13.3 (−1.2 to +22.8) | −5.9 (−10.1 to 0.0) | +2.4 (−8.3 to +13.9) | +4.3 (0.0 to +8.5) | +5.6 (−5.0 to +15.2) |
| Docling, Tesseract nor+eng | +1.7 (−3.2 to +7.7) | −3.2 ✱ (−6.3 to −0.3) | +11.0 (−2.2 to +23.0) | +2.6 (−0.4 to +5.6) | +1.6 (−2.9 to +7.4) | −5.6 (−7.7 to 0.0) | +8.6 (−18.6 to +20.9) | −4.2 (−6.8 to 0.0) | +6.1 (−3.1 to +17.2) | −1.7 (−4.4 to +2.9) | +3.9 (−5.8 to +16.6) |
| Marker 1.10.2, strip_existing_ocr | −0.3 (−1.1 to 0.0) | 0.0 (0.0 to 0.0) | −1.0 (−3.4 to 0.0) | −1.0 (−3.3 to 0.0) | −0.5 (−1.6 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | −1.7 (−4.0 to 0.0) | 0.0 (0.0 to 0.0) |
| Docling, Tesseract nor, no cell matching | −2.2 (−6.7 to +3.6) | −2.9 (−6.5 to +0.3) | −1.0 (−15.5 to +12.8) | −1.0 (−5.4 to +2.5) | −5.7 ✱ (−9.3 to −2.0) | −6.7 (−9.2 to 0.0) | +14.3 (−1.2 to +24.1) | −5.1 (−8.1 to 0.0) | −3.0 (−6.1 to 0.0) | −4.3 (−8.4 to +2.9) | +1.7 (−10.7 to +16.7) |

Era set scoring (reference-eras/README.md): **Text** = present + order tests on the first round's pages; **Tables** = table_cell on all pages; **All (scored)** = both of those; **Text around tables** = text tests on the added table pages, shown alone. Page-kind and era slices use the scored tests.

No document text is in this file.
