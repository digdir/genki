# Pages whose only text is inside pictures, in the Docling export of KUDOS

`picture_text.py` reads 300 random `docling.json` files of the export (Docling 2.123.1, EasyOCR `no,en`, TableFormer accurate) per seed and counts, per page, the text a page builder would keep (body text and tables, no page headers or footers, nothing under a picture) and the text under a picture. A page with under 20 characters of kept text counts as having no body text.

Run: `python3 -I picture_text.py <export root> <seed>`, on 12 Nov 2026.

|    Seed |      Pages | No body text | Text only inside pictures | Of those, 200+ characters |
| ------: | ---------: | -----------: | ------------------------: | ------------------------: |
|       7 |     18,199 |        2,619 |               548 (3.0 %) |                       423 |
|       1 |     19,027 |        2,245 |               398 (2.1 %) |                       189 |
|       2 |     18,631 |        2,531 |               427 (2.3 %) |                       226 |
|       3 |     17,491 |        2,808 |               511 (2.9 %) |                       324 |
|       4 |     18,118 |        2,472 |               546 (3.0 %) |                       283 |
| **All** | **91,466** |   **12,675** |         **2,430 (2.7 %)** |         **1,445 (1.6 %)** |

The samples can overlap. Not checked: how many of these pages are whole-page scans and how many are charts or infographics. No document text is in this file.
