"""Marker 1.10.2 on each page on its own, with the Marker service's settings (PR 91), in the service's venv.

    <marker service venv>/bin/python convert_marker1.py <pages> <out>

A check, not a candidate: the `marker` side reuses the pilot's whole-document conversions split into pages,
while every candidate converts one-page PDFs. Grading Marker 1.10.2 page by page shows how much converting
one page at a time costs. The service's settings, minus pagination, which a one-page PDF doesn't need.
"""
import importlib.metadata as md

from convert_common import arguments, run

SETTINGS = {"output_format": "markdown", "languages": "no,en", "disable_image_extraction": True}


def main():
    a = arguments()
    from marker.config.parser import ConfigParser
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict

    config = ConfigParser(dict(SETTINGS))
    converter = PdfConverter(config=config.generate_config_dict(), artifact_dict=create_model_dict(),
                             processor_list=config.get_processors(), renderer=config.get_renderer(),
                             llm_service=config.get_llm_service())
    meta = {"parser": "marker-pdf", "version": md.version("marker-pdf"), "surya": md.version("surya-ocr"),
            "settings": SETTINGS, "pages_note": "one page at a time"}
    run(lambda pdf: converter(str(pdf)).markdown, a.pages, a.out, meta, a.only)


if __name__ == "__main__":
    main()
