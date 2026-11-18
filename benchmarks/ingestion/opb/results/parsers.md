# Page tests: other parsers vs Marker 1.10.2

1933 tests on 221 pages from 150 Kudos documents, the reference of `report.md`: yes/no facts about each page, written from the page image. Marker 1.10.2 is the current side and every other parser a candidate; the margin is 2 points.

## Answer

Ranked by the headline, tier 1: Docling 2.146, Docling 2.146, RapidOCR, Docling 2.146, Tesseract Norwegian, Docling 2.146, Norwegian OCR, Marker 1.10.2, page by page; tier 2: Docling 2.146, EasyOCR English, Marker 1.10.2, MinerU 4.1.6, MinerU 4.1.6, no picture descriptions, PP-StructureV3; tier 3: PaddleOCR-VL-1.6, Marker 2.1.

- **Marker 2.1**: text tests −0.8 points against Marker 1.10.2 (95% interval −3.3 to +1.8), inconclusive; table tests −31.4 (−44.8 to −18.3), worse. Not shown to be as good as Marker on text tests and table tests.
- **PP-StructureV3**: text tests −4.3 points against Marker 1.10.2 (95% interval −7.2 to −1.3), inconclusive; table tests −18.9 (−30.0 to −8.4), worse. Not shown to be as good as Marker on text tests and table tests.
- **PaddleOCR-VL-1.6**: text tests −2.5 points against Marker 1.10.2 (95% interval −4.8 to 0.0), inconclusive; table tests −26.4 (−38.2 to −15.3), worse. Not shown to be as good as Marker on text tests and table tests.
- **MinerU 4.1.6**: text tests +2.8 points against Marker 1.10.2 (95% interval +0.7 to +5.1), better; table tests −13.2 (−28.0 to −0.7), inconclusive. Not shown to be as good as Marker on table tests.
- **Docling 2.146**: text tests +2.2 points against Marker 1.10.2 (95% interval +0.2 to +4.5), better; table tests +1.3 (−9.5 to +11.4), inconclusive. Not shown to be as good as Marker on table tests.
- **Docling 2.146, Norwegian OCR**: text tests +1.8 points against Marker 1.10.2 (95% interval −0.5 to +4.3), not worse; table tests +0.6 (−10.0 to +10.9), inconclusive. Not shown to be as good as Marker on table tests.
- **Docling 2.146, Tesseract Norwegian**: text tests +3.2 points against Marker 1.10.2 (95% interval +1.2 to +5.5), better; table tests 0.0 (−11.2 to +10.3), inconclusive. Not shown to be as good as Marker on table tests.
- **Docling 2.146, RapidOCR**: text tests +2.2 points against Marker 1.10.2 (95% interval +0.2 to +4.5), better; table tests +1.3 (−9.5 to +11.4), inconclusive. Not shown to be as good as Marker on table tests.
- **Docling 2.146, EasyOCR English**: text tests −0.5 points against Marker 1.10.2 (95% interval −3.4 to +2.5), inconclusive; table tests +0.6 (−10.0 to +10.9), inconclusive. Not shown to be as good as Marker on text tests and table tests.
- **MinerU 4.1.6, no picture descriptions**: text tests +2.8 points against Marker 1.10.2 (95% interval +0.7 to +5.1), better; table tests −13.2 (−28.0 to −0.7), inconclusive. Not shown to be as good as Marker on table tests.
- **Marker 1.10.2, page by page**: text tests +0.1 points against Marker 1.10.2 (95% interval −0.5 to +0.6), not worse; table tests +0.6 (0.0 to +2.1), not worse. It could replace Marker on quality.

Scanned pages are 377 of the 1,933 tests, so a parser can read scans much worse and still pass the rule on all pages (Marker read about one page in ten of the sample from its image). Each candidate on scans, headline, against Marker 1.10.2:

- **Marker 2.1**: scanned pages 71.1 against 90.3, difference −19.2 (−50.4 to +3.7); scans without a text layer 70.6 against 97.7, difference unreliable.
- **PP-StructureV3**: scanned pages 57.6 against 90.3, difference −32.7 (−54.5 to −1.7); scans without a text layer 66.7 against 97.7, difference unreliable.
- **PaddleOCR-VL-1.6**: scanned pages 74.0 against 90.3, difference −16.3 (−32.7 to +5.6); scans without a text layer 83.0 against 97.7, difference unreliable.
- **MinerU 4.1.6**: scanned pages 74.8 against 90.3, difference −15.5 (−46.4 to +7.3); scans without a text layer 71.0 against 97.7, difference unreliable.
- **Docling 2.146**: scanned pages 73.7 against 90.3, difference −16.6 (−48.2 to +7.2); scans without a text layer 68.3 against 97.7, difference unreliable.
- **Docling 2.146, Norwegian OCR**: scanned pages 67.2 against 90.3, difference −23.1 (−48.6 to +4.5); scans without a text layer 56.9 against 97.7, difference unreliable.
- **Docling 2.146, Tesseract Norwegian**: scanned pages 75.2 against 90.3, difference −15.1 (−46.1 to +8.3); scans without a text layer 70.3 against 97.7, difference unreliable.
- **Docling 2.146, RapidOCR**: scanned pages 73.7 against 90.3, difference −16.6 (−48.2 to +7.2); scans without a text layer 68.3 against 97.7, difference unreliable.
- **Docling 2.146, EasyOCR English**: scanned pages 62.9 against 90.3, difference −27.5 (−54.0 to +0.5); scans without a text layer 49.4 against 97.7, difference unreliable.
- **MinerU 4.1.6, no picture descriptions**: scanned pages 74.8 against 90.3, difference −15.5 (−46.4 to +7.3); scans without a text layer 71.0 against 97.7, difference unreliable.
- **Marker 1.10.2, page by page**: scanned pages 90.6 against 90.3, difference +0.3 (0.0 to +0.9); scans without a text layer 98.4 against 97.7, difference unreliable.

These slices are exploratory and part of no rule: the image-only pages come from 12 documents. They are here so a parser that loses scans is not chosen on the all-pages verdict alone.

A candidate could replace Marker 1.10.2 when it is "not worse" or "better" at a 2-point margin on text tests and on table tests: "not worse" needs the whole 95% interval of the paired difference above −2 points.

## Tiers (quality only)

| Tier | Side | Headline | Text tests | Table tests | All tests |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Docling 2.146 | 87.0 | 94.8 | 79.2 | 93.5 |
| 1 | Docling 2.146, RapidOCR | 87.0 | 94.8 | 79.2 | 93.5 |
| 1 | Docling 2.146, Tesseract Norwegian | 86.9 | 95.7 | 78.0 | 94.3 |
| 1 | Docling 2.146, Norwegian OCR | 86.5 | 94.4 | 78.6 | 93.1 |
| 1 | Marker 1.10.2, page by page | 85.6 | 92.6 | 78.6 | 91.5 |
| 2 | Docling 2.146, EasyOCR English | 85.3 | 92.1 | 78.6 | 90.9 |
| 2 | Marker 1.10.2 | 85.3 | 92.6 | 78.0 | 91.4 |
| 2 | MinerU 4.1.6 | 80.1 | 95.4 | 64.8 | 92.9 |
| 2 | MinerU 4.1.6, no picture descriptions | 80.1 | 95.4 | 64.8 | 92.9 |
| 2 | PP-StructureV3 | 73.7 | 88.2 | 59.1 | 85.8 |
| 3 | PaddleOCR-VL-1.6 | 70.8 | 90.1 | 51.6 | 86.9 |
| 3 | Marker 2.1 | 69.2 | 91.8 | 46.5 | 88.0 |

A side starts a new tier only when it is significantly worse than the top of its tier, after correcting for every pair compared.

## Paired differences

Each candidate minus Marker 1.10.2 on the same tests. ✱ marks an interval that leaves out zero; the verdict is against a 2-point margin; *borderline* means the verdict or ✱ changed when rerun with two other seeds; *few documents* means under 20, where intervals run narrow.

### Headline by page kind

