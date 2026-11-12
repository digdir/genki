"""Render every reference page as images, the only view of a page its test writers get.

.data/opb/png/<page_id>.png     the whole page, at most OVERVIEW pixels on its long edge
.data/opb/hires/<page_id>.png   the whole page at HIRES_DPI, which zoom.py crops

Images already on disk are kept.
"""
import pymupdf

from common_opb import OPB, PNG, pages, pdf_path

OVERVIEW = 1600
HIRES_DPI = 300
HIRES = OPB / "hires"


def main():
    PNG.mkdir(parents=True, exist_ok=True)
    HIRES.mkdir(parents=True, exist_ok=True)
    for n, p in enumerate(pages(), 1):
        small, big = PNG / f'{p["page_id"]}.png', HIRES / f'{p["page_id"]}.png'
        if small.exists() and big.exists():
            continue
        with pymupdf.open(pdf_path(p["doc_num"])) as pdf:
            page = pdf[p["page"] - 1]
            zoom = OVERVIEW / max(page.rect.width, page.rect.height)
            page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom)).save(small)
            page.get_pixmap(dpi=HIRES_DPI).save(big)
        print(f"{n} {p['page_id']}")


if __name__ == "__main__":
    main()
