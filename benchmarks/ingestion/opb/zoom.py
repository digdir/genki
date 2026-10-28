"""Crop part of a page's high-resolution image, to read small print.

    zoom.py <page_id> <x0> <y0> <x1> <y1>    # fractions of the page as displayed, origin top left

Prints the path of the crop, at most LONG_EDGE pixels on its long edge.
"""
import sys

from PIL import Image

from common_opb import OPB

LONG_EDGE = 1600


def main():
    page_id, *box = sys.argv[1:]
    x0, y0, x1, y1 = (float(x) for x in box)
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise SystemExit("the box must be x0 < x1 and y0 < y1, all from 0 to 1")
    img = Image.open(OPB / "hires" / f"{page_id}.png")
    w, h = img.size
    crop = img.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))
    if max(crop.size) > LONG_EDGE:
        crop.thumbnail((LONG_EDGE, LONG_EDGE))
    out = OPB / "zoom" / f"{page_id}-{x0:g}-{y0:g}-{x1:g}-{y1:g}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    crop.save(out)
    print(out)


if __name__ == "__main__":
    main()