| Pages | Candidate | Tests | Documents | Candidate score | Marker 1.10.2 | Candidate − Marker | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| All pages | Marker 2.1 | 1933 | 150 | 69.2 | 85.3 | −16.1 ✱ (−22.9 to −9.2) | worse |
| All pages | PP-StructureV3 | 1933 | 150 | 73.7 | 85.3 | −11.6 ✱ (−17.7 to −5.9) | worse |
| All pages | PaddleOCR-VL-1.6 | 1933 | 150 | 70.8 | 85.3 | −14.4 ✱ (−20.4 to −8.5) | worse |
| All pages | MinerU 4.1.6 | 1933 | 150 | 80.1 | 85.3 | −5.2 (−13.0 to +1.3) | inconclusive |
| All pages | Docling 2.146 | 1933 | 150 | 87.0 | 85.3 | +1.7 (−3.8 to +6.9) | inconclusive |
| All pages | Docling 2.146, Norwegian OCR | 1933 | 150 | 86.5 | 85.3 | +1.2 (−4.4 to +6.5) | inconclusive |
| All pages | Docling 2.146, Tesseract Norwegian | 1933 | 150 | 86.9 | 85.3 | +1.6 (−4.2 to +6.9) | inconclusive |
| All pages | Docling 2.146, RapidOCR | 1933 | 150 | 87.0 | 85.3 | +1.7 (−3.8 to +6.9) | inconclusive |
| All pages | Docling 2.146, EasyOCR English | 1933 | 150 | 85.3 | 85.3 | +0.1 (−5.7 to +5.4) | inconclusive |
| All pages | MinerU 4.1.6, no picture descriptions | 1933 | 150 | 80.1 | 85.3 | −5.2 (−13.0 to +1.3) | inconclusive |
| All pages | Marker 1.10.2, page by page | 1933 | 150 | 85.6 | 85.3 | +0.3 (−0.2 to +1.1) | not worse |
| Typical pages (one random page per document) | Marker 2.1 | 1383 | 150 | 75.5 | 83.3 | −7.8 (−18.5 to +2.9) | inconclusive |
| Typical pages (one random page per document) | PP-StructureV3 | 1383 | 150 | 72.4 | 83.3 | −10.9 ✱ (−19.0 to −3.4) | worse |
| Typical pages (one random page per document) | PaddleOCR-VL-1.6 | 1383 | 150 | 66.6 | 83.3 | −16.8 ✱ (−27.3 to −6.4) | worse |
| Typical pages (one random page per document) | MinerU 4.1.6 | 1383 | 150 | 81.6 | 83.3 | −1.7 (−10.8 to +5.7) | inconclusive |
| Typical pages (one random page per document) | Docling 2.146 | 1383 | 150 | 89.7 | 83.3 | +6.4 (−0.3 to +14.4) | not worse |
| Typical pages (one random page per document) | Docling 2.146, Norwegian OCR | 1383 | 150 | 89.6 | 83.3 | +6.3 (−0.3 to +14.4) | not worse |
| Typical pages (one random page per document) | Docling 2.146, Tesseract Norwegian | 1383 | 150 | 88.8 | 83.3 | +5.5 (−2.1 to +13.9) | inconclusive |
| Typical pages (one random page per document) | Docling 2.146, RapidOCR | 1383 | 150 | 89.7 | 83.3 | +6.4 (−0.3 to +14.4) | not worse |
| Typical pages (one random page per document) | Docling 2.146, EasyOCR English | 1383 | 150 | 88.7 | 83.3 | +5.3 (−1.4 to +13.3) | not worse |
| Typical pages (one random page per document) | MinerU 4.1.6, no picture descriptions | 1383 | 150 | 81.6 | 83.3 | −1.7 (−10.8 to +5.7) | inconclusive |
| Typical pages (one random page per document) | Marker 1.10.2, page by page | 1383 | 150 | 84.0 | 83.3 | +0.7 (−0.1 to +2.4) | not worse |
| Digital pages (text layer in the PDF) | Marker 2.1 | 1556 | 138 | 69.9 | 86.1 | −16.1 ✱ (−23.0 to −9.2) | worse |
| Digital pages (text layer in the PDF) | PP-StructureV3 | 1556 | 138 | 76.0 | 86.1 | −10.1 ✱ (−15.9 to −4.5) | worse |
| Digital pages (text layer in the PDF) | PaddleOCR-VL-1.6 | 1556 | 138 | 70.8 | 86.1 | −15.3 ✱ (−21.8 to −9.2) | worse |
| Digital pages (text layer in the PDF) | MinerU 4.1.6 | 1556 | 138 | 81.0 | 86.1 | −5.1 (−12.8 to +1.4) | inconclusive |
| Digital pages (text layer in the PDF) | Docling 2.146 | 1556 | 138 | 88.6 | 86.1 | +2.5 (−2.4 to +7.3) | inconclusive |
| Digital pages (text layer in the PDF) | Docling 2.146, Norwegian OCR | 1556 | 138 | 88.7 | 86.1 | +2.7 (−2.3 to +7.5) | inconclusive |
| Digital pages (text layer in the PDF) | Docling 2.146, Tesseract Norwegian | 1556 | 138 | 88.1 | 86.1 | +2.1 (−3.2 to +7.0) | inconclusive |
| Digital pages (text layer in the PDF) | Docling 2.146, RapidOCR | 1556 | 138 | 88.6 | 86.1 | +2.5 (−2.4 to +7.3) | inconclusive |
| Digital pages (text layer in the PDF) | Docling 2.146, EasyOCR English | 1556 | 138 | 88.4 | 86.1 | +2.3 (−2.6 to +7.2) | inconclusive |
| Digital pages (text layer in the PDF) | MinerU 4.1.6, no picture descriptions | 1556 | 138 | 81.0 | 86.1 | −5.1 (−12.8 to +1.4) | inconclusive |
| Digital pages (text layer in the PDF) | Marker 1.10.2, page by page | 1556 | 138 | 86.4 | 86.1 | +0.3 (−0.3 to +1.1) | not worse |
| Scanned pages (scan with or without a text layer) | Marker 2.1 | 377 | 42 | 71.1 | 90.3 | −19.2 (−50.4 to +3.7) | inconclusive |
| Scanned pages (scan with or without a text layer) | PP-StructureV3 | 377 | 42 | 57.6 | 90.3 | −32.7 ✱ (−54.5 to −1.7) | inconclusive |
| Scanned pages (scan with or without a text layer) | PaddleOCR-VL-1.6 | 377 | 42 | 74.0 | 90.3 | −16.3 (−32.7 to +5.6) | inconclusive |
| Scanned pages (scan with or without a text layer) | MinerU 4.1.6 | 377 | 42 | 74.8 | 90.3 | −15.5 (−46.4 to +7.3) | inconclusive |
| Scanned pages (scan with or without a text layer) | Docling 2.146 | 377 | 42 | 73.7 | 90.3 | −16.6 (−48.2 to +7.2) | inconclusive |
| Scanned pages (scan with or without a text layer) | Docling 2.146, Norwegian OCR | 377 | 42 | 67.2 | 90.3 | −23.1 (−48.6 to +4.5) | inconclusive |
| Scanned pages (scan with or without a text layer) | Docling 2.146, Tesseract Norwegian | 377 | 42 | 75.2 | 90.3 | −15.1 (−46.1 to +8.3) | inconclusive |
| Scanned pages (scan with or without a text layer) | Docling 2.146, RapidOCR | 377 | 42 | 73.7 | 90.3 | −16.6 (−48.2 to +7.2) | inconclusive |
| Scanned pages (scan with or without a text layer) | Docling 2.146, EasyOCR English | 377 | 42 | 62.9 | 90.3 | −27.5 (−54.0 to +0.5) | inconclusive |
| Scanned pages (scan with or without a text layer) | MinerU 4.1.6, no picture descriptions | 377 | 42 | 74.8 | 90.3 | −15.5 (−46.4 to +7.3) | inconclusive |
| Scanned pages (scan with or without a text layer) | Marker 1.10.2, page by page | 377 | 42 | 90.6 | 90.3 | +0.3 (0.0 to +0.9) | not worse |
| Scans with a text layer (OCR'd PDF) | Marker 2.1 | 242 | 31 | 86.8 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | PP-StructureV3 | 242 | 31 | 50.1 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | PaddleOCR-VL-1.6 | 242 | 31 | 58.9 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | MinerU 4.1.6 | 242 | 31 | 92.3 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | Docling 2.146 | 242 | 31 | 92.1 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | Docling 2.146, Norwegian OCR | 242 | 31 | 92.1 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | Docling 2.146, Tesseract Norwegian | 242 | 31 | 93.3 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | Docling 2.146, RapidOCR | 242 | 31 | 92.1 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | Docling 2.146, EasyOCR English | 242 | 31 | 89.3 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | MinerU 4.1.6, no picture descriptions | 242 | 31 | 92.3 | 86.4 | unreliable | unreliable |
| Scans with a text layer (OCR'd PDF) | Marker 1.10.2, page by page | 242 | 31 | 86.4 | 86.4 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | Marker 2.1 | 135 | 12 | 70.6 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | PP-StructureV3 | 135 | 12 | 66.7 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | PaddleOCR-VL-1.6 | 135 | 12 | 83.0 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | MinerU 4.1.6 | 135 | 12 | 71.0 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | Docling 2.146 | 135 | 12 | 68.3 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | Docling 2.146, Norwegian OCR | 135 | 12 | 56.9 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | Docling 2.146, Tesseract Norwegian | 135 | 12 | 70.3 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | Docling 2.146, RapidOCR | 135 | 12 | 68.3 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | Docling 2.146, EasyOCR English | 135 | 12 | 49.4 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | MinerU 4.1.6, no picture descriptions | 135 | 12 | 71.0 | 97.7 | unreliable | unreliable |
| Scans without a text layer (image only), *few documents* | Marker 1.10.2, page by page | 135 | 12 | 98.4 | 97.7 | unreliable | unreliable |

### Text tests only, by page kind

| Pages | Candidate | Tests | Documents | Candidate score | Marker 1.10.2 | Candidate − Marker | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| All pages | Marker 2.1 | 1774 | 150 | 91.8 | 92.6 | −0.8 (−3.3 to +1.8) | inconclusive |
| All pages | PP-StructureV3 | 1774 | 150 | 88.2 | 92.6 | −4.3 ✱ (−7.2 to −1.2) | inconclusive |
| All pages | PaddleOCR-VL-1.6 | 1774 | 150 | 90.1 | 92.6 | −2.5 (−4.8 to 0.0) | inconclusive |
| All pages | MinerU 4.1.6 | 1774 | 150 | 95.4 | 92.6 | +2.8 ✱ (+0.7 to +5.2) | better |
| All pages | Docling 2.146 | 1774 | 150 | 94.8 | 92.6 | +2.2 ✱ (+0.2 to +4.5) | better |
| All pages | Docling 2.146, Norwegian OCR | 1774 | 150 | 94.4 | 92.6 | +1.8 (−0.5 to +4.4) | not worse |
| All pages | Docling 2.146, Tesseract Norwegian | 1774 | 150 | 95.7 | 92.6 | +3.2 ✱ (+1.2 to +5.5) | better |
| All pages | Docling 2.146, RapidOCR | 1774 | 150 | 94.8 | 92.6 | +2.2 ✱ (+0.2 to +4.5) | better |
| All pages | Docling 2.146, EasyOCR English | 1774 | 150 | 92.1 | 92.6 | −0.5 (−3.5 to +2.5) | inconclusive |
| All pages | MinerU 4.1.6, no picture descriptions | 1774 | 150 | 95.4 | 92.6 | +2.8 ✱ (+0.7 to +5.2) | better |
| All pages | Marker 1.10.2, page by page | 1774 | 150 | 92.6 | 92.6 | +0.1 (−0.5 to +0.6) | not worse |
| Typical pages (one random page per document) | Marker 2.1 | 1312 | 150 | 94.7 | 96.2 | −1.4 (−4.0 to +1.4) | inconclusive |
| Typical pages (one random page per document) | PP-StructureV3 | 1312 | 150 | 91.3 | 96.2 | −4.9 ✱ (−7.6 to −1.8) | inconclusive |
| Typical pages (one random page per document) | PaddleOCR-VL-1.6 | 1312 | 150 | 90.9 | 96.2 | −5.3 ✱ (−7.7 to −2.6) | worse |
| Typical pages (one random page per document) | MinerU 4.1.6 | 1312 | 150 | 97.0 | 96.2 | +0.8 (−1.0 to +3.2) | not worse |
| Typical pages (one random page per document) | Docling 2.146 | 1312 | 150 | 96.3 | 96.2 | +0.2 (−1.8 to +2.5) | not worse |
| Typical pages (one random page per document), *borderline* | Docling 2.146, Norwegian OCR | 1312 | 150 | 96.2 | 96.2 | 0.0 (−2.0 to +2.5) | inconclusive |
| Typical pages (one random page per document) | Docling 2.146, Tesseract Norwegian | 1312 | 150 | 97.3 | 96.2 | +1.1 (−0.7 to +3.6) | not worse |
| Typical pages (one random page per document) | Docling 2.146, RapidOCR | 1312 | 150 | 96.3 | 96.2 | +0.2 (−1.8 to +2.5) | not worse |
| Typical pages (one random page per document) | Docling 2.146, EasyOCR English | 1312 | 150 | 94.2 | 96.2 | −2.0 (−4.6 to +0.8) | inconclusive |
| Typical pages (one random page per document) | MinerU 4.1.6, no picture descriptions | 1312 | 150 | 97.0 | 96.2 | +0.8 (−1.0 to +3.2) | not worse |
| Typical pages (one random page per document) | Marker 1.10.2, page by page | 1312 | 150 | 96.1 | 96.2 | −0.1 (−0.2 to 0.0) | not worse |
| Digital pages (text layer in the PDF) | Marker 2.1 | 1407 | 138 | 94.2 | 95.7 | −1.4 (−3.9 to +1.1) | inconclusive |
| Digital pages (text layer in the PDF) | PP-StructureV3 | 1407 | 138 | 91.6 | 95.7 | −4.1 ✱ (−6.7 to −1.3) | inconclusive |
| Digital pages (text layer in the PDF) | PaddleOCR-VL-1.6 | 1407 | 138 | 90.6 | 95.7 | −5.0 ✱ (−7.1 to −2.8) | worse |
| Digital pages (text layer in the PDF) | MinerU 4.1.6 | 1407 | 138 | 96.9 | 95.7 | +1.2 (−0.8 to +3.5) | not worse |
| Digital pages (text layer in the PDF) | Docling 2.146 | 1407 | 138 | 96.7 | 95.7 | +1.0 (−0.4 to +2.6) | not worse |
| Digital pages (text layer in the PDF) | Docling 2.146, Norwegian OCR | 1407 | 138 | 96.9 | 95.7 | +1.3 (−0.1 to +3.0) | not worse |
| Digital pages (text layer in the PDF) | Docling 2.146, Tesseract Norwegian | 1407 | 138 | 97.1 | 95.7 | +1.4 (−0.1 to +3.2) | not worse |
| Digital pages (text layer in the PDF) | Docling 2.146, RapidOCR | 1407 | 138 | 96.7 | 95.7 | +1.0 (−0.4 to +2.6) | not worse |
| Digital pages (text layer in the PDF) | Docling 2.146, EasyOCR English | 1407 | 138 | 96.3 | 95.7 | +0.6 (−0.9 to +2.2) | not worse |
| Digital pages (text layer in the PDF) | MinerU 4.1.6, no picture descriptions | 1407 | 138 | 96.9 | 95.7 | +1.2 (−0.8 to +3.5) | not worse |
| Digital pages (text layer in the PDF) | Marker 1.10.2, page by page | 1407 | 138 | 95.6 | 95.7 | −0.1 (−0.7 to +0.6) | not worse |
| Scanned pages (scan with or without a text layer) | Marker 2.1 | 367 | 42 | 82.3 | 80.7 | +1.6 (−6.5 to +9.8) | inconclusive |
| Scanned pages (scan with or without a text layer) | PP-StructureV3 | 367 | 42 | 75.2 | 80.7 | −5.4 (−15.1 to +4.8) | inconclusive |
| Scanned pages (scan with or without a text layer) | PaddleOCR-VL-1.6 | 367 | 42 | 88.0 | 80.7 | +7.4 (−0.3 to +17.1) | not worse |
| Scanned pages (scan with or without a text layer) | MinerU 4.1.6 | 367 | 42 | 89.6 | 80.7 | +9.0 ✱ (+2.9 to +16.9) | better |
| Scanned pages (scan with or without a text layer) | Docling 2.146 | 367 | 42 | 87.5 | 80.7 | +6.8 (−0.6 to +16.8) | not worse |
| Scanned pages (scan with or without a text layer) | Docling 2.146, Norwegian OCR | 367 | 42 | 84.5 | 80.7 | +3.8 (−5.1 to +15.1) | inconclusive |
| Scanned pages (scan with or without a text layer) | Docling 2.146, Tesseract Norwegian | 367 | 42 | 90.5 | 80.7 | +9.8 ✱ (+2.7 to +19.0) | better |
| Scanned pages (scan with or without a text layer) | Docling 2.146, RapidOCR | 367 | 42 | 87.5 | 80.7 | +6.8 (−0.6 to +16.8) | not worse |
| Scanned pages (scan with or without a text layer) | Docling 2.146, EasyOCR English | 367 | 42 | 75.7 | 80.7 | −4.9 (−15.8 to +8.9) | inconclusive |
| Scanned pages (scan with or without a text layer) | MinerU 4.1.6, no picture descriptions | 367 | 42 | 89.6 | 80.7 | +9.0 ✱ (+2.9 to +16.9) | better |
| Scanned pages (scan with or without a text layer) | Marker 1.10.2, page by page | 367 | 42 | 81.2 | 80.7 | +0.5 (0.0 to +1.9) | not worse |
| Scans with a text layer (OCR'd PDF) | Marker 2.1 | 239 | 31 | 73.6 | 72.8 | +0.8 (−11.6 to +12.6) | inconclusive |
| Scans with a text layer (OCR'd PDF) | PP-StructureV3 | 239 | 31 | 66.9 | 72.8 | −5.9 (−20.8 to +9.2) | inconclusive |
| Scans with a text layer (OCR'd PDF), *borderline* | PaddleOCR-VL-1.6 | 239 | 31 | 84.5 | 72.8 | +11.7 ✱ (+0.4 to +25.0) | better |
| Scans with a text layer (OCR'd PDF) | MinerU 4.1.6 | 239 | 31 | 84.5 | 72.8 | +11.7 ✱ (+2.3 to +22.7) | better |
| Scans with a text layer (OCR'd PDF) | Docling 2.146 | 239 | 31 | 84.1 | 72.8 | +11.3 ✱ (+0.5 to +25.3) | better |
| Scans with a text layer (OCR'd PDF) | Docling 2.146, Norwegian OCR | 239 | 31 | 84.1 | 72.8 | +11.3 ✱ (+0.7 to +25.6) | better |
| Scans with a text layer (OCR'd PDF) | Docling 2.146, Tesseract Norwegian | 239 | 31 | 86.6 | 72.8 | +13.8 ✱ (+3.4 to +27.0) | better |
| Scans with a text layer (OCR'd PDF) | Docling 2.146, RapidOCR | 239 | 31 | 84.1 | 72.8 | +11.3 ✱ (+0.5 to +25.3) | better |
| Scans with a text layer (OCR'd PDF) | Docling 2.146, EasyOCR English | 239 | 31 | 78.7 | 72.8 | +5.9 (−7.4 to +22.9) | inconclusive |
| Scans with a text layer (OCR'd PDF) | MinerU 4.1.6, no picture descriptions | 239 | 31 | 84.5 | 72.8 | +11.7 ✱ (+2.3 to +22.7) | better |
| Scans with a text layer (OCR'd PDF) | Marker 1.10.2, page by page | 239 | 31 | 72.8 | 72.8 | 0.0 (0.0 to 0.0) | not worse |
| Scans without a text layer (image only), *few documents* | Marker 2.1 | 128 | 12 | 98.4 | 95.3 | +3.1 (0.0 to +10.5) | not worse |
| Scans without a text layer (image only), *few documents* | PP-StructureV3 | 128 | 12 | 90.6 | 95.3 | −4.7 ✱ (−8.9 to −0.8) | inconclusive |
| Scans without a text layer (image only), *few documents* | PaddleOCR-VL-1.6 | 128 | 12 | 94.5 | 95.3 | −0.8 (−5.7 to +8.6) | inconclusive |
| Scans without a text layer (image only), *few documents* | MinerU 4.1.6 | 128 | 12 | 99.2 | 95.3 | +3.9 (0.0 to +12.0) | not worse |
| Scans without a text layer (image only), *few documents* | Docling 2.146 | 128 | 12 | 93.8 | 95.3 | −1.6 (−7.8 to +7.8) | inconclusive |
| Scans without a text layer (image only), *few documents* | Docling 2.146, Norwegian OCR | 128 | 12 | 85.2 | 95.3 | −10.2 (−21.1 to +4.8) | inconclusive |
| Scans without a text layer (image only), *few documents* | Docling 2.146, Tesseract Norwegian | 128 | 12 | 97.7 | 95.3 | +2.3 (−1.5 to +10.5) | not worse |
| Scans without a text layer (image only), *few documents* | Docling 2.146, RapidOCR | 128 | 12 | 93.8 | 95.3 | −1.6 (−7.8 to +7.8) | inconclusive |
| Scans without a text layer (image only), *few documents* | Docling 2.146, EasyOCR English | 128 | 12 | 70.3 | 95.3 | −25.0 ✱ (−35.8 to −7.6) | worse |
| Scans without a text layer (image only), *few documents* | MinerU 4.1.6, no picture descriptions | 128 | 12 | 99.2 | 95.3 | +3.9 (0.0 to +12.0) | not worse |
| Scans without a text layer (image only), *few documents* | Marker 1.10.2, page by page | 128 | 12 | 96.9 | 95.3 | +1.6 (0.0 to +6.4) | not worse |

### By test type

| Test type | Candidate | Tests | Documents | Candidate score | Marker 1.10.2 | Candidate − Marker | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| present | Marker 2.1 | 1362 | 150 | 92.7 | 92.4 | +0.2 (−2.3 to +2.8) | inconclusive |
| present | PP-StructureV3 | 1362 | 150 | 89.1 | 92.4 | −3.4 ✱ (−6.2 to −0.4) | inconclusive |
| present | PaddleOCR-VL-1.6 | 1362 | 150 | 90.8 | 92.4 | −1.6 (−3.8 to +0.8) | inconclusive |
| present | MinerU 4.1.6 | 1362 | 150 | 95.0 | 92.4 | +2.6 ✱ (+0.5 to +4.9) | better |
| present | Docling 2.146 | 1362 | 150 | 94.9 | 92.4 | +2.4 ✱ (+0.5 to +4.7) | better |
| present | Docling 2.146, Norwegian OCR | 1362 | 150 | 94.2 | 92.4 | +1.8 (−0.6 to +4.4) | not worse |
| present | Docling 2.146, Tesseract Norwegian | 1362 | 150 | 95.9 | 92.4 | +3.5 ✱ (+1.6 to +5.7) | better |
| present | Docling 2.146, RapidOCR | 1362 | 150 | 94.9 | 92.4 | +2.4 ✱ (+0.5 to +4.7) | better |
| present | Docling 2.146, EasyOCR English | 1362 | 150 | 92.6 | 92.4 | +0.1 (−2.6 to +3.0) | inconclusive |
| present | MinerU 4.1.6, no picture descriptions | 1362 | 150 | 95.0 | 92.4 | +2.6 ✱ (+0.5 to +4.9) | better |
| present | Marker 1.10.2, page by page | 1362 | 150 | 92.4 | 92.4 | −0.1 (−0.7 to +0.4) | not worse |
| order | Marker 2.1 | 412 | 147 | 88.8 | 93.0 | −4.1 ✱ (−7.9 to −0.5) | inconclusive |
| order | PP-StructureV3 | 412 | 147 | 85.4 | 93.0 | −7.5 ✱ (−12.0 to −3.1) | worse |
| order | PaddleOCR-VL-1.6 | 412 | 147 | 87.6 | 93.0 | −5.3 ✱ (−9.3 to −1.4) | inconclusive |
| order | MinerU 4.1.6 | 412 | 147 | 96.6 | 93.0 | +3.6 ✱ (+0.8 to +6.7) | better |
| order | Docling 2.146 | 412 | 147 | 94.4 | 93.0 | +1.5 (−1.2 to +4.3) | not worse |
| order | Docling 2.146, Norwegian OCR | 412 | 147 | 94.9 | 93.0 | +1.9 (−1.0 to +4.8) | not worse |
| order | Docling 2.146, Tesseract Norwegian | 412 | 147 | 95.1 | 93.0 | +2.2 (−0.5 to +5.0) | not worse |
| order | Docling 2.146, RapidOCR | 412 | 147 | 94.4 | 93.0 | +1.5 (−1.2 to +4.3) | not worse |
| order | Docling 2.146, EasyOCR English | 412 | 147 | 90.3 | 93.0 | −2.7 (−7.2 to +1.2) | inconclusive |
| order | MinerU 4.1.6, no picture descriptions | 412 | 147 | 96.6 | 93.0 | +3.6 ✱ (+0.8 to +6.7) | better |
| order | Marker 1.10.2, page by page | 412 | 147 | 93.4 | 93.0 | +0.5 (0.0 to +1.2) | not worse |
| table_cell | Marker 2.1 | 159 | 40 | 46.5 | 78.0 | −31.4 ✱ (−44.8 to −18.2) | worse |
| table_cell | PP-StructureV3 | 159 | 40 | 59.1 | 78.0 | −18.9 ✱ (−29.9 to −8.2) | worse |
| table_cell | PaddleOCR-VL-1.6 | 159 | 40 | 51.6 | 78.0 | −26.4 ✱ (−38.1 to −14.8) | worse |
| table_cell | MinerU 4.1.6 | 159 | 40 | 64.8 | 78.0 | −13.2 ✱ (−28.6 to −0.7) | inconclusive |
| table_cell | Docling 2.146 | 159 | 40 | 79.2 | 78.0 | +1.3 (−9.5 to +11.2) | inconclusive |
| table_cell | Docling 2.146, Norwegian OCR | 159 | 40 | 78.6 | 78.0 | +0.6 (−10.2 to +10.6) | inconclusive |
| table_cell | Docling 2.146, Tesseract Norwegian | 159 | 40 | 78.0 | 78.0 | 0.0 (−11.2 to +10.3) | inconclusive |
| table_cell | Docling 2.146, RapidOCR | 159 | 40 | 79.2 | 78.0 | +1.3 (−9.5 to +11.2) | inconclusive |
| table_cell | Docling 2.146, EasyOCR English | 159 | 40 | 78.6 | 78.0 | +0.6 (−10.2 to +10.6) | inconclusive |
| table_cell | MinerU 4.1.6, no picture descriptions | 159 | 40 | 64.8 | 78.0 | −13.2 ✱ (−28.6 to −0.7) | inconclusive |
| table_cell | Marker 1.10.2, page by page | 159 | 40 | 78.6 | 78.0 | +0.6 (0.0 to +2.0) | not worse |

### Text tests by what the text is

| Tag | Candidate | Tests | Documents | Candidate score | Marker 1.10.2 | Candidate − Marker | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| heading | Marker 2.1 | 467 | 135 | 94.0 | 94.6 | −0.6 (−4.2 to +2.9) | inconclusive |
| heading | PP-StructureV3 | 467 | 135 | 89.7 | 94.6 | −4.9 ✱ (−9.1 to −0.6) | inconclusive |
| heading | PaddleOCR-VL-1.6 | 467 | 135 | 93.1 | 94.6 | −1.5 (−5.0 to +2.2) | inconclusive |
| heading | MinerU 4.1.6 | 467 | 135 | 96.8 | 94.6 | +2.1 (−0.9 to +5.3) | not worse |
| heading | Docling 2.146 | 467 | 135 | 97.4 | 94.6 | +2.8 (−0.2 to +6.1) | not worse |
| heading | Docling 2.146, Norwegian OCR | 467 | 135 | 97.0 | 94.6 | +2.4 (−0.7 to +5.7) | not worse |
| heading | Docling 2.146, Tesseract Norwegian | 467 | 135 | 98.3 | 94.6 | +3.6 ✱ (+0.9 to +6.8) | better |
| heading | Docling 2.146, RapidOCR | 467 | 135 | 97.4 | 94.6 | +2.8 (−0.2 to +6.1) | not worse |
| heading | Docling 2.146, EasyOCR English | 467 | 135 | 94.6 | 94.6 | 0.0 (−3.8 to +4.0) | inconclusive |
| heading | MinerU 4.1.6, no picture descriptions | 467 | 135 | 96.8 | 94.6 | +2.1 (−0.9 to +5.3) | not worse |
| heading | Marker 1.10.2, page by page | 467 | 135 | 95.1 | 94.6 | +0.4 (0.0 to +1.3) | not worse |
| list | Marker 2.1 | 178 | 51 | 91.0 | 93.3 | −2.2 (−10.2 to +5.8) | inconclusive |
| list | PP-StructureV3 | 178 | 51 | 86.5 | 93.3 | −6.7 (−16.3 to +4.3) | inconclusive |
| list | PaddleOCR-VL-1.6 | 178 | 51 | 93.3 | 93.3 | 0.0 (−7.3 to +8.6) | inconclusive |
| list | MinerU 4.1.6 | 178 | 51 | 98.3 | 93.3 | +5.1 (0.0 to +13.5) | not worse |
| list | Docling 2.146 | 178 | 51 | 94.9 | 93.3 | +1.7 (−4.0 to +9.9) | inconclusive |
| list | Docling 2.146, Norwegian OCR | 178 | 51 | 92.7 | 93.3 | −0.6 (−7.3 to +8.8) | inconclusive |
| list | Docling 2.146, Tesseract Norwegian | 178 | 51 | 97.2 | 93.3 | +3.9 (−2.3 to +12.6) | inconclusive |
| list | Docling 2.146, RapidOCR | 178 | 51 | 94.9 | 93.3 | +1.7 (−4.0 to +9.9) | inconclusive |
| list | Docling 2.146, EasyOCR English | 178 | 51 | 85.4 | 93.3 | −7.9 (−18.5 to +4.5) | inconclusive |
| list | MinerU 4.1.6, no picture descriptions | 178 | 51 | 98.3 | 93.3 | +5.1 (0.0 to +13.5) | not worse |
| list | Marker 1.10.2, page by page | 178 | 51 | 91.6 | 93.3 | −1.7 (−5.4 to 0.0) | inconclusive |
| caption | Marker 2.1 | 107 | 41 | 78.5 | 79.4 | −0.9 (−6.2 to +3.7) | inconclusive |
| caption | PP-StructureV3 | 107 | 41 | 77.6 | 79.4 | −1.9 (−8.5 to +4.3) | inconclusive |
| caption | PaddleOCR-VL-1.6 | 107 | 41 | 84.1 | 79.4 | +4.7 (−5.4 to +16.0) | inconclusive |
| caption | MinerU 4.1.6 | 107 | 41 | 86.0 | 79.4 | +6.5 ✱ (+1.7 to +12.7) | better |
| caption | Docling 2.146 | 107 | 41 | 83.2 | 79.4 | +3.7 (−2.4 to +10.8) | inconclusive |
| caption | Docling 2.146, Norwegian OCR | 107 | 41 | 81.3 | 79.4 | +1.9 (−5.5 to +9.6) | inconclusive |
| caption | Docling 2.146, Tesseract Norwegian | 107 | 41 | 85.0 | 79.4 | +5.6 ✱ (+1.5 to +11.5) | better |
| caption | Docling 2.146, RapidOCR | 107 | 41 | 83.2 | 79.4 | +3.7 (−2.4 to +10.8) | inconclusive |
| caption | Docling 2.146, EasyOCR English | 107 | 41 | 80.4 | 79.4 | +0.9 (−7.5 to +9.4) | inconclusive |
| caption | MinerU 4.1.6, no picture descriptions | 107 | 41 | 86.0 | 79.4 | +6.5 ✱ (+1.7 to +12.7) | better |
| caption | Marker 1.10.2, page by page | 107 | 41 | 79.4 | 79.4 | 0.0 (0.0 to 0.0) | not worse |
| footnote | Marker 2.1 | 56 | 25 | 94.6 | 94.6 | 0.0 (−7.5 to +9.7) | inconclusive |
| footnote | PP-StructureV3 | 56 | 25 | 26.8 | 94.6 | −67.9 ✱ (−82.8 to −51.6) | worse |
| footnote | PaddleOCR-VL-1.6 | 56 | 25 | 26.8 | 94.6 | −67.9 ✱ (−88.2 to −46.0) | worse |
| footnote | MinerU 4.1.6 | 56 | 25 | 100.0 | 94.6 | +5.4 (0.0 to +14.5) | not worse |
| footnote | Docling 2.146 | 56 | 25 | 92.9 | 94.6 | −1.8 (−11.9 to +8.9) | inconclusive |
| footnote | Docling 2.146, Norwegian OCR | 56 | 25 | 94.6 | 94.6 | 0.0 (−10.0 to +10.7) | inconclusive |
| footnote | Docling 2.146, Tesseract Norwegian | 56 | 25 | 89.3 | 94.6 | −5.4 (−18.8 to +8.2) | inconclusive |
| footnote | Docling 2.146, RapidOCR | 56 | 25 | 92.9 | 94.6 | −1.8 (−11.9 to +8.9) | inconclusive |
| footnote | Docling 2.146, EasyOCR English | 56 | 25 | 91.1 | 94.6 | −3.6 (−14.5 to +8.2) | inconclusive |
| footnote | MinerU 4.1.6, no picture descriptions | 56 | 25 | 100.0 | 94.6 | +5.4 (0.0 to +14.5) | not worse |
| footnote | Marker 1.10.2, page by page | 56 | 25 | 94.6 | 94.6 | 0.0 (0.0 to 0.0) | not worse |
| figure, *few documents* | Marker 2.1 | 22 | 18 | 27.3 | 13.6 | +13.6 (0.0 to +33.3) | not worse |
| figure, *few documents* | PP-StructureV3 | 22 | 18 | 9.1 | 13.6 | −4.5 (−15.0 to 0.0) | inconclusive |
| figure, *few documents* | PaddleOCR-VL-1.6 | 22 | 18 | 22.7 | 13.6 | +9.1 (0.0 to +21.7) | not worse |
| figure, *few documents* | MinerU 4.1.6 | 22 | 18 | 22.7 | 13.6 | +9.1 (0.0 to +23.8) | not worse |
| figure, *few documents* | Docling 2.146 | 22 | 18 | 13.6 | 13.6 | 0.0 (−14.3 to +12.5) | inconclusive |
| figure, *few documents* | Docling 2.146, Norwegian OCR | 22 | 18 | 13.6 | 13.6 | 0.0 (−14.3 to +12.5) | inconclusive |
| figure, *few documents* | Docling 2.146, Tesseract Norwegian | 22 | 18 | 13.6 | 13.6 | 0.0 (−14.3 to +12.5) | inconclusive |
| figure, *few documents* | Docling 2.146, RapidOCR | 22 | 18 | 13.6 | 13.6 | 0.0 (−14.3 to +12.5) | inconclusive |
| figure, *few documents* | Docling 2.146, EasyOCR English | 22 | 18 | 13.6 | 13.6 | 0.0 (−14.3 to +12.5) | inconclusive |
| figure, *few documents* | MinerU 4.1.6, no picture descriptions | 22 | 18 | 22.7 | 13.6 | +9.1 (0.0 to +23.8) | not worse |
| figure, *few documents* | Marker 1.10.2, page by page | 22 | 18 | 13.6 | 13.6 | 0.0 (0.0 to 0.0) | not worse |
| multi_column | Marker 2.1 | 493 | 52 | 96.1 | 95.7 | +0.4 (−2.9 to +4.1) | inconclusive |
| multi_column | PP-StructureV3 | 493 | 52 | 93.7 | 95.7 | −2.0 (−6.5 to +2.8) | inconclusive |
| multi_column | PaddleOCR-VL-1.6 | 493 | 52 | 91.5 | 95.7 | −4.3 ✱ (−7.9 to −0.4) | inconclusive |
| multi_column | MinerU 4.1.6 | 493 | 52 | 98.6 | 95.7 | +2.8 (−0.2 to +6.6) | not worse |
| multi_column | Docling 2.146 | 493 | 52 | 96.6 | 95.7 | +0.8 (−1.1 to +3.0) | not worse |
| multi_column | Docling 2.146, Norwegian OCR | 493 | 52 | 96.3 | 95.7 | +0.6 (−1.4 to +2.9) | not worse |
| multi_column | Docling 2.146, Tesseract Norwegian | 493 | 52 | 96.3 | 95.7 | +0.6 (−1.4 to +2.9) | not worse |
| multi_column | Docling 2.146, RapidOCR | 493 | 52 | 96.6 | 95.7 | +0.8 (−1.1 to +3.0) | not worse |
| multi_column | Docling 2.146, EasyOCR English | 493 | 52 | 96.1 | 95.7 | +0.4 (−1.8 to +2.7) | not worse |
| multi_column | MinerU 4.1.6, no picture descriptions | 493 | 52 | 98.6 | 95.7 | +2.8 (−0.2 to +6.6) | not worse |
| multi_column | Marker 1.10.2, page by page | 493 | 52 | 95.1 | 95.7 | −0.6 (−1.8 to 0.0) | not worse |
| table | Marker 2.1 | 124 | 40 | 87.1 | 96.0 | −8.9 (−20.7 to +2.5) | inconclusive |
| table | PP-StructureV3 | 124 | 40 | 89.5 | 96.0 | −6.5 (−15.9 to +0.8) | inconclusive |
| table | PaddleOCR-VL-1.6 | 124 | 40 | 92.7 | 96.0 | −3.2 (−9.4 to +3.1) | inconclusive |
| table | MinerU 4.1.6 | 124 | 40 | 96.0 | 96.0 | 0.0 (−8.6 to +7.1) | inconclusive |
| table | Docling 2.146 | 124 | 40 | 100.0 | 96.0 | +4.0 ✱ (+0.8 to +8.7) | better |
| table | Docling 2.146, Norwegian OCR | 124 | 40 | 99.2 | 96.0 | +3.2 (−0.8 to +8.0) | not worse |
| table | Docling 2.146, Tesseract Norwegian | 124 | 40 | 99.2 | 96.0 | +3.2 (0.0 to +7.6) | not worse |
| table | Docling 2.146, RapidOCR | 124 | 40 | 100.0 | 96.0 | +4.0 ✱ (+0.8 to +8.7) | better |
| table | Docling 2.146, EasyOCR English | 124 | 40 | 99.2 | 96.0 | +3.2 (−0.8 to +8.0) | not worse |
| table | MinerU 4.1.6, no picture descriptions | 124 | 40 | 96.0 | 96.0 | 0.0 (−8.6 to +7.1) | inconclusive |
| table | Marker 1.10.2, page by page | 124 | 40 | 96.0 | 96.0 | 0.0 (0.0 to 0.0) | not worse |
| tiny, *few documents* | Marker 2.1 | 7 | 5 | 14.3 | 14.3 | 0.0 (0.0 to 0.0) | not worse |
| tiny, *few documents* | PP-StructureV3 | 7 | 5 | 14.3 | 14.3 | 0.0 (0.0 to 0.0) | not worse |
| tiny, *few documents* | PaddleOCR-VL-1.6 | 7 | 5 | 28.6 | 14.3 | +14.3 (−50.0 to +66.7) | inconclusive |
| tiny, *few documents* | MinerU 4.1.6 | 7 | 5 | 42.9 | 14.3 | +28.6 (0.0 to +75.0) | not worse |
| tiny, *few documents* | Docling 2.146 | 7 | 5 | 42.9 | 14.3 | +28.6 (0.0 to +60.0) | not worse |
| tiny, *few documents* | Docling 2.146, Norwegian OCR | 7 | 5 | 42.9 | 14.3 | +28.6 (0.0 to +60.0) | not worse |
| tiny, *few documents* | Docling 2.146, Tesseract Norwegian | 7 | 5 | 42.9 | 14.3 | +28.6 (0.0 to +60.0) | not worse |
| tiny, *few documents* | Docling 2.146, RapidOCR | 7 | 5 | 42.9 | 14.3 | +28.6 (0.0 to +60.0) | not worse |
| tiny, *few documents* | Docling 2.146, EasyOCR English | 7 | 5 | 42.9 | 14.3 | +28.6 (0.0 to +60.0) | not worse |
| tiny, *few documents* | MinerU 4.1.6, no picture descriptions | 7 | 5 | 42.9 | 14.3 | +28.6 (0.0 to +75.0) | not worse |
| tiny, *few documents* | Marker 1.10.2, page by page | 7 | 5 | 14.3 | 14.3 | 0.0 (0.0 to 0.0) | not worse |

### Headline by document type

| Document type | Candidate | Tests | Documents | Candidate score | Marker 1.10.2 | Candidate − Marker | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Evaluering, *few documents* | Marker 2.1 | 229 | 19 | 77.9 | 85.0 | −7.2 (−24.5 to +5.6) | inconclusive |
| Evaluering, *few documents* | PP-StructureV3 | 229 | 19 | 68.9 | 85.0 | −16.1 ✱ (−37.3 to −0.5) | inconclusive |
| Evaluering, *few documents* | PaddleOCR-VL-1.6 | 229 | 19 | 82.6 | 85.0 | −2.5 (−11.1 to +4.1) | inconclusive |
| Evaluering, *few documents* | MinerU 4.1.6 | 229 | 19 | 87.9 | 85.0 | +2.8 (0.0 to +7.9) | not worse |
| Evaluering, *few documents* | Docling 2.146 | 229 | 19 | 85.2 | 85.0 | +0.1 (−8.2 to +6.1) | inconclusive |
| Evaluering, *few documents* | Docling 2.146, Norwegian OCR | 229 | 19 | 85.4 | 85.0 | +0.4 (−8.1 to +6.7) | inconclusive |
| Evaluering, *few documents* | Docling 2.146, Tesseract Norwegian | 229 | 19 | 85.2 | 85.0 | +0.1 (−8.6 to +7.1) | inconclusive |
| Evaluering, *few documents* | Docling 2.146, RapidOCR | 229 | 19 | 85.2 | 85.0 | +0.1 (−8.2 to +6.1) | inconclusive |
| Evaluering, *few documents* | Docling 2.146, EasyOCR English | 229 | 19 | 83.5 | 85.0 | −1.5 (−10.6 to +4.9) | inconclusive |
| Evaluering, *few documents* | MinerU 4.1.6, no picture descriptions | 229 | 19 | 87.9 | 85.0 | +2.8 (0.0 to +7.9) | not worse |
| Evaluering, *few documents* | Marker 1.10.2, page by page | 229 | 19 | 85.0 | 85.0 | 0.0 (0.0 to 0.0) | not worse |
| Instruks, *few documents* | Marker 2.1 | 252 | 19 | 95.6 | 98.0 | −2.4 (−5.6 to 0.0) | inconclusive |
| Instruks, *few documents* | PP-StructureV3 | 252 | 19 | 91.3 | 98.0 | −6.7 ✱ (−10.9 to −2.8) | worse |
| Instruks, *few documents* | PaddleOCR-VL-1.6 | 252 | 19 | 94.0 | 98.0 | −4.0 ✱ (−6.3 to −1.5) | inconclusive |
| Instruks, *few documents* | MinerU 4.1.6 | 252 | 19 | 98.4 | 98.0 | +0.4 (−0.9 to +1.8) | not worse |
| Instruks, *few documents* | Docling 2.146 | 252 | 19 | 97.2 | 98.0 | −0.8 (−4.4 to +4.2) | inconclusive |
| Instruks, *few documents* | Docling 2.146, Norwegian OCR | 252 | 19 | 93.7 | 98.0 | −4.4 (−10.3 to +2.1) | inconclusive |
| Instruks, *few documents* | Docling 2.146, Tesseract Norwegian | 252 | 19 | 100.0 | 98.0 | +2.0 (0.0 to +5.9) | not worse |
| Instruks, *few documents* | Docling 2.146, RapidOCR | 252 | 19 | 97.2 | 98.0 | −0.8 (−4.4 to +4.2) | inconclusive |
| Instruks, *few documents* | Docling 2.146, EasyOCR English | 252 | 19 | 85.7 | 98.0 | −12.3 ✱ (−22.5 to −1.5) | inconclusive |
| Instruks, *few documents* | MinerU 4.1.6, no picture descriptions | 252 | 19 | 98.4 | 98.0 | +0.4 (−0.9 to +1.8) | not worse |
| Instruks, *few documents* | Marker 1.10.2, page by page | 252 | 19 | 98.0 | 98.0 | 0.0 (0.0 to 0.0) | not worse |
| Melding til Stortinget, *few documents* | Marker 2.1 | 268 | 19 | 81.3 | 96.9 | −15.6 (−50.6 to +1.3) | inconclusive |
| Melding til Stortinget, *few documents* | PP-StructureV3 | 268 | 19 | 84.3 | 96.9 | −12.6 ✱ (−31.4 to −1.2) | inconclusive |
| Melding til Stortinget, *few documents* | PaddleOCR-VL-1.6 | 268 | 19 | 78.3 | 96.9 | −18.5 ✱ (−41.5 to −2.5) | worse |
| Melding til Stortinget, *few documents* | MinerU 4.1.6 | 268 | 19 | 97.5 | 96.9 | +0.6 (−1.2 to +2.8) | not worse |
| Melding til Stortinget, *few documents* | Docling 2.146 | 268 | 19 | 97.1 | 96.9 | +0.2 (−0.8 to +1.2) | not worse |
| Melding til Stortinget, *few documents* | Docling 2.146, Norwegian OCR | 268 | 19 | 97.1 | 96.9 | +0.2 (−0.8 to +1.2) | not worse |
| Melding til Stortinget, *few documents* | Docling 2.146, Tesseract Norwegian | 268 | 19 | 97.1 | 96.9 | +0.2 (−0.8 to +1.2) | not worse |
| Melding til Stortinget, *few documents* | Docling 2.146, RapidOCR | 268 | 19 | 97.1 | 96.9 | +0.2 (−0.8 to +1.2) | not worse |
| Melding til Stortinget, *few documents* | Docling 2.146, EasyOCR English | 268 | 19 | 97.1 | 96.9 | +0.2 (−0.8 to +1.2) | not worse |
| Melding til Stortinget, *few documents* | MinerU 4.1.6, no picture descriptions | 268 | 19 | 97.5 | 96.9 | +0.6 (−1.2 to +2.8) | not worse |
| Melding til Stortinget, *few documents* | Marker 1.10.2, page by page | 268 | 19 | 96.3 | 96.9 | −0.6 (−1.7 to 0.0) | not worse |
| Proposisjon til Stortinget, *few documents* | Marker 2.1 | 203 | 19 | 71.4 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | PP-StructureV3 | 203 | 19 | 86.1 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | PaddleOCR-VL-1.6 | 203 | 19 | 46.2 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | MinerU 4.1.6 | 203 | 19 | 80.5 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | Docling 2.146 | 203 | 19 | 97.7 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | Docling 2.146, Norwegian OCR | 203 | 19 | 97.7 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | Docling 2.146, Tesseract Norwegian | 203 | 19 | 98.0 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | Docling 2.146, RapidOCR | 203 | 19 | 97.7 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | Docling 2.146, EasyOCR English | 203 | 19 | 96.7 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | MinerU 4.1.6, no picture descriptions | 203 | 19 | 80.5 | 96.7 | unreliable | unreliable |
| Proposisjon til Stortinget, *few documents* | Marker 1.10.2, page by page | 203 | 19 | 96.4 | 96.7 | unreliable | unreliable |
| Statusrapport, *few documents* | Marker 2.1 | 275 | 19 | 69.1 | 84.3 | −15.2 ✱ (−26.3 to −4.0) | worse |
| Statusrapport, *few documents* | PP-StructureV3 | 275 | 19 | 73.9 | 84.3 | −10.4 (−24.5 to +2.9) | inconclusive |
| Statusrapport, *few documents* | PaddleOCR-VL-1.6 | 275 | 19 | 74.1 | 84.3 | −10.2 (−22.7 to +3.7) | inconclusive |
| Statusrapport, *few documents* | MinerU 4.1.6 | 275 | 19 | 71.7 | 84.3 | −12.6 (−28.8 to +4.6) | inconclusive |
| Statusrapport, *few documents* | Docling 2.146 | 275 | 19 | 86.9 | 84.3 | +2.6 (−12.7 to +13.3) | inconclusive |
| Statusrapport, *few documents* | Docling 2.146, Norwegian OCR | 275 | 19 | 86.7 | 84.3 | +2.4 (−12.9 to +13.2) | inconclusive |
| Statusrapport, *few documents* | Docling 2.146, Tesseract Norwegian | 275 | 19 | 87.4 | 84.3 | +3.1 (−12.2 to +13.7) | inconclusive |
| Statusrapport, *few documents* | Docling 2.146, RapidOCR | 275 | 19 | 86.9 | 84.3 | +2.6 (−12.7 to +13.3) | inconclusive |
| Statusrapport, *few documents* | Docling 2.146, EasyOCR English | 275 | 19 | 86.5 | 84.3 | +2.2 (−13.2 to +13.0) | inconclusive |
| Statusrapport, *few documents* | MinerU 4.1.6, no picture descriptions | 275 | 19 | 71.7 | 84.3 | −12.6 (−28.8 to +4.6) | inconclusive |
| Statusrapport, *few documents* | Marker 1.10.2, page by page | 275 | 19 | 84.3 | 84.3 | 0.0 (0.0 to 0.0) | not worse |
| Strategi/plan, *few documents* | Marker 2.1 | 213 | 19 | 62.9 | 94.7 | −31.8 ✱ (−48.2 to −2.6) | worse |
| Strategi/plan, *few documents* | PP-StructureV3 | 213 | 19 | 81.7 | 94.7 | −13.0 (−34.4 to +1.2) | inconclusive |
| Strategi/plan, *few documents* | PaddleOCR-VL-1.6 | 213 | 19 | 72.0 | 94.7 | −22.6 ✱ (−47.9 to −3.0) | worse |
| Strategi/plan, *few documents* | MinerU 4.1.6 | 213 | 19 | 89.9 | 94.7 | −4.7 (−28.8 to +6.1) | inconclusive |
| Strategi/plan, *few documents* | Docling 2.146 | 213 | 19 | 97.5 | 94.7 | +2.8 (−0.8 to +8.0) | not worse |
| Strategi/plan, *few documents* | Docling 2.146, Norwegian OCR | 213 | 19 | 97.5 | 94.7 | +2.8 (−0.8 to +8.0) | not worse |
| Strategi/plan, *few documents* | Docling 2.146, Tesseract Norwegian | 213 | 19 | 97.5 | 94.7 | +2.8 (−0.8 to +8.0) | not worse |
| Strategi/plan, *few documents* | Docling 2.146, RapidOCR | 213 | 19 | 97.5 | 94.7 | +2.8 (−0.8 to +8.0) | not worse |
| Strategi/plan, *few documents* | Docling 2.146, EasyOCR English | 213 | 19 | 97.5 | 94.7 | +2.8 (−0.8 to +8.0) | not worse |
| Strategi/plan, *few documents* | MinerU 4.1.6, no picture descriptions | 213 | 19 | 89.9 | 94.7 | −4.7 (−28.8 to +6.1) | inconclusive |
| Strategi/plan, *few documents* | Marker 1.10.2, page by page | 213 | 19 | 95.4 | 94.7 | +0.8 (0.0 to +2.4) | not worse |
| Tildelingsbrev, *few documents* | Marker 2.1 | 225 | 18 | 70.5 | 81.4 | −10.9 (−25.8 to +3.5) | inconclusive |
| Tildelingsbrev, *few documents* | PP-StructureV3 | 225 | 18 | 73.9 | 81.4 | −7.6 (−19.7 to +4.8) | inconclusive |
| Tildelingsbrev, *few documents* | PaddleOCR-VL-1.6 | 225 | 18 | 64.9 | 81.4 | −16.5 ✱ (−31.0 to −5.2) | worse |
| Tildelingsbrev, *few documents* | MinerU 4.1.6 | 225 | 18 | 84.0 | 81.4 | +2.6 (−0.7 to +8.0) | not worse |
| Tildelingsbrev, *few documents* | Docling 2.146 | 225 | 18 | 81.4 | 81.4 | 0.0 (−8.8 to +8.7) | inconclusive |
| Tildelingsbrev, *few documents* | Docling 2.146, Norwegian OCR | 225 | 18 | 78.4 | 81.4 | −3.0 (−13.6 to +7.1) | inconclusive |
| Tildelingsbrev, *few documents* | Docling 2.146, Tesseract Norwegian | 225 | 18 | 78.3 | 81.4 | −3.1 (−14.5 to +6.9) | inconclusive |
| Tildelingsbrev, *few documents* | Docling 2.146, RapidOCR | 225 | 18 | 81.4 | 81.4 | 0.0 (−8.8 to +8.7) | inconclusive |
| Tildelingsbrev, *few documents* | Docling 2.146, EasyOCR English | 225 | 18 | 78.4 | 81.4 | −3.0 (−12.7 to +6.9) | inconclusive |
| Tildelingsbrev, *few documents* | MinerU 4.1.6, no picture descriptions | 225 | 18 | 84.0 | 81.4 | +2.6 (−0.7 to +8.0) | not worse |
| Tildelingsbrev, *few documents* | Marker 1.10.2, page by page | 225 | 18 | 81.4 | 81.4 | 0.0 (0.0 to 0.0) | not worse |
| Årsrapport, *borderline, few documents* | Marker 2.1 | 268 | 18 | 57.1 | 75.8 | −18.8 (−38.5 to +0.2) | inconclusive |
| Årsrapport, *few documents* | PP-StructureV3 | 268 | 18 | 64.5 | 75.8 | −11.3 (−28.8 to +1.6) | inconclusive |
| Årsrapport, *few documents* | PaddleOCR-VL-1.6 | 268 | 18 | 65.4 | 75.8 | −10.4 (−23.8 to +1.9) | inconclusive |
| Årsrapport, *few documents* | MinerU 4.1.6 | 268 | 18 | 70.2 | 75.8 | −5.6 (−24.7 to +9.7) | inconclusive |
| Årsrapport, *few documents* | Docling 2.146 | 268 | 18 | 81.6 | 75.8 | +5.8 (−19.3 to +28.5) | inconclusive |
| Årsrapport, *few documents* | Docling 2.146, Norwegian OCR | 268 | 18 | 83.2 | 75.8 | +7.4 (−16.5 to +29.2) | inconclusive |
| Årsrapport, *few documents* | Docling 2.146, Tesseract Norwegian | 268 | 18 | 83.2 | 75.8 | +7.4 (−17.1 to +29.4) | inconclusive |
| Årsrapport, *few documents* | Docling 2.146, RapidOCR | 268 | 18 | 81.6 | 75.8 | +5.8 (−19.3 to +28.5) | inconclusive |
| Årsrapport, *few documents* | Docling 2.146, EasyOCR English | 268 | 18 | 81.6 | 75.8 | +5.8 (−19.0 to +28.5) | inconclusive |
| Årsrapport, *few documents* | MinerU 4.1.6, no picture descriptions | 268 | 18 | 70.2 | 75.8 | −5.6 (−24.7 to +9.7) | inconclusive |
| Årsrapport, *few documents* | Marker 1.10.2, page by page | 268 | 18 | 78.1 | 75.8 | +2.3 (0.0 to +7.1) | not worse |

## Where each candidate and Marker disagree

### Marker 2.1

Both pass 1633, only Marker 2.1 69, only Marker 133, both fail 98. Pages the parser failed on: 0.

- Only Marker 2.1 passes, by page kind and test type: digital present 26, scan+text present 21, digital order 8, digital table_cell 7, image-only present 3, scan+text order 3.
- Only Marker passes: digital table_cell 53, digital present 31, digital order 23, scan+text present 16, scan+text order 6, image-only table_cell 4.

Only Marker passes (133), first 10:

- `kudos-102474-p21-t05` (digital, order): "prosedyrar, revisjon av internkontrollar og medarbeidarundersøkingar" before "Verksemda følger utviklinga tett for mellom anna". Why: 'prosedyrar, revisjon av internkont' does not appear before 'Verksemda følger utviklinga tett f'
- `kudos-102474-p34-t04` (digital, table_cell): cell "2 423" (left_heading "Valutatap (disagio)", top_heading "31.12.2023"). Why: cells matching '2 423' found, but: top_heading '' doesn't match '31.12.2023' (0.00)
- `kudos-103606-p3-t02` (digital, present): "Nansen-programmet representerer den største enkeltsatsing i norsk utviklingssamarbeid.". Why: 'Nansen-programmet representerer den største enkeltsatsing i ' not found (best 0.791 < 0.965)
- `kudos-103606-p3-t03` (digital, present): "inkludere hvordan Norge skal samarbeide med andre givere og implementerende partnere på feltet.". Why: 'inkludere hvordan Norge skal samarbeide med andre givere og ' not found (best 0.516 < 0.968)
- `kudos-103606-p3-t04` (digital, order): "sikre kunnskapsbygging og læring underveis i programmet." before "muliggjøre kunnskapsbasert prioritering mellom innsatser.". Why: 'after' text 'muliggjøre kunnskapsbasert prioritering ' not found
- `kudos-103606-p3-t06` (digital, order): "sikre systematisk og robust kunnskap om hva Nansen-programmet oppnår." before "Utarbeide forslag til innretning av en søknadsbasert ordning". Why: 'before' text 'sikre systematisk og robust kunnskap om ' not found
- `kudos-103606-p3-t07` (digital, present): "Styrking av lokale humanitære organisasjoner bidrar til samfunnets motstandskraft og prioriteres i norsk humanitær strategi.". Why: 'Styrking av lokale humanitære organisasjoner bidrar til samf' not found (best 0.661 < 0.968)
- `kudos-103606-p3-t09` (digital, present): "Norad skal utarbeide forslag til en ordning for støtte til institusjonssamarbeid.". Why: 'Norad skal utarbeide forslag til en ordning for støtte til i' not found (best 0.827 < 0.963)
- `kudos-13175-p23-t05` (digital, table_cell): cell "457" (left_heading "Januar 2017", top_heading "Antall utsendte"). Why: cells matching '457' found, but: top_heading '' doesn't match 'antall utsendte' (0.00)
- `kudos-13175-p23-t06` (digital, table_cell): cell "26" (left "495", top_heading "Fullførte skjema, prosent"). Why: cells matching '26' found, but: top_heading '' doesn't match 'fullførte skjema, prosent' (0.00)

Only Marker 2.1 passes (69), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-102474-p1-t04` (image-only, present): "2023". Why: '2023' not found (best 0.000 < 1.000)
- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-103606-p3-t01` (digital, table_cell): cell "Kunnskap, evaluering og læring av Nansen-programmet" (left "Oppdrag nr. 21-2023"). Why: no tables found
- `kudos-103606-p3-t08` (digital, table_cell): cell "Støtte til institusjonssamarbeid med Ukraina" (left "Oppdrag nr. 23-2023"). Why: no tables found
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-16088-p1-t05` (digital, table_cell): cell "202 000 000" (top_heading "Ny tildeling", left "10 000 000"). Why: cells matching '202 000 000' found, but: top_heading 'ny' doesn't match 'ny tildeling' (0.31)
- `kudos-17208-p18-t03` (digital, table_cell): cell "13 093" (left_heading "Sogn og Fjordane", top_heading "Investering per innbygger (kroner)"). Why: cells matching '13 093' found, but: top_heading '' doesn't match 'investering per innbygger (kroner)' (0.00); left_heading 'sogn og' does...
- `kudos-17208-p18-t04` (digital, table_cell): cell "1 814" (left_heading "Troms", top_heading "Investering (millioner kroner)"). Why: cells matching '1 814' found, but: top_heading '' doesn't match 'investering (millioner kroner)' (0.00)

### PP-StructureV3

Both pass 1588, only PP-StructureV3 71, only Marker 178, both fail 96. Pages the parser failed on: 0.

- Only PP-StructureV3 passes, by page kind and test type: digital present 25, scan+text present 22, digital order 11, digital table_cell 6, scan+text order 6, image-only present 1.
- Only Marker passes: digital present 60, digital order 33, digital table_cell 30, scan+text present 29, scan+text order 13, image-only present 5.

Only Marker passes (178), first 10:

- `kudos-102474-p1-t01` (image-only, present): "NASJONALBIBLIOTEKET". Why: 'NASJONALBIBLIOTEKET' not found (best 0.167 < 1.000)
- `kudos-102474-p34-t05` (digital, order): "Sum finanskostnader" before "NOTE 7 SAMMENHENG MELLOM AVREGNET MED STATSKASSEN". Why: 'after' text 'NOTE 7 SAMMENHENG MELLOM AVREGNET MED ST' not found
- `kudos-102474-p34-t06` (digital, table_cell): cell "67 703 716" (left_heading "Avregnet med statskassen i balansen", top_heading "31.12.2022"). Why: no cell matching '67 703 716' in any table
- `kudos-103411-p1-t04` (digital, order): "Vår ref" before "22/2452-". Why: 'after' text '22/2452-' not found
- `kudos-103767-p1-t01` (scan+text, present): "Supplerende tildelingsbrev nr. 1 2024 for UNE". Why: 'Supplerende tildelingsbrev nr. 1 2024 for UNE' not found (best 0.644 < 0.978)
- `kudos-103767-p1-t05` (scan+text, table_cell): cell "12 113" (left_heading "Post 01", top_heading "(i 1000 kroner)"). Why: cells matching '12 113' found, but: top_heading '' doesn't match '(i 1000 kroner)' (0.00); left_heading 'driftsutgifter, kan nyttes under...
- `kudos-103767-p1-t07` (scan+text, table_cell): cell "307 446" (left_heading "Sum"). Why: cells matching '307 446' found, but: left_heading '' doesn't match 'sum' (0.00)
- `kudos-12278-p3-t06` (digital, present): "Ny statusrapportering for grønn eksport og videreføring av arbeidet med grønn konkurransekraft". Why: 'Ny statusrapportering for grønn eksport og videreføring av a' not found (best 0.633 < 0.957)
- `kudos-14150-p237-t02` (digital, present): "Intervjuer: Men opplever du at dere har nok kompetanse på det eller?". Why: 'Intervjuer: Men opplever du at dere har nok kompetanse på de' not found (best 0.544 < 0.971)
- `kudos-14150-p237-t09` (digital, order): "Mange formulerte seg på lignende måter som denne" before "Se referanse i fotnote over.". Why: 'after' text 'Se referanse i fotnote over.' not found

Only PP-StructureV3 passes (71), first 10:

- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-103606-p3-t01` (digital, table_cell): cell "Kunnskap, evaluering og læring av Nansen-programmet" (left "Oppdrag nr. 21-2023"). Why: no tables found
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-16088-p1-t05` (digital, table_cell): cell "202 000 000" (top_heading "Ny tildeling", left "10 000 000"). Why: cells matching '202 000 000' found, but: top_heading 'ny' doesn't match 'ny tildeling' (0.31)
- `kudos-16088-p1-t06` (digital, table_cell): cell "230 170 000" (top_heading "Tidligere tildelt", up "192 000 000"). Why: cells matching '230 170 000' found, but: top_heading 'tidligere' doesn't match 'tidligere tildelt' (0.72)
- `kudos-185498-p86-t02` (scan+text, present): "Foto: Ole Berg-Rusten / NTB". Why: 'Foto: Ole Berg-Rusten / NTB' not found (best 0.000 < 0.963)
- `kudos-18590-p1-t03` (digital, present): "MENON-PUBLIKASJON NR. 18/2020". Why: 'MENON-PUBLIKASJON NR. 18/2020' not found (best 0.407 < 0.966)
- `kudos-19325-p30-t02` (digital, present): "Tabell A – hovedlønnstabell, se vedlegg 1". Why: 'Tabell A – hovedlønnstabell, se vedlegg 1' not found (best 0.943 < 0.976)
- `kudos-19469-p3-t01` (digital, present): "Proposisjonens hovedinnhold". Why: 'Proposisjonens hovedinnhold' not found (best 0.778 < 0.963)
- `kudos-19469-p3-t02` (digital, present): "Gjeldende rett og bakgrunnen for lovforslaget". Why: 'Gjeldende rett og bakgrunnen for lovforslaget' not found (best 0.756 < 0.956)

### PaddleOCR-VL-1.6

Both pass 1599, only PaddleOCR-VL-1.6 81, only Marker 167, both fail 86. Pages the parser failed on: 0.

- Only PaddleOCR-VL-1.6 passes, by page kind and test type: scan+text present 32, digital present 21, scan+text order 9, digital order 9, digital table_cell 6, image-only present 3.
- Only Marker passes: digital present 65, digital table_cell 44, digital order 36, scan+text present 9, scan+text order 4, image-only present 4.

Only Marker passes (167), first 10:

- `kudos-102474-p34-t04` (digital, table_cell): cell "2 423" (left_heading "Valutatap (disagio)", top_heading "31.12.2023"). Why: cells matching '2 423' found, but: top_heading '31.12.2022' doesn't match '31.12.2023' (0.90)
- `kudos-102474-p34-t06` (digital, table_cell): cell "67 703 716" (left_heading "Avregnet med statskassen i balansen", top_heading "31.12.2022"). Why: cells matching '67 703 716' found, but: top_heading 'endring *' doesn't match '31.12.2022' (0.00)
- `kudos-102474-p34-t09` (digital, present): "Det er endringer på konto 1990 (Mellomværende statskassen) og 1993 (korrigering avsetning feriepenger)". Why: 'Det er endringer på konto 1990 (Mellomværende statskassen) o' not found (best 0.510 < 0.971)
- `kudos-103767-p1-t06` (scan+text, table_cell): cell "300 064" (left_heading "Post 01", down "7 382"). Why: no cell matching '300 064' in any table
- `kudos-103767-p1-t07` (scan+text, table_cell): cell "307 446" (left_heading "Sum"). Why: no cell matching '307 446' in any table
- `kudos-103767-p1-t08` (scan+text, present): "7 382". Why: '7 382' not found (best 0.500 < 1.000)
- `kudos-103767-p1-t09` (scan+text, order): "Følgende ubrukt bevilgning er overført fra 2023 til 2024" before "Midlene er knyttet til forskyvninger i oppgaver og betalinger". Why: 'after' text 'Midlene er knyttet til forskyvninger i o' not found
- `kudos-12278-p38-t07` (digital, present): "Mer informasjon om Norges handelsavtaler på regjeringen.no". Why: 'Mer informasjon om Norges handelsavtaler på regjeringen.no' not found (best 0.621 < 0.966)
- `kudos-12278-p38-t08` (digital, order): "bedrifter får samme markedsadgang som konkurrenter" before "Mer informasjon om Norges handelsavtaler". Why: 'after' text 'Mer informasjon om Norges handelsavtaler' not found
- `kudos-14150-p237-t09` (digital, order): "Mange formulerte seg på lignende måter som denne" before "Se referanse i fotnote over.". Why: 'after' text 'Se referanse i fotnote over.' not found

Only PaddleOCR-VL-1.6 passes (81), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-102474-p1-t04` (image-only, present): "2023". Why: '2023' not found (best 0.000 < 1.000)
- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-103606-p3-t01` (digital, table_cell): cell "Kunnskap, evaluering og læring av Nansen-programmet" (left "Oppdrag nr. 21-2023"). Why: no tables found
- `kudos-12278-p18-t01` (scan+text, present): "Fellesutstillingen Norwegian Presence under designuken i Milano i 2019.". Why: 'Fellesutstillingen Norwegian Presence under designuken i Mil' not found (best 0.000 < 0.958)
- `kudos-12278-p18-t02` (scan+text, present): "Den norske fellesutstillingen ledes av Design og arkitektur Norge (DOGA)". Why: 'Den norske fellesutstillingen ledes av Design og arkitektur ' not found (best 0.000 < 0.958)
- `kudos-12278-p18-t03` (scan+text, order): "under designuken i Milano i 2019" before "viktig arena for norske møbelprodusenter". Why: 'before' text 'under designuken i Milano i 2019' not found
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-17208-p18-t03` (digital, table_cell): cell "13 093" (left_heading "Sogn og Fjordane", top_heading "Investering per innbygger (kroner)"). Why: cells matching '13 093' found, but: top_heading '' doesn't match 'investering per innbygger (kroner)' (0.00); left_heading 'sogn og' does...

### MinerU 4.1.6

Both pass 1708, only MinerU 4.1.6 87, only Marker 58, both fail 80. Pages the parser failed on: 0.

- Only MinerU 4.1.6 passes, by page kind and test type: digital present 31, scan+text present 25, digital order 12, digital table_cell 7, scan+text order 7, image-only present 4.
- Only Marker passes: digital table_cell 24, digital present 22, digital order 4, image-only table_cell 4, scan+text present 3, scan+text order 1.

Only Marker passes (58), first 10:

- `kudos-157389-p23-t08` (digital, table_cell): cell "6,9" (top_heading "Endring i pst.", left "31 172 588"). Why: no cell matching '6,9' in any table
- `kudos-157389-p23-t09` (digital, table_cell): cell "29 360 068" (top_heading "Rekneskap 2023", left "Sum under departementet"). Why: no cell matching '29 360 068' in any table
- `kudos-17208-p15-t04` (digital, table_cell): cell "2 998" (left_heading "Rogaland", top_heading "Investeringer (millioner kroner)"). Why: cells matching '2 998' found, but: top_heading 'nvesteringer s (millioner kroner)' doesn't match 'investeringer (millioner kroner)' (0.97)
- `kudos-17208-p15-t06` (digital, table_cell): cell "370" (left_heading "Møre og Romsdal", top_heading "Søknadssum (millioner kroner)"). Why: cells matching '370' found, but: top_heading 'øknadssum (millioner kroner)' doesn't match 'søknadssum (millioner kroner)' (0.98)
- `kudos-17208-p15-t07` (digital, table_cell): cell "53" (left_heading "Finnmark", top_heading "Antall søknader"). Why: cells matching '53' found, but: top_heading 'i antall søknader' doesn't match 'antall søknader' (0.97)
- `kudos-17208-p15-t08` (digital, table_cell): cell "29 819" (left "3 466", right "5 807"). Why: no cell matching '29 819' in any table
- `kudos-17208-p15-t09` (digital, present): "1 572". Why: '1 572' not found digit-for-digit
- `kudos-17208-p18-t06` (digital, table_cell): cell "30 853" (left "5 888", right "5 791"). Why: no cell matching '30 853' in any table
- `kudos-17869-p1-t10` (digital, present): "Finansdepartementet fastsetter denne instruksen med virkning fra 1. januar 2020.". Why: 'Finansdepartementet fastsetter denne instruksen med virkning' not found (best 0.600 < 0.963)
- `kudos-17959-p49-t01` (scan+text, present): "26.04.2021". Why: '26.04.2021' not found (best 0.400 < 1.000)

Only MinerU 4.1.6 passes (87), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-102474-p1-t04` (image-only, present): "2023". Why: '2023' not found (best 0.000 < 1.000)
- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-103606-p3-t01` (digital, table_cell): cell "Kunnskap, evaluering og læring av Nansen-programmet" (left "Oppdrag nr. 21-2023"). Why: no tables found
- `kudos-103606-p3-t08` (digital, table_cell): cell "Støtte til institusjonssamarbeid med Ukraina" (left "Oppdrag nr. 23-2023"). Why: no tables found
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-17208-p18-t04` (digital, table_cell): cell "1 814" (left_heading "Troms", top_heading "Investering (millioner kroner)"). Why: cells matching '1 814' found, but: top_heading '' doesn't match 'investering (millioner kroner)' (0.00)
- `kudos-17208-p18-t05` (digital, table_cell): cell "608" (left_heading "Trøndelag", top_heading "Antall nye søknader 2016-2019"). Why: cells matching '608' found, but: top_heading 'antall' doesn't match 'antall nye søknader 2016-2019' (0.38)
- `kudos-17208-p18-t11` (digital, present): "Spillemiddelandel nye søknader 2016-19". Why: 'Spillemiddelandel nye søknader 2016-19' not found (best 0.743 < 0.974)

### Docling 2.146

Both pass 1720, only Docling 2.146 87, only Marker 46, both fail 80. Pages the parser failed on: 0.

- Only Docling 2.146 passes, by page kind and test type: scan+text present 31, digital present 22, digital table_cell 13, digital order 8, scan+text order 8, image-only present 4.
- Only Marker passes: digital present 10, scan+text present 9, digital table_cell 7, digital order 6, image-only present 5, image-only table_cell 4.

Only Marker passes (46), first 10:

- `kudos-157389-p23-t06` (digital, order): "inntektsløyvingar frå avdrag, renter og utbytte i Statskog SF." before "Utgifter fordelte på postgrupper". Why: 'inntektsløyvingar frå avdrag, rent' does not appear before 'Utgifter fordelte på postgrupper'
- `kudos-17959-p49-t04` (scan+text, present): "Revisjon av årsregnskapet for Nidaros domkirkes restaureringsarbeider 2020". Why: 'Revisjon av årsregnskapet for Nidaros domkirkes restaurering' not found (best 0.791 < 0.973)
- `kudos-17959-p49-t09` (scan+text, present): "Bestemmelser om økonomistyring i staten punkt 2.3.3". Why: 'Bestemmelser om økonomistyring i staten punkt 2.3.3' not found (best 0.490 < 0.961)
- `kudos-19325-p30-t04` (digital, present): "Det føres lokale forhandlinger på forhandlingsstedet jf. pkt. 2.2, dersom en av følgende betingelser er oppfylt". Why: 'Det føres lokale forhandlinger på forhandlingsstedet jf. pkt' not found (best 0.658 < 0.964)
- `kudos-19553-p5-t06` (digital, present): "Comprehensive and user-friendly access to policy instruments". Why: 'Comprehensive and user-friendly access to policy instruments' not found (best 0.683 < 0.967)
- `kudos-19553-p5-t08` (digital, present): "Policy instruments for innovation". Why: 'Policy instruments for innovation' not found (best 0.800 < 0.970)
- `kudos-19557-p5-t09` (digital, present): "Sametingets årsmelding 2019". Why: 'Sametingets årsmelding 2019' not found (best 0.520 < 0.963)
- `kudos-213997-p2-t10` (digital, present): "Departementenes sikkerhets- og serviceorganisasjon". Why: 'Departementenes sikkerhets- og serviceorganisasjon' not found (best 0.500 < 0.958)
- `kudos-23102-p4-t06` (image-only, present): "Norsk Polarinstitutt skal ivareta forskningsinfrastruktur og tilby logistikk- og støttetjenester knyttet til forskningsaktivitet i Arktis og Antarktis.". Why: 'Norsk Polarinstitutt skal ivareta forskningsinfrastruktur og' not found (best 0.657 < 0.973)
- `kudos-23102-p4-t07` (image-only, present): "Drive logistikkruter for varer og personell til Trollstasjonen i Antarktis med båt og fly.". Why: 'Drive logistikkruter for varer og personell til Trollstasjon' not found (best 0.578 < 0.967)

Only Docling 2.146 passes (87), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-102474-p1-t04` (image-only, present): "2023". Why: '2023' not found (best 0.000 < 1.000)
- `kudos-102474-p34-t02` (digital, table_cell): cell "206 932 833" (left_heading "Kostnadsført leiebetaling for perioden", top_heading "SUM"). Why: cells matching '206 932 833' found, but: top_heading '' doesn't match 'sum' (0.00); top_heading '' doesn't match 'sum' (0.00)
- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-16088-p1-t05` (digital, table_cell): cell "202 000 000" (top_heading "Ny tildeling", left "10 000 000"). Why: cells matching '202 000 000' found, but: top_heading 'ny' doesn't match 'ny tildeling' (0.31)
- `kudos-16088-p1-t06` (digital, table_cell): cell "230 170 000" (top_heading "Tidligere tildelt", up "192 000 000"). Why: cells matching '230 170 000' found, but: top_heading 'tidligere' doesn't match 'tidligere tildelt' (0.72)
- `kudos-17208-p18-t03` (digital, table_cell): cell "13 093" (left_heading "Sogn og Fjordane", top_heading "Investering per innbygger (kroner)"). Why: cells matching '13 093' found, but: top_heading '' doesn't match 'investering per innbygger (kroner)' (0.00); left_heading 'sogn og' does...
- `kudos-17208-p18-t04` (digital, table_cell): cell "1 814" (left_heading "Troms", top_heading "Investering (millioner kroner)"). Why: cells matching '1 814' found, but: top_heading '' doesn't match 'investering (millioner kroner)' (0.00)

### Docling 2.146, Norwegian OCR

Both pass 1712, only Docling 2.146, Norwegian OCR 87, only Marker 54, both fail 80. Pages the parser failed on: 0.

- Only Docling 2.146, Norwegian OCR passes, by page kind and test type: scan+text present 30, digital present 23, digital table_cell 13, digital order 8, scan+text order 8, image-only present 4.
- Only Marker passes: image-only present 15, digital present 9, scan+text present 9, digital table_cell 7, image-only table_cell 5, digital order 4.

Only Marker passes (54), first 10:

- `kudos-157389-p23-t06` (digital, order): "inntektsløyvingar frå avdrag, renter og utbytte i Statskog SF." before "Utgifter fordelte på postgrupper". Why: 'inntektsløyvingar frå avdrag, rent' does not appear before 'Utgifter fordelte på postgrupper'
- `kudos-19325-p30-t01` (digital, present): "Endringer i Hovedtariffavtalen i staten 16. september 2020 - 30. april 2022, 2. avtaleår". Why: 'Endringer i Hovedtariffavtalen i staten 16. september 2020 -' not found (best 0.947 < 0.966)
- `kudos-19553-p5-t06` (digital, present): "Comprehensive and user-friendly access to policy instruments". Why: 'Comprehensive and user-friendly access to policy instruments' not found (best 0.683 < 0.967)
- `kudos-19553-p5-t08` (digital, present): "Policy instruments for innovation". Why: 'Policy instruments for innovation' not found (best 0.800 < 0.970)
- `kudos-19557-p5-t09` (digital, present): "Sametingets årsmelding 2019". Why: 'Sametingets årsmelding 2019' not found (best 0.520 < 0.963)
- `kudos-213997-p2-t10` (digital, present): "Departementenes sikkerhets- og serviceorganisasjon". Why: 'Departementenes sikkerhets- og serviceorganisasjon' not found (best 0.500 < 0.958)
- `kudos-23102-p4-t02` (image-only, present): "Delta i det norsk-russiske miljøsamarbeidet.". Why: 'Delta i det norsk-russiske miljøsamarbeidet.' not found (best 0.950 < 0.977)
- `kudos-23102-p8-t03` (image-only, present): "4.4.2 Forebyggende sikkerhet". Why: '4.4.2 Forebyggende sikkerhet' not found (best 0.857 < 0.964)
- `kudos-31205-p18-t04` (scan+text, present): "Nivå 2: Det operasjonelle nivå – aktuelle direktorater, etater og tilsyn som har viktige beredskapsoppgaver". Why: 'Nivå 2: Det operasjonelle nivå – aktuelle direktorater, etat' not found (best 0.914 < 0.963)
- `kudos-31321-p1-t03` (digital, present): "6. oktober 2022". Why: '6. oktober 2022' not found (best 0.400 < 1.000)

Only Docling 2.146, Norwegian OCR passes (87), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-102474-p1-t04` (image-only, present): "2023". Why: '2023' not found (best 0.000 < 1.000)
- `kudos-102474-p34-t02` (digital, table_cell): cell "206 932 833" (left_heading "Kostnadsført leiebetaling for perioden", top_heading "SUM"). Why: cells matching '206 932 833' found, but: top_heading '' doesn't match 'sum' (0.00); top_heading '' doesn't match 'sum' (0.00)
- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-16088-p1-t05` (digital, table_cell): cell "202 000 000" (top_heading "Ny tildeling", left "10 000 000"). Why: cells matching '202 000 000' found, but: top_heading 'ny' doesn't match 'ny tildeling' (0.31)
- `kudos-16088-p1-t06` (digital, table_cell): cell "230 170 000" (top_heading "Tidligere tildelt", up "192 000 000"). Why: cells matching '230 170 000' found, but: top_heading 'tidligere' doesn't match 'tidligere tildelt' (0.72)
- `kudos-17208-p18-t03` (digital, table_cell): cell "13 093" (left_heading "Sogn og Fjordane", top_heading "Investering per innbygger (kroner)"). Why: cells matching '13 093' found, but: top_heading '' doesn't match 'investering per innbygger (kroner)' (0.00); left_heading 'sogn og' does...
- `kudos-17208-p18-t04` (digital, table_cell): cell "1 814" (left_heading "Troms", top_heading "Investering (millioner kroner)"). Why: cells matching '1 814' found, but: top_heading '' doesn't match 'investering (millioner kroner)' (0.00)

### Docling 2.146, Tesseract Norwegian

Both pass 1737, only Docling 2.146, Tesseract Norwegian 85, only Marker 29, both fail 82. Pages the parser failed on: 0.

- Only Docling 2.146, Tesseract Norwegian passes, by page kind and test type: scan+text present 30, digital present 23, digital table_cell 13, digital order 8, scan+text order 7, image-only present 3.
- Only Marker passes: digital table_cell 9, digital present 7, digital order 4, image-only table_cell 4, scan+text present 2, scan+text order 2.

Only Marker passes (29), first 10:

- `kudos-157389-p23-t06` (digital, order): "inntektsløyvingar frå avdrag, renter og utbytte i Statskog SF." before "Utgifter fordelte på postgrupper". Why: 'inntektsløyvingar frå avdrag, rent' does not appear before 'Utgifter fordelte på postgrupper'
- `kudos-19553-p5-t06` (digital, present): "Comprehensive and user-friendly access to policy instruments". Why: 'Comprehensive and user-friendly access to policy instruments' not found (best 0.683 < 0.967)
- `kudos-19553-p5-t08` (digital, present): "Policy instruments for innovation". Why: 'Policy instruments for innovation' not found (best 0.800 < 0.970)
- `kudos-19557-p5-t09` (digital, present): "Sametingets årsmelding 2019". Why: 'Sametingets årsmelding 2019' not found (best 0.520 < 0.963)
- `kudos-213997-p2-t10` (digital, present): "Departementenes sikkerhets- og serviceorganisasjon". Why: 'Departementenes sikkerhets- og serviceorganisasjon' not found (best 0.500 < 0.958)
- `kudos-24886-p2-t01` (digital, table_cell): cell "529 090" (left "Spesielle driftsutgifter", right "39 111"). Why: cells matching '529 090' found, but: left 'spesielle driftsutgifter |' doesn't match 'spesielle driftsutgifter' (0.98)
- `kudos-24886-p2-t02` (digital, table_cell): cell "Spesielle driftsutgifter" (left "21"). Why: no cell matching 'Spesielle driftsutgifter' in any table
- `kudos-31205-p18-t08` (scan+text, present): "Meld. St. 10 (2016–2017) Risiko i et trygt samfunn -- Samfunnssikkerhet". Why: 'Meld. St. 10 (2016–2017) Risiko i et trygt samfunn -- Samfunn' not found (best 0.417 < 0.957)
- `kudos-31205-p18-t09` (scan+text, present): "Justis- og beredskapsdepartementet; Hovedinstruks for politidirektøren, 16.1.2018". Why: 'Justis- og beredskapsdepartementet; Hovedinstruks for politi' not found (best 0.635 < 0.962)
- `kudos-31205-p18-t10` (scan+text, order): "antas å medføre politisk oppmerksomhet eller større medieomtale." before "Politidirektoratet; PBS 1 Retningslinjer for politiets beredskap". Why: 'after' text 'Politidirektoratet; PBS 1 Retningslinjer' not found

Only Docling 2.146, Tesseract Norwegian passes (85), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-102474-p1-t04` (image-only, present): "2023". Why: '2023' not found (best 0.000 < 1.000)
- `kudos-102474-p34-t02` (digital, table_cell): cell "206 932 833" (left_heading "Kostnadsført leiebetaling for perioden", top_heading "SUM"). Why: cells matching '206 932 833' found, but: top_heading '' doesn't match 'sum' (0.00); top_heading '' doesn't match 'sum' (0.00)
- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-16088-p1-t05` (digital, table_cell): cell "202 000 000" (top_heading "Ny tildeling", left "10 000 000"). Why: cells matching '202 000 000' found, but: top_heading 'ny' doesn't match 'ny tildeling' (0.31)
- `kudos-16088-p1-t06` (digital, table_cell): cell "230 170 000" (top_heading "Tidligere tildelt", up "192 000 000"). Why: cells matching '230 170 000' found, but: top_heading 'tidligere' doesn't match 'tidligere tildelt' (0.72)
- `kudos-17208-p18-t03` (digital, table_cell): cell "13 093" (left_heading "Sogn og Fjordane", top_heading "Investering per innbygger (kroner)"). Why: cells matching '13 093' found, but: top_heading '' doesn't match 'investering per innbygger (kroner)' (0.00); left_heading 'sogn og' does...
- `kudos-17208-p18-t04` (digital, table_cell): cell "1 814" (left_heading "Troms", top_heading "Investering (millioner kroner)"). Why: cells matching '1 814' found, but: top_heading '' doesn't match 'investering (millioner kroner)' (0.00)

### Docling 2.146, RapidOCR

Both pass 1720, only Docling 2.146, RapidOCR 87, only Marker 46, both fail 80. Pages the parser failed on: 0.

- Only Docling 2.146, RapidOCR passes, by page kind and test type: scan+text present 31, digital present 22, digital table_cell 13, digital order 8, scan+text order 8, image-only present 4.
- Only Marker passes: digital present 10, scan+text present 9, digital table_cell 7, digital order 6, image-only present 5, image-only table_cell 4.

Only Marker passes (46), first 10:

- `kudos-157389-p23-t06` (digital, order): "inntektsløyvingar frå avdrag, renter og utbytte i Statskog SF." before "Utgifter fordelte på postgrupper". Why: 'inntektsløyvingar frå avdrag, rent' does not appear before 'Utgifter fordelte på postgrupper'
- `kudos-17959-p49-t04` (scan+text, present): "Revisjon av årsregnskapet for Nidaros domkirkes restaureringsarbeider 2020". Why: 'Revisjon av årsregnskapet for Nidaros domkirkes restaurering' not found (best 0.791 < 0.973)
- `kudos-17959-p49-t09` (scan+text, present): "Bestemmelser om økonomistyring i staten punkt 2.3.3". Why: 'Bestemmelser om økonomistyring i staten punkt 2.3.3' not found (best 0.490 < 0.961)
- `kudos-19325-p30-t04` (digital, present): "Det føres lokale forhandlinger på forhandlingsstedet jf. pkt. 2.2, dersom en av følgende betingelser er oppfylt". Why: 'Det føres lokale forhandlinger på forhandlingsstedet jf. pkt' not found (best 0.658 < 0.964)
- `kudos-19553-p5-t06` (digital, present): "Comprehensive and user-friendly access to policy instruments". Why: 'Comprehensive and user-friendly access to policy instruments' not found (best 0.683 < 0.967)
- `kudos-19553-p5-t08` (digital, present): "Policy instruments for innovation". Why: 'Policy instruments for innovation' not found (best 0.800 < 0.970)
- `kudos-19557-p5-t09` (digital, present): "Sametingets årsmelding 2019". Why: 'Sametingets årsmelding 2019' not found (best 0.520 < 0.963)
- `kudos-213997-p2-t10` (digital, present): "Departementenes sikkerhets- og serviceorganisasjon". Why: 'Departementenes sikkerhets- og serviceorganisasjon' not found (best 0.500 < 0.958)
- `kudos-23102-p4-t06` (image-only, present): "Norsk Polarinstitutt skal ivareta forskningsinfrastruktur og tilby logistikk- og støttetjenester knyttet til forskningsaktivitet i Arktis og Antarktis.". Why: 'Norsk Polarinstitutt skal ivareta forskningsinfrastruktur og' not found (best 0.657 < 0.973)
- `kudos-23102-p4-t07` (image-only, present): "Drive logistikkruter for varer og personell til Trollstasjonen i Antarktis med båt og fly.". Why: 'Drive logistikkruter for varer og personell til Trollstasjon' not found (best 0.578 < 0.967)

Only Docling 2.146, RapidOCR passes (87), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-102474-p1-t04` (image-only, present): "2023". Why: '2023' not found (best 0.000 < 1.000)
- `kudos-102474-p34-t02` (digital, table_cell): cell "206 932 833" (left_heading "Kostnadsført leiebetaling for perioden", top_heading "SUM"). Why: cells matching '206 932 833' found, but: top_heading '' doesn't match 'sum' (0.00); top_heading '' doesn't match 'sum' (0.00)
- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-16088-p1-t05` (digital, table_cell): cell "202 000 000" (top_heading "Ny tildeling", left "10 000 000"). Why: cells matching '202 000 000' found, but: top_heading 'ny' doesn't match 'ny tildeling' (0.31)
- `kudos-16088-p1-t06` (digital, table_cell): cell "230 170 000" (top_heading "Tidligere tildelt", up "192 000 000"). Why: cells matching '230 170 000' found, but: top_heading 'tidligere' doesn't match 'tidligere tildelt' (0.72)
- `kudos-17208-p18-t03` (digital, table_cell): cell "13 093" (left_heading "Sogn og Fjordane", top_heading "Investering per innbygger (kroner)"). Why: cells matching '13 093' found, but: top_heading '' doesn't match 'investering per innbygger (kroner)' (0.00); left_heading 'sogn og' does...
- `kudos-17208-p18-t04` (digital, table_cell): cell "1 814" (left_heading "Troms", top_heading "Investering (millioner kroner)"). Why: cells matching '1 814' found, but: top_heading '' doesn't match 'investering (millioner kroner)' (0.00)

### Docling 2.146, EasyOCR English

Both pass 1675, only Docling 2.146, EasyOCR English 83, only Marker 91, both fail 84. Pages the parser failed on: 0.

- Only Docling 2.146, EasyOCR English passes, by page kind and test type: scan+text present 30, digital present 20, digital table_cell 13, digital order 8, scan+text order 7, image-only present 4.
- Only Marker passes: image-only present 22, scan+text present 17, image-only order 15, digital present 13, digital table_cell 7, digital order 6.

Only Marker passes (91), first 10:

- `kudos-103767-p2-t02` (scan+text, present): "avdelingsdirektør". Why: 'avdelingsdirektør' not found (best 0.941 < 1.000)
- `kudos-103767-p2-t03` (scan+text, present): "seniorrådgiver". Why: 'seniorrådgiver' not found (best 0.929 < 1.000)
- `kudos-157389-p23-t06` (digital, order): "inntektsløyvingar frå avdrag, renter og utbytte i Statskog SF." before "Utgifter fordelte på postgrupper". Why: 'inntektsløyvingar frå avdrag, rent' does not appear before 'Utgifter fordelte på postgrupper'
- `kudos-19325-p30-t01` (digital, present): "Endringer i Hovedtariffavtalen i staten 16. september 2020 - 30. april 2022, 2. avtaleår". Why: 'Endringer i Hovedtariffavtalen i staten 16. september 2020 -' not found (best 0.947 < 0.966)
- `kudos-19325-p30-t06` (digital, present): "forhandles innenfor en ramme på 1,8 % pr. dato av lønnsmassen.". Why: 'forhandles innenfor en ramme på 1,8 % pr. dato av lønnsmasse' not found (best 0.935 < 0.968)
- `kudos-19325-p30-t08` (digital, present): "Arbeidstakere som er i foreldrepermisjon uten lønn, jf. arbeidsmiljøloven § 12-5". Why: 'Arbeidstakere som er i foreldrepermisjon uten lønn, jf. arbe' not found (best 0.929 < 0.963)
- `kudos-19325-p30-t09` (digital, order): "Arbeidstakere som har permisjon med lønn" before "Arbeidstakere som på virkningstidspunktet er i ulønnede permisjoner". Why: 'after' text 'Arbeidstakere som på virkningstidspunkte' not found
- `kudos-19553-p5-t06` (digital, present): "Comprehensive and user-friendly access to policy instruments". Why: 'Comprehensive and user-friendly access to policy instruments' not found (best 0.683 < 0.967)
- `kudos-19553-p5-t08` (digital, present): "Policy instruments for innovation". Why: 'Policy instruments for innovation' not found (best 0.800 < 0.970)
- `kudos-19557-p5-t09` (digital, present): "Sametingets årsmelding 2019". Why: 'Sametingets årsmelding 2019' not found (best 0.520 < 0.963)

Only Docling 2.146, EasyOCR English passes (83), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-102474-p1-t04` (image-only, present): "2023". Why: '2023' not found (best 0.000 < 1.000)
- `kudos-102474-p34-t02` (digital, table_cell): cell "206 932 833" (left_heading "Kostnadsført leiebetaling for perioden", top_heading "SUM"). Why: cells matching '206 932 833' found, but: top_heading '' doesn't match 'sum' (0.00); top_heading '' doesn't match 'sum' (0.00)
- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-16088-p1-t05` (digital, table_cell): cell "202 000 000" (top_heading "Ny tildeling", left "10 000 000"). Why: cells matching '202 000 000' found, but: top_heading 'ny' doesn't match 'ny tildeling' (0.31)
- `kudos-16088-p1-t06` (digital, table_cell): cell "230 170 000" (top_heading "Tidligere tildelt", up "192 000 000"). Why: cells matching '230 170 000' found, but: top_heading 'tidligere' doesn't match 'tidligere tildelt' (0.72)
- `kudos-17208-p18-t03` (digital, table_cell): cell "13 093" (left_heading "Sogn og Fjordane", top_heading "Investering per innbygger (kroner)"). Why: cells matching '13 093' found, but: top_heading '' doesn't match 'investering per innbygger (kroner)' (0.00); left_heading 'sogn og' does...
- `kudos-17208-p18-t04` (digital, table_cell): cell "1 814" (left_heading "Troms", top_heading "Investering (millioner kroner)"). Why: cells matching '1 814' found, but: top_heading '' doesn't match 'investering (millioner kroner)' (0.00)

### MinerU 4.1.6, no picture descriptions

Both pass 1708, only MinerU 4.1.6, no picture descriptions 87, only Marker 58, both fail 80. Pages the parser failed on: 0.

- Only MinerU 4.1.6, no picture descriptions passes, by page kind and test type: digital present 31, scan+text present 25, digital order 12, digital table_cell 7, scan+text order 7, image-only present 4.
- Only Marker passes: digital table_cell 24, digital present 22, digital order 4, image-only table_cell 4, scan+text present 3, scan+text order 1.

Only Marker passes (58), first 10:

- `kudos-157389-p23-t08` (digital, table_cell): cell "6,9" (top_heading "Endring i pst.", left "31 172 588"). Why: no cell matching '6,9' in any table
- `kudos-157389-p23-t09` (digital, table_cell): cell "29 360 068" (top_heading "Rekneskap 2023", left "Sum under departementet"). Why: no cell matching '29 360 068' in any table
- `kudos-17208-p15-t04` (digital, table_cell): cell "2 998" (left_heading "Rogaland", top_heading "Investeringer (millioner kroner)"). Why: cells matching '2 998' found, but: top_heading 'nvesteringer s (millioner kroner)' doesn't match 'investeringer (millioner kroner)' (0.97)
- `kudos-17208-p15-t06` (digital, table_cell): cell "370" (left_heading "Møre og Romsdal", top_heading "Søknadssum (millioner kroner)"). Why: cells matching '370' found, but: top_heading 'øknadssum (millioner kroner)' doesn't match 'søknadssum (millioner kroner)' (0.98)
- `kudos-17208-p15-t07` (digital, table_cell): cell "53" (left_heading "Finnmark", top_heading "Antall søknader"). Why: cells matching '53' found, but: top_heading 'i antall søknader' doesn't match 'antall søknader' (0.97)
- `kudos-17208-p15-t08` (digital, table_cell): cell "29 819" (left "3 466", right "5 807"). Why: no cell matching '29 819' in any table
- `kudos-17208-p15-t09` (digital, present): "1 572". Why: '1 572' not found digit-for-digit
- `kudos-17208-p18-t06` (digital, table_cell): cell "30 853" (left "5 888", right "5 791"). Why: no cell matching '30 853' in any table
- `kudos-17869-p1-t10` (digital, present): "Finansdepartementet fastsetter denne instruksen med virkning fra 1. januar 2020.". Why: 'Finansdepartementet fastsetter denne instruksen med virkning' not found (best 0.600 < 0.963)
- `kudos-17959-p49-t01` (scan+text, present): "26.04.2021". Why: '26.04.2021' not found (best 0.400 < 1.000)

Only MinerU 4.1.6, no picture descriptions passes (87), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-102474-p1-t04` (image-only, present): "2023". Why: '2023' not found (best 0.000 < 1.000)
- `kudos-102474-p34-t08` (digital, present): "98 372 530". Why: '98 372 530' not found (best 0.900 < 1.000)
- `kudos-103606-p3-t01` (digital, table_cell): cell "Kunnskap, evaluering og læring av Nansen-programmet" (left "Oppdrag nr. 21-2023"). Why: no tables found
- `kudos-103606-p3-t08` (digital, table_cell): cell "Støtte til institusjonssamarbeid med Ukraina" (left "Oppdrag nr. 23-2023"). Why: no tables found
- `kudos-13175-p23-t04` (digital, present): "Tabell 2-2: Utsendte spørreskjema og svarprosent for tre deltakerkull og kontrollgruppe". Why: 'Tabell 2-2: Utsendte spørreskjema og svarprosent for tre del' not found (best 0.759 < 0.966)
- `kudos-17208-p18-t04` (digital, table_cell): cell "1 814" (left_heading "Troms", top_heading "Investering (millioner kroner)"). Why: cells matching '1 814' found, but: top_heading '' doesn't match 'investering (millioner kroner)' (0.00)
- `kudos-17208-p18-t05` (digital, table_cell): cell "608" (left_heading "Trøndelag", top_heading "Antall nye søknader 2016-2019"). Why: cells matching '608' found, but: top_heading 'antall' doesn't match 'antall nye søknader 2016-2019' (0.38)
- `kudos-17208-p18-t11` (digital, present): "Spillemiddelandel nye søknader 2016-19". Why: 'Spillemiddelandel nye søknader 2016-19' not found (best 0.743 < 0.974)

### Marker 1.10.2, page by page

Both pass 1762, only Marker 1.10.2, page by page 6, only Marker 4, both fail 161. Pages the parser failed on: 0.

- Only Marker 1.10.2, page by page passes, by page kind and test type: digital present 2, image-only present 1, image-only order 1, digital order 1, digital table_cell 1.
- Only Marker passes: digital present 4.

Only Marker passes (4), first 10:

- `kudos-19553-p5-t02` (digital, present): "Norway needs an innovative public sector". Why: 'Norway needs an innovative public sector' not found (best 0.750 < 0.975)
- `kudos-19553-p5-t06` (digital, present): "Comprehensive and user-friendly access to policy instruments". Why: 'Comprehensive and user-friendly access to policy instruments' not found (best 0.683 < 0.967)
- `kudos-19553-p5-t08` (digital, present): "Policy instruments for innovation". Why: 'Policy instruments for innovation' not found (best 0.800 < 0.970)
- `kudos-213997-p2-t10` (digital, present): "Departementenes sikkerhets- og serviceorganisasjon". Why: 'Departementenes sikkerhets- og serviceorganisasjon' not found (best 0.521 < 0.958)

Only Marker 1.10.2, page by page passes (6), first 10:

- `kudos-102474-p1-t02` (image-only, present): "ÅRSRAPPORT". Why: 'ÅRSRAPPORT' not found (best 0.300 < 1.000)
- `kudos-102474-p1-t03` (image-only, order): "NASJONALBIBLIOTEKET" before "ÅRSRAPPORT". Why: 'after' text 'ÅRSRAPPORT' not found
- `kudos-238090-p5-t02` (digital, present): "Bedre beredskap og respons for helse- og humanitære kriser". Why: 'Bedre beredskap og respons for helse- og humanitære kriser' not found (best 0.946 < 0.964)
- `kudos-238090-p5-t03` (digital, present): "Oppnå universell helsedekning". Why: 'Oppnå universell helsedekning' not found (best 0.862 < 0.966)
- `kudos-238090-p5-t05` (digital, order): "Oppnå universell helsedekning" before "Bedre beredskap og respons". Why: 'before' text 'Oppnå universell helsedekning' not found
- `kudos-88654-p48-t07` (digital, table_cell): cell "Stadfestelse" (top_heading "Resultat"). Why: cells matching 'Stadfestelse' found, but: top_heading '' doesn't match 'resultat' (0.00); top_heading 'beskrivelse:' doesn't match 'resul...

## Limits

- A text test that allows a slip or two also passes a single wrong digit inside it, so wrong digits are caught by the number tests (no slips allowed), not by every passage.
- Running headers, footers and page numbers aren't tested.
- The tests come from one reading model, checked by a second; no person checked every test.
- Slices other than the headline are exploratory: with this many, some differences marked ✱ will be chance.
- Marker 1.10.2's text comes from converting whole documents and splitting them into pages; every other parser saw one page at a time. The tests check what is on the page, not heading levels or text carried over from other pages.
- Every parser ran on one M3 Pro Mac. Where a parser's vision-language model runs in vLLM on an NVIDIA GPU, it ran here in MLX (Apple's framework) from the same weights; the outputs can differ in small ways.
- Each parser ran with its defaults, plus Norwegian where it takes a language (PP-StructureV3). Docling's default OCR takes no language and is EasyOCR in English here; three Docling sides change only the OCR: EasyOCR with Norwegian and English, Tesseract with Norwegian, and RapidOCR with its default models.

The reference, how it was checked, and the instrument checks (A/A and a known loss) are in [report.md](report.md); they hold for these comparisons too, since every side is graded on the same tests.

## Words used here

- **Reference**: the known-right answers every side is measured against, made without looking at any side's output.
- **Side**: one of the things compared: the current component, or a candidate for replacing it.
- **Paired difference**: both sides graded on exactly the same items, so the difference compares like with like.
- **95% interval**: the range the difference would likely fall in with another sample of documents, from resampling whole documents. If it leaves out zero, the difference is unlikely to be chance (✱).
- **Margin**: how much worse a candidate may be and still replace the current side, set before the run.
- **Verdict**: better: the whole interval is above zero. Not worse: the whole interval is above minus the margin. Worse: the whole interval is below minus the margin. Inconclusive: none of these; more items are needed.
- **Detectable**: the smallest difference this sample would find with 80% power. A difference smaller than this can hide in a sample this size.
- **Tier**: sides that the data can't tell apart, after correcting for comparing several pairs at once.
- **KUDOS text**: the plain text the KUDOS API serves for a document (`/contents`), with a page break character between pages. It is the PDF's own text layer, or KUDOS's OCR when the whole PDF has none.
- **Marker**: the open-source PDF-to-markdown converter genki runs itself. It reads the text layer where there is one, reads the page image where there isn't, and rebuilds headings and tables.
- **Text layer**: the text stored inside a PDF next to what is drawn. A scan has none unless someone ran OCR on it.
- **Present test**: a passage, heading or figure is in the side's text for that page (a few typing slips allowed).
- **Order test**: passage A comes before passage B, as a person reads the page (columns, boxes, footnotes).
- **Table test**: a cell sits in a table under its column heading or beside its row label. Plain text has no tables, so KUDOS fails every table test by design: it keeps the numbers, not the grid.
- **Headline**: the scoring tool's single score: the mean of the text score and the table score.
- **As served / page breaks ignored**: KUDOS's text for page n as genki would cite it, or, for documents whose page breaks don't match the PDF, its whole text on every page.
- **Marker 1.10.2**: the converter genki runs today (the Marker service in PR 91), the current side here.
- **Marker 2.1**: Marker's next major version: one Surya vision-language model does layout, OCR and tables.
- **PP-StructureV3**: PaddleOCR's pipeline of small models: layout, text detection and recognition, tables, formulas. It reads the page image, not the text layer.
- **PaddleOCR-VL-1.6**: PaddleOCR's layout model plus a 0.9-billion-parameter vision-language model that reads each region of the page image.
- **MinerU 4.1.6**: OpenDataLab's parser at its default PDF tier (standard): small models plus the MinerU2.5-Pro vision-language model, with the text layer where it can use it.
- **Docling 2.146**: IBM's parser with its default pipeline: the text layer, a layout model, TableFormer for tables, and OCR for pictures.
- **Candidate**: a parser that could replace Marker 1.10.2.

## Notes: time and cost (not part of the ranking)

- Seconds per page on the M3 Pro, with up to four parsers sharing it, so slower than alone: Marker 2.1 median 6.7 s, 90th percentile 41.3 s; PP-StructureV3 median 29.0 s, 90th percentile 48.4 s; PaddleOCR-VL-1.6 median 9.0 s, 90th percentile 15.6 s; MinerU 4.1.6 median 2.7 s, 90th percentile 16.4 s; Docling 2.146 median 3.1 s, 90th percentile 9.5 s; Docling 2.146, Norwegian OCR median 1.2 s, 90th percentile 4.9 s; Docling 2.146, Tesseract Norwegian median 0.8 s, 90th percentile 3.0 s; Docling 2.146, RapidOCR median 0.7 s, 90th percentile 2.8 s; Docling 2.146, EasyOCR English median 1.2 s, 90th percentile 3.8 s; MinerU 4.1.6, no picture descriptions median 1.2 s, 90th percentile 8.6 s; Marker 1.10.2, page by page median 2.4 s, 90th percentile 9.0 s. Marker 1.10.2 took about 4 seconds a page on the whole documents. Not part of the ranking, and no guide to a GPU host (issue 337 has the Azure options).

## Run record

| Side | Commit | Uncommitted changes | Graded | Reference | Version | Settings |
| --- | --- | --- | --- | --- | --- | --- |
| Marker 1.10.2 | 8cf61bdfc6a6 | yes | 2026-11-04T14:36:12+00:00 | 2deebfd82fe4 | 1.10.2 | {"disable_image_extraction": true, "languages": "no,en", "output_format": "markdown", "page_separator": "___PAGE_SEPARATOR___", "paginate_output": true} |
| Marker 2.1 | 8cf61bdfc6a6 | yes | 2026-11-04T14:36:13+00:00 | 2deebfd82fe4 | 2.1.0 | {"disable_image_extraction": true, "mode": "balanced", "output_format": "markdown"} |
| PP-StructureV3 | 8cf61bdfc6a6 | yes | 2026-11-04T14:36:13+00:00 | 2deebfd82fe4 | 3.7.0 | {"device": "cpu", "lang": "no", "other": "library defaults", "pipeline": "PP-StructureV3"} |
| PaddleOCR-VL-1.6 | 8cf61bdfc6a6 | yes | 2026-11-04T14:36:13+00:00 | 2deebfd82fe4 | 3.7.0 | {"device": "cpu (layout), mlx (VLM)", "mlx_vlm": "0.7.11", "other": "library defaults", "pipeline": "PaddleOCR-VL", "vl_rec_api_model_name": "PaddlePaddle/PaddleOCR-VL-1.6", "vl_rec_backend": "mlx-vlm-server"} |
| MinerU 4.1.6 | 8cf61bdfc6a6 | yes | 2026-11-04T14:36:13+00:00 | 2deebfd82fe4 | 4.1.6 | {"image_analysis": true, "images": "data URIs removed from the Markdown", "ocr_mode": "auto", "telemetry": "off", "tier": "standard", "vlm_engine": "mlx"} |
| Docling 2.146 | 8cf61bdfc6a6 | yes | 2026-11-04T14:36:13+00:00 | 2deebfd82fe4 | 2.146.0 | {"do_ocr": true, "ocr": "OcrAutoOptions", "pipeline": "default PdfPipelineOptions", "table_mode": "accurate"} |
| Docling 2.146, Norwegian OCR | 8cf61bdfc6a6 | yes | 2026-11-04T14:36:13+00:00 | 2deebfd82fe4 | 2.146.0 | {"do_ocr": true, "ocr": "EasyOcrOptions", "ocr_lang": ["no", "en"], "pipeline": "default PdfPipelineOptions", "table_mode": "accurate"} |
| Docling 2.146, Tesseract Norwegian | 8cf61bdfc6a6 | yes | 2026-11-11T11:41:39+00:00 | 2deebfd82fe4 | 2.146.0 | {"do_ocr": true, "ocr": "TesseractCliOcrOptions", "ocr_lang": ["nor"], "pipeline": "default PdfPipelineOptions", "table_mode": "accurate"} |
| Docling 2.146, RapidOCR | 8cf61bdfc6a6 | yes | 2026-11-11T11:41:39+00:00 | 2deebfd82fe4 | 2.146.0 | {"do_ocr": true, "ocr": "OcrAutoOptions", "pipeline": "default PdfPipelineOptions", "table_mode": "accurate"} |
| Docling 2.146, EasyOCR English | 8cf61bdfc6a6 | yes | 2026-11-11T12:02:44+00:00 | 2deebfd82fe4 | 2.146.0 | {"do_ocr": true, "ocr": "OcrAutoOptions", "pipeline": "default PdfPipelineOptions", "table_mode": "accurate"} |
| MinerU 4.1.6, no picture descriptions | 8cf61bdfc6a6 | yes | 2026-11-11T12:02:44+00:00 | 2deebfd82fe4 | 4.1.6 | {"image_analysis": false, "images": "data URIs removed from the Markdown", "ocr_mode": "auto", "telemetry": "off", "tier": "standard", "vlm_engine": "mlx"} |
| Marker 1.10.2, page by page | 8cf61bdfc6a6 | yes | 2026-11-04T14:36:13+00:00 | 2deebfd82fe4 | 1.10.2 | {"disable_image_extraction": true, "languages": "no,en", "output_format": "markdown"} |
