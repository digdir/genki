# Pages whose only text is inside pictures, in the Docling export of KUDOS

`picture_text.py` reads 300 random `docling.json` files of the export (Docling 2.123.1, EasyOCR `no,en`, TableFormer accurate) per seed and counts, per page, the text a page builder would keep (body text and table cells, no page headers or footers, nothing under a picture, directly or through a group) and the text under a picture. A page with under 20 characters of kept text counts as having no body text.

Run: `python3 -I picture_text.py <export root> <seed>`, on 12 Nov 2026.

|    Seed |      Pages | No body text | Text only inside pictures | Of those, 200+ characters |
| ------: | ---------: | -----------: | ------------------------: | ------------------------: |
|       7 |     18,199 |        1,926 |               516 (2.8 %) |                       412 |
|       1 |     19,027 |        1,523 |               328 (1.7 %) |                       196 |
|       2 |     18,631 |        1,958 |               363 (1.9 %) |                       221 |
|       3 |     17,491 |        2,169 |               465 (2.7 %) |                       322 |
|       4 |     18,118 |        1,711 |               483 (2.7 %) |                       281 |
| **All** | **91,466** |    **9,287** |         **2,155 (2.4 %)** |         **1,432 (1.6 %)** |

The samples can overlap. Not checked: how many of these pages are whole-page scans and how many are charts or infographics. No document text is in this file.
