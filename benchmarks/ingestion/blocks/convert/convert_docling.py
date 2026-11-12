"""Docling on whole documents, with the pipeline the page tests graded (opb/parsers/convert_docling.py): the
text layer where there is one, Heron layout, TableFormer (accurate) and the default OCR for bitmaps. The default
(OcrAutoOptions) takes the first engine installed: ocrmac on macOS, Nemotron OCR on Linux, RapidOCR with
onnxruntime, EasyOCR, then RapidOCR with torch. This image has neither ocrmac, Nemotron nor onnxruntime, so it is
EasyOCR, and with no languages given Docling's EasyOCR reads English only. The page tests' docling side (4 Nov)
ran before EasyOCR was in the opb venv, so it was RapidOCR with torch, not this.
Native output: the DoclingDocument as JSON (export_to_dict), with page numbers and boxes on every item.

    python convert_docling.py <pdfs> <out> [--device auto|cpu|cuda|mps] [--ocr no|tess|rapid] [--variant repair|nocells|egret|noreng|best]

--device sets Docling's accelerator (auto picks CUDA, then MPS, then CPU). --ocr no uses EasyOCR with
Norwegian and English, as the opb side docling-no did (parser docling-no). --ocr tess uses Tesseract (CLI) with
Norwegian (parser docling-tess); --variant changes one setting on top of it (parser docling-tess-<variant>, see
VARIANTS). --ocr rapid keeps the default OCR options but needs onnxruntime installed
(the docling-rapid image), so Docling's automatic choice is RapidOCR with its default models (parser docling-rapid).
"""
import importlib.metadata as md
import os
import sys

from common import arguments, run


# Dockerfile.docling puts tessdata_best 4.1.0 nor.traineddata here; TESSDATA_BEST overrides it outside the image
TESSDATA_BEST = os.environ.get("TESSDATA_BEST", "/usr/share/tessdata-best")
# Tesseract variants: each changes one setting on top of docling-tess (Tesseract, Norwegian)
VARIANTS = {"repair": "also OCR pages whose text layer Docling finds broken (replace_broken_text_layer)",
            "nocells": "tables from TableFormer's own cells, not matched to the PDF's text cells (do_cell_matching off)",
            "egret": "layout model Egret large instead of Heron",
            "noreng": "Tesseract languages Norwegian + English",
            "best": "Tesseract's more accurate model set (tessdata_best 4.1.0)"}


def main():
    ocr = None
    if "--ocr" in sys.argv:
        i = sys.argv.index("--ocr")
        ocr = sys.argv[i + 1]
        if ocr not in ("no", "tess", "rapid"):
            raise SystemExit("--ocr takes: no, tess, rapid")
        del sys.argv[i:i + 2]
    variant = None
    if "--variant" in sys.argv:
        i = sys.argv.index("--variant")
        variant = sys.argv[i + 1]
        if ocr != "tess" or variant not in VARIANTS:
            raise SystemExit(f"--variant needs --ocr tess and one of: {', '.join(VARIANTS)}")
        del sys.argv[i:i + 2]
    if ocr == "rapid":
        import onnxruntime  # noqa: F401  (without it the automatic choice would not be RapidOCR)
    args = arguments(["auto", "cpu", "cuda", "mps"])

    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (EasyOcrOptions, LayoutObjectDetectionOptions, PdfPipelineOptions,
                                                     TesseractCliOcrOptions)
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.accelerator_options = AcceleratorOptions(device=AcceleratorDevice(args.device),
                                                     num_threads=int(os.environ.get("DOCLING_THREADS") or os.cpu_count() or 4))
    if ocr == "no":
        options.ocr_options = EasyOcrOptions(lang=["no", "en"])
    elif ocr == "tess":
        tess = {"lang": ["nor"]}
        if variant == "repair":
            tess["replace_broken_text_layer"] = True
        if variant == "noreng":
            tess["lang"] = ["nor", "eng"]
        if variant == "best":
            tess["path"] = TESSDATA_BEST
        options.ocr_options = TesseractCliOcrOptions(**tess)
        if variant == "nocells":
            options.table_structure_options.do_cell_matching = False
        if variant == "egret":
            # Docling's documented way; it calls Egret 'higher accuracy on complex documents'
            options.layout_options = LayoutObjectDetectionOptions.from_preset("layout_egret_large")
    engine = {None: "EasyOCR, English (automatic choice: no ocrmac, Nemotron or onnxruntime)",
              "no": "EasyOCR, Norwegian + English", "tess": "Tesseract CLI",
              "rapid": "RapidOCR with onnxruntime, default models (automatic choice)"}[ocr]
    name = "docling" if ocr is None else f"docling-{ocr}" + (f"-{variant}" if variant else "")

    def load():
        return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})

    def convert(converter, pdf):
        document = converter.convert(str(pdf)).document
        return document.export_to_dict(), document.export_to_markdown()

    extra = {}
    if ocr in (None, "no"):
        extra["easyocr"] = md.version("easyocr")
    if ocr == "rapid":
        extra["onnxruntime"] = md.version("onnxruntime")
    if ocr == "tess":
        import subprocess
        extra["tesseract"] = subprocess.run(["tesseract", "--version"], capture_output=True,
                                            text=True).stdout.splitlines()[0]
    meta = {"parser": name, "version": md.version("docling"), "variant": VARIANTS.get(variant),
            "docling_core": md.version("docling-core"), "docling_ibm_models": md.version("docling-ibm-models"),
            "rapidocr": md.version("rapidocr"), **extra,
            "settings": {"pipeline": "default PdfPipelineOptions", "do_ocr": options.do_ocr,
                         "ocr": type(options.ocr_options).__name__, "ocr_engine": engine,
                         **({"ocr_lang": list(options.ocr_options.lang)} if ocr in ("no", "tess") else {}),
                         "replace_broken_text_layer": getattr(options.ocr_options, "replace_broken_text_layer", False),
                         "tessdata": getattr(options.ocr_options, "path", None) or "system (Debian tesseract-ocr-nor)",
                         "table_cell_matching": options.table_structure_options.do_cell_matching,
                         "table_mode": options.table_structure_options.mode.value,
                         "accelerator": {"device": args.device, "num_threads": options.accelerator_options.num_threads}},
            "models": {"layout": options.layout_options.model_spec.repo_id},
            "native": "DoclingDocument.export_to_dict()"}
    run(load, convert, args, meta)


if __name__ == "__main__":
    main()
