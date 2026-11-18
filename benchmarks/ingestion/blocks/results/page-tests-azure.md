# Page tests on the Azure runs (exploratory)

Today's Azure runs (11 Nov 2026), graded on the opb page tests (`../opb`: the same reference, scorer and statistics) on the pages that fall inside the 15 documents here: **287 tests on 33 pages from 15 documents**. Only these runs are used: no earlier conversion or grade. The reference side is **Marker 1.10.2 on the A100** (all 15 documents). Made by `page_tests.py`.

**Exploratory, because the sample is small:** 33 pages (one more page of these documents is in the page tests' sample but has no tests), and the scanned pages and the table tests each come from a few documents, so one document can move a slice. Use it to compare hosts and to see whether a parser is clearly ahead or behind; the 1,933-test ranking is `../opb/results/parsers.md`.

| Slice                  | Pages | Tests | Documents |
| ---------------------- | ----: | ----: | --------: |
| All tests              |    33 |   287 |        15 |
| Text tests             |    33 |   258 |        15 |
| Table tests            |     9 |    29 |         8 |
| Digital (text layer)   |    21 |   198 |        11 |
| Scan with a text layer |     6 |    48 |         5 |
| Image-only scan        |     6 |    41 |         4 |

## Reading

- **The host doesn't change the text.** Docling gives identical verdicts on the A100, the T4 and the CPU for every OCR
  choice, and MinerU on the T4 and the A100. Marker 2.1 differs in 1 test between the GPUs, Marker 1.10.2 in 5 of
  287 (T4 −0.3 points, −2.1 to +1.0). The CPU Marker run matches the A100 on the 108 tests of its 5 documents.
  float16 on the T4 costs nothing measurable here.
- **On all tests no side is clearly ahead of or behind the reference** (Marker 1.10.2 on the A100, 251 of 287):
  every interval includes zero. Docling with Tesseract (Norwegian) passes the most, 266 (+5.2, −1.1 to +13.3), then
  MinerU 262 (+3.8), Marker 2.1 252 (+0.3), and Docling with EasyOCR in English, the default image's OCR, the
  fewest, 246 (−1.7).
- **Text tests:** Docling with Tesseract is ahead, +6.6 points (+1.2 to +14.6), the only interval here that leaves
  out zero. MinerU +6.2 and Marker 2.1 +3.5 lean the same way without a clear result.
- **Tables (29 tests, 8 documents): the reference does best,** 72.4; Docling 65.5, MinerU 55.2, Marker 2.1 44.8.
  Too few documents for a trusted interval, but the order matches the 1,933-test page tests.
- **By page kind** (scanned slices from 4 or 5 documents, so hints only): on digital pages every side is within
  about 4 points of the reference. On scans with a text layer the reference is the weakest (79.2), Docling with
  Tesseract the strongest (100.0). On image-only scans the reference is the strongest (90.2); Docling with EasyOCR in
  English drops to 61.0, with Norwegian EasyOCR 78.0, RapidOCR 80.5, Tesseract 85.4.
- **MinerU with and without picture descriptions is the same** on every test: MinerU stored no picture descriptions
  in either run on these documents.

## Every side

Pass rate in percent. The CPU Marker run was stopped by hand after 5 documents; its row covers only their tests.

| Side                                        |  Passed |  All | Text | Tables | Digital | Scan + text layer | Image-only |
| ------------------------------------------- | ------: | ---: | ---: | -----: | ------: | ----------------: | ---------: |
| **Marker 1.10.2, A100**                     | 251/287 | 87.5 | 89.1 |   72.4 |    88.9 |              79.2 |       90.2 |
| Marker 1.10.2, T4                           | 250/287 | 87.1 | 89.5 |   65.5 |    88.9 |              79.2 |       87.8 |
| Marker 1.10.2, CPU                          | 107/108 | 99.1 | 99.0 |  100.0 |   100.0 |              96.7 |      100.0 |
| Marker 2.1, A100                            | 252/287 | 87.8 | 92.6 |   44.8 |    87.9 |              87.5 |       87.8 |
| Marker 2.1, T4                              | 251/287 | 87.5 | 92.2 |   44.8 |    87.9 |              85.4 |       87.8 |
| MinerU 4.1.6, A100                          | 262/287 | 91.3 | 95.3 |   55.2 |    92.9 |              87.5 |       87.8 |
| MinerU 4.1.6, T4                            | 262/287 | 91.3 | 95.3 |   55.2 |    92.9 |              87.5 |       87.8 |
| MinerU 4.1.6, no picture descriptions, A100 | 262/287 | 91.3 | 95.3 |   55.2 |    92.9 |              87.5 |       87.8 |
| MinerU 4.1.6, no picture descriptions, T4   | 262/287 | 91.3 | 95.3 |   55.2 |    92.9 |              87.5 |       87.8 |
| Docling, EasyOCR en, A100                   | 246/287 | 85.7 | 88.0 |   65.5 |    90.4 |              87.5 |       61.0 |
| Docling, EasyOCR en, T4                     | 246/287 | 85.7 | 88.0 |   65.5 |    90.4 |              87.5 |       61.0 |
| Docling, EasyOCR en, CPU                    | 246/287 | 85.7 | 88.0 |   65.5 |    90.4 |              87.5 |       61.0 |
| Docling, EasyOCR no+en, A100                | 257/287 | 89.5 | 92.2 |   65.5 |    91.9 |              89.6 |       78.0 |
| Docling, EasyOCR no+en, T4                  | 257/287 | 89.5 | 92.2 |   65.5 |    91.9 |              89.6 |       78.0 |
| Docling, EasyOCR no+en, CPU                 | 257/287 | 89.5 | 92.2 |   65.5 |    91.9 |              89.6 |       78.0 |
| Docling, Tesseract nor, A100                | 266/287 | 92.7 | 95.7 |   65.5 |    92.4 |             100.0 |       85.4 |
| Docling, Tesseract nor, T4                  | 266/287 | 92.7 | 95.7 |   65.5 |    92.4 |             100.0 |       85.4 |
| Docling, Tesseract nor, CPU                 | 266/287 | 92.7 | 95.7 |   65.5 |    92.4 |             100.0 |       85.4 |
| Docling, RapidOCR, A100                     | 257/287 | 89.5 | 92.2 |   65.5 |    90.4 |              93.8 |       80.5 |
| Docling, RapidOCR, T4                       | 257/287 | 89.5 | 92.2 |   65.5 |    90.4 |              93.8 |       80.5 |
| Docling, RapidOCR, CPU                      | 257/287 | 89.5 | 92.2 |   65.5 |    90.4 |              93.8 |       80.5 |

## Against the reference (Marker 1.10.2 on the A100)

Side minus reference in points, on the tests both have, with the 95% interval from resampling documents; ✱ marks an interval that leaves out zero. † marks a slice from fewer than 10 documents (table tests: 8, scan with a text layer: 5, image-only scan: 4): resampling so few documents gives intervals that can't be trusted, so read only the point difference there, and only as a hint.

| Side                                        | All tests            | Text tests             | Table tests †         | Digital (text layer) | Scan with a text layer † | Image-only scan †      |
| ------------------------------------------- | -------------------- | ---------------------- | --------------------- | -------------------- | ------------------------ | ---------------------- |
| Marker 1.10.2, T4                           | −0.3 (−2.1 to +1.0)  | +0.4 (0.0 to +1.2)     | −6.9 (−21.4 to 0.0)   | 0.0 (0.0 to 0.0)     | 0.0 (0.0 to 0.0)         | −2.4 (−11.8 to +20.0)  |
| Marker 1.10.2, CPU                          | 0.0 (0.0 to 0.0)     | 0.0 (0.0 to 0.0)       | 0.0 (0.0 to 0.0)      | 0.0 (0.0 to 0.0)     | 0.0 (0.0 to 0.0)         | 0.0 (0.0 to 0.0)       |
| Marker 2.1, A100                            | +0.3 (−6.8 to +7.5)  | +3.5 (−3.2 to +10.5)   | −27.6 (−56.0 to −6.1) | −1.0 (−9.4 to +6.6)  | +8.3 (−11.9 to +38.5)    | −2.4 (−17.6 to +40.0)  |
| Marker 2.1, T4                              | 0.0 (−7.0 to +6.9)   | +3.1 (−3.2 to +9.6)    | −27.6 (−56.0 to −6.1) | −1.0 (−9.3 to +6.6)  | +6.2 (−11.9 to +30.8)    | −2.4 (−17.6 to +40.0)  |
| MinerU 4.1.6, A100                          | +3.8 (−4.8 to +13.4) | +6.2 (−1.8 to +15.8)   | −17.2 (−50.0 to +6.9) | +4.0 (−5.9 to +14.2) | +8.3 (−26.7 to +47.7)    | −2.4 (−17.6 to +40.0)  |
| MinerU 4.1.6, T4                            | +3.8 (−4.8 to +13.7) | +6.2 (−1.9 to +15.9)   | −17.2 (−50.0 to +6.9) | +4.0 (−5.9 to +13.9) | +8.3 (−26.7 to +47.7)    | −2.4 (−17.6 to +40.0)  |
| MinerU 4.1.6, no picture descriptions, A100 | +3.8 (−4.9 to +13.5) | +6.2 (−1.9 to +15.9)   | −17.2 (−48.5 to +6.9) | +4.0 (−6.2 to +14.0) | +8.3 (−26.7 to +47.7)    | −2.4 (−17.6 to +40.0)  |
| MinerU 4.1.6, no picture descriptions, T4   | +3.8 (−4.8 to +13.5) | +6.2 (−1.7 to +15.8)   | −17.2 (−50.0 to +6.7) | +4.0 (−5.7 to +13.9) | +8.3 (−26.7 to +47.7)    | −2.4 (−17.6 to +40.0)  |
| Docling, EasyOCR en, A100                   | −1.7 (−11.6 to +8.4) | −1.2 (−11.1 to +9.3)   | −6.9 (−39.3 to +15.4) | +1.5 (−1.5 to +4.8)  | +8.3 (−19.1 to +65.8)    | −29.3 (−39.3 to +40.0) |
| Docling, EasyOCR en, T4                     | −1.7 (−11.7 to +8.5) | −1.2 (−11.0 to +9.6)   | −6.9 (−38.7 to +15.4) | +1.5 (−1.5 to +4.7)  | +8.3 (−18.9 to +65.8)    | −29.3 (−39.3 to +40.0) |
| Docling, EasyOCR en, CPU                    | −1.7 (−11.7 to +8.6) | −1.2 (−11.0 to +9.5)   | −6.9 (−38.5 to +15.4) | +1.5 (−1.5 to +4.8)  | +8.3 (−18.9 to +65.8)    | −29.3 (−39.3 to +40.0) |
| Docling, EasyOCR no+en, A100                | +2.1 (−5.0 to +10.7) | +3.1 (−4.1 to +12.4)   | −6.9 (−40.0 to +15.4) | +3.0 (0.0 to +6.2)   | +10.4 (−12.2 to +63.2)   | −12.2 (−19.7 to +40.0) |
| Docling, EasyOCR no+en, T4                  | +2.1 (−5.1 to +10.8) | +3.1 (−3.9 to +12.3)   | −6.9 (−39.3 to +14.8) | +3.0 (0.0 to +6.2)   | +10.4 (−12.2 to +63.2)   | −12.2 (−19.7 to +40.0) |
| Docling, EasyOCR no+en, CPU                 | +2.1 (−5.1 to +10.9) | +3.1 (−4.1 to +12.4)   | −6.9 (−38.7 to +14.8) | +3.0 (0.0 to +6.3)   | +10.4 (−12.2 to +63.2)   | −12.2 (−19.7 to +40.0) |
| Docling, Tesseract nor, A100                | +5.2 (−1.1 to +13.3) | +6.6 ✱ (+1.2 to +14.6) | −6.9 (−38.7 to +15.4) | +3.5 (0.0 to +7.3)   | +20.8 (+1.9 to +63.5)    | −4.9 (−23.5 to +40.0)  |
| Docling, Tesseract nor, T4                  | +5.2 (−1.1 to +13.1) | +6.6 ✱ (+1.4 to +14.6) | −6.9 (−38.7 to +14.8) | +3.5 (0.0 to +7.4)   | +20.8 (+1.9 to +65.8)    | −4.9 (−23.5 to +40.0)  |
| Docling, Tesseract nor, CPU                 | +5.2 (−1.1 to +13.4) | +6.6 ✱ (+1.2 to +14.7) | −6.9 (−37.9 to +15.4) | +3.5 (0.0 to +7.4)   | +20.8 (+1.9 to +65.8)    | −4.9 (−23.5 to +40.0)  |
| Docling, RapidOCR, A100                     | +2.1 (−5.3 to +10.7) | +3.1 (−3.1 to +11.8)   | −6.9 (−38.5 to +15.4) | +1.5 (−1.5 to +4.8)  | +14.6 (−10.5 to +60.5)   | −9.8 (−35.3 to +40.0)  |
| Docling, RapidOCR, T4                       | +2.1 (−5.3 to +10.5) | +3.1 (−3.2 to +11.7)   | −6.9 (−38.7 to +15.4) | +1.5 (−1.5 to +4.7)  | +14.6 (−10.5 to +60.5)   | −9.8 (−35.3 to +40.0)  |
| Docling, RapidOCR, CPU                      | +2.1 (−5.4 to +10.8) | +3.1 (−3.2 to +11.7)   | −6.9 (−39.3 to +14.8) | +1.5 (−1.5 to +4.8)  | +14.6 (−10.5 to +60.5)   | −9.8 (−35.3 to +40.0)  |

## T4 (float16) against A100 (bfloat16)

The same parser on both GPUs.

| A                                         | B                                           | Tests |    A |    B | A − B, all          | A − B, text        | A − B, scans        | Tests where they differ |
| ----------------------------------------- | ------------------------------------------- | ----: | ---: | ---: | ------------------- | ------------------ | ------------------- | ----------------------: |
| Marker 1.10.2, T4                         | Marker 1.10.2, A100                         |   287 | 87.1 | 87.5 | −0.3 (−2.1 to +1.0) | +0.4 (0.0 to +1.2) | −1.1 (−5.8 to +4.0) |                       5 |
| Marker 2.1, T4                            | Marker 2.1, A100                            |   287 | 87.5 | 87.8 | −0.3 (−1.2 to 0.0)  | −0.4 (−1.3 to 0.0) | −1.1 (−4.1 to 0.0)  |                       1 |
| MinerU 4.1.6, T4                          | MinerU 4.1.6, A100                          |   287 | 91.3 | 91.3 | 0.0 (0.0 to 0.0)    | 0.0 (0.0 to 0.0)   | 0.0 (0.0 to 0.0)    |                       0 |
| MinerU 4.1.6, no picture descriptions, T4 | MinerU 4.1.6, no picture descriptions, A100 |   287 | 91.3 | 91.3 | 0.0 (0.0 to 0.0)    | 0.0 (0.0 to 0.0)   | 0.0 (0.0 to 0.0)    |                       0 |
| Docling, EasyOCR en, T4                   | Docling, EasyOCR en, A100                   |   287 | 85.7 | 85.7 | 0.0 (0.0 to 0.0)    | 0.0 (0.0 to 0.0)   | 0.0 (0.0 to 0.0)    |                       0 |
| Docling, EasyOCR no+en, T4                | Docling, EasyOCR no+en, A100                |   287 | 89.5 | 89.5 | 0.0 (0.0 to 0.0)    | 0.0 (0.0 to 0.0)   | 0.0 (0.0 to 0.0)    |                       0 |
| Docling, Tesseract nor, T4                | Docling, Tesseract nor, A100                |   287 | 92.7 | 92.7 | 0.0 (0.0 to 0.0)    | 0.0 (0.0 to 0.0)   | 0.0 (0.0 to 0.0)    |                       0 |
| Docling, RapidOCR, T4                     | Docling, RapidOCR, A100                     |   287 | 89.5 | 89.5 | 0.0 (0.0 to 0.0)    | 0.0 (0.0 to 0.0)   | 0.0 (0.0 to 0.0)    |                       0 |

## CPU against GPU

The same parser on the CPU host and the A100; Marker only on the 5 documents its CPU run finished.

| A                           | B                            | Tests |    A |    B | A − B, all       | A − B, text      | A − B, scans     | Tests where they differ |
| --------------------------- | ---------------------------- | ----: | ---: | ---: | ---------------- | ---------------- | ---------------- | ----------------------: |
| Marker 1.10.2, CPU          | Marker 1.10.2, A100          |   108 | 99.1 | 99.1 | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) |                       0 |
| Docling, EasyOCR en, CPU    | Docling, EasyOCR en, A100    |   287 | 85.7 | 85.7 | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) |                       0 |
| Docling, EasyOCR no+en, CPU | Docling, EasyOCR no+en, A100 |   287 | 89.5 | 89.5 | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) |                       0 |
| Docling, Tesseract nor, CPU | Docling, Tesseract nor, A100 |   287 | 92.7 | 92.7 | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) |                       0 |
| Docling, RapidOCR, CPU      | Docling, RapidOCR, A100      |   287 | 89.5 | 89.5 | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) | 0.0 (0.0 to 0.0) |                       0 |

## How each page was made

The Azure runs converted whole documents; the page tests grade one page at a time. Each page is cut out of the whole document (`page_tests_extract.py`):

- **Marker 1.10.2 and Marker 2.1:** `markdown.md` split on Marker's page marks `{n}`, the method the page tests' Marker side used (`opb/common_opb.marker_pages`, as genki's page chunker splits Marker's output). The page count matched every document.
- **Docling:** Docling's own `export_to_markdown(page_no=n)` on the stored document.
- **MinerU:** MinerU's own renderer on the stored middle JSON with only that page kept.

## Limits

- A small sample (above); slices by page kind rest on a few documents each.
- The tests check what is on the page; they don't check heading levels, text a parser adds, or page furniture.
- No document text is in this file.

Earlier runs, not used here: the page tests' Mac and pilot sides were graded on the same tests on 11 Nov and agree with these runs within about 1 point for Marker 1.10.2, MinerU and Docling (Marker 2.1 scored lower on the Mac); they are in `../opb/results/`.
