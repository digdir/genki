"""Docling on each page, with its default PDF pipeline: the text layer where there is one, Heron layout,
TableFormer (accurate) and its default OCR for bitmaps. The default (OcrAutoOptions) takes the first engine
installed: ocrmac on macOS, Nemotron OCR on Linux, RapidOCR with onnxruntime, EasyOCR (English when no language
is given), then RapidOCR with torch. When side docling ran (4 Nov, 12:41) the docling venv had none of the first
four, so it was RapidOCR with torch (its log shows RapidOCR). EasyOCR was installed at 15:21 for docling-no, so
side docling run again in this venv would now get EasyOCR in English.

    convert_docling.py <pages> <out> [--ocr no|tess|rapid|easy-en]

--ocr no (side docling-no): EasyOCR with Norwegian and English (`lang=["no", "en"]`).
--ocr tess (side docling-tess): Tesseract (CLI) with Norwegian (`TesseractCliOcrOptions(lang=["nor"])`); needs
the tesseract CLI with the `nor` model (Homebrew `tesseract` and `tesseract-lang`).
--ocr rapid (side docling-rapid): OCR options left at the default, run in the docling-rapid venv (the docling
venv plus onnxruntime), so the automatic choice is RapidOCR with its default models. The engine Docling picked
is read from its log and kept in meta.json; the script stops if it is not RapidOCR.
--ocr easy-en (side docling-easyocr-en): OCR options left at the default in the docling venv as it is now (with
easyocr, without onnxruntime), so the automatic choice is EasyOCR in English: what the blocks benchmark's
docling side runs. The script stops if the choice is anything else.
The rest is unchanged in every side.
"""
import importlib.metadata as md
import logging
import subprocess
import sys

from convert_common import arguments, run


class Choice(logging.Handler):
    """Keeps Docling's 'Auto OCR model selected ...' line."""
    picked = None

    def emit(self, r):
        if "Auto OCR model selected" in r.getMessage():
            Choice.picked = r.getMessage()


def main():
    ocr = None
    if "--ocr" in sys.argv:
        i = sys.argv.index("--ocr")
        ocr = sys.argv[i + 1]
        if ocr not in ("no", "tess", "rapid", "easy-en"):
            raise SystemExit("--ocr takes: no, tess, rapid, easy-en")
        del sys.argv[i:i + 2]
    a = arguments()
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import EasyOcrOptions, PdfPipelineOptions, TesseractCliOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    if ocr == "no":
        options.ocr_options = EasyOcrOptions(lang=["no", "en"])
    elif ocr == "tess":
        options.ocr_options = TesseractCliOcrOptions(lang=["nor"])
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})

    extra = {}
    if ocr in (None, "no", "easy-en"):
        extra["easyocr"] = md.version("easyocr")
    if ocr == "tess":
        extra["tesseract"] = subprocess.run(["tesseract", "--version"], capture_output=True,
                                            text=True).stdout.splitlines()[0]
    if ocr in ("rapid", "easy-en"):
        # The automatic choice is made when the pipeline is built; build it now and read which engine it took.
        handler = Choice()
        log = logging.getLogger("docling.models.stages.ocr.auto_ocr_model")
        log.addHandler(handler)
        log.setLevel(logging.INFO)
        converter.initialize_pipeline(InputFormat.PDF)
        log.removeHandler(handler)
        want = {"rapid": "rapidocr with onnxruntime", "easy-en": "easyocr"}[ocr]
        if not Choice.picked or not Choice.picked.rstrip(".").endswith(want):
            raise SystemExit(f"Docling's automatic OCR choice was not {want}: {Choice.picked}")
        installed = {d.metadata["Name"].lower() for d in md.distributions()}
        extra.update({"ocrmac_installed": "ocrmac" in installed, "onnxruntime_installed": "onnxruntime" in installed,
                      "ocr_engine": Choice.picked})
        if ocr == "rapid":
            extra["onnxruntime"] = md.version("onnxruntime")
    meta = {"parser": {None: "docling", "easy-en": "docling-easyocr-en"}.get(ocr, f"docling-{ocr}"), "version": md.version("docling"),
            "docling_ibm_models": md.version("docling-ibm-models"), "rapidocr": md.version("rapidocr"),
            **extra, "torch": md.version("torch"),
            "settings": {"pipeline": "default PdfPipelineOptions", "do_ocr": options.do_ocr,
                         "ocr": type(options.ocr_options).__name__,
                         **({"ocr_lang": list(options.ocr_options.lang)} if ocr in ("no", "tess") else {}),
                         "table_mode": options.table_structure_options.mode.value},
            "models": {"layout": options.layout_options.model_spec.repo_id}}
    run(lambda pdf: converter.convert(str(pdf)).document.export_to_markdown(), a.pages, a.out, meta, a.only)


if __name__ == "__main__":
    main()
