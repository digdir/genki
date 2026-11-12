"""Marker 1.10.2 on whole documents, exactly as the Marker service converts (services/marker-pdf-to-markdown
on the Kudos pilot branch, PR 91): the service's settings, one build_document, rendered both as Markdown and as
Marker's JSON block tree, with the images left out of the JSON.

    python convert_marker.py <pdfs> <out> [--device auto|cuda|cpu|mps] [--strip-existing-ocr | --use-llm]

--device sets TORCH_DEVICE before Marker loads; auto leaves Marker to choose. --strip-existing-ocr adds Marker's
strip_existing_ocr: a PDF's old OCR text layer is dropped and those pages are read again by Marker's own OCR
(parser marker-strip); digital pages keep their text. --use-llm turns on Marker's use_llm with its Azure OpenAI
service (parser marker-llm): AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT and
AZURE_OPENAI_API_VERSION from the environment. llm_usage.py counts requests, errors and input/output tokens per
document; they are stored in native.json.gz under llm_usage, with Marker's own per-block-type counts.
"""
import importlib.metadata as md
import os
import sys

from common import arguments, run

PAGE_SEPARATOR = "___PAGE_SEPARATOR___"
# The service's MARKER_SETTINGS, so the same processors run
SETTINGS = {"output_format": "markdown", "languages": "no,en", "disable_image_extraction": True,
            "paginate_output": True, "page_separator": PAGE_SEPARATOR}


def without_images(block):
    kept = {key: value for key, value in block.items() if key != "images"}
    if block.get("children"):
        kept["children"] = [without_images(child) for child in block["children"]]
    return kept


def main():
    strip = "--strip-existing-ocr" in sys.argv
    if strip:
        sys.argv.remove("--strip-existing-ocr")
    llm = "--use-llm" in sys.argv
    if llm:
        sys.argv.remove("--use-llm")
    settings = dict(SETTINGS)
    if strip:
        settings["strip_existing_ocr"] = True
    secret = {}
    if llm:
        # Image extraction back on: with it off, use_llm makes the model describe every picture into the text
        # (Kent, 11 Nov: no model-written picture descriptions). The JSON keeps leaving image bytes out.
        settings["disable_image_extraction"] = False
        settings.update({"use_llm": True, "llm_service": "llm_usage.CountingAzureOpenAIService",
                         "azure_endpoint": os.environ["AZURE_OPENAI_ENDPOINT"],
                         "deployment_name": os.environ["AZURE_OPENAI_DEPLOYMENT"],
                         "azure_api_version": os.environ.get("AZURE_OPENAI_API_VERSION", "2025-04-01-preview")})
        secret = {"azure_api_key": os.environ["AZURE_OPENAI_API_KEY"]}
    args = arguments(["auto", "cuda", "cpu", "mps"])
    if args.device != "auto":
        os.environ["TORCH_DEVICE"] = args.device
    if "marker" in sys.modules:
        raise SystemExit("marker was imported before TORCH_DEVICE was set")

    from marker.config.parser import ConfigParser
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.renderers.json import JSONRenderer
    from marker.renderers.markdown import MarkdownRenderer

    def load():
        config = ConfigParser(dict(settings, **secret))
        return PdfConverter(config=config.generate_config_dict(), artifact_dict=create_model_dict(),
                            processor_list=config.get_processors(), renderer=config.get_renderer(),
                            llm_service=config.get_llm_service())

    def convert(converter, pdf):
        if llm:
            import llm_usage
            llm_usage.reset()
        document = converter.build_document(str(pdf))
        markdown = converter.resolve_dependencies(MarkdownRenderer)(document).markdown
        output = converter.resolve_dependencies(JSONRenderer)(document).model_dump(mode="json")
        output["children"] = [without_images(page) for page in output["children"]]
        if llm:
            by_type = {}
            for block in document.contained_blocks():
                m = block.metadata
                if m and (m.llm_request_count or m.llm_error_count):
                    t = by_type.setdefault(str(block.block_type), {"requests": 0, "errors": 0, "tokens": 0})
                    t["requests"] += m.llm_request_count
                    t["errors"] += m.llm_error_count
                    t["tokens"] += m.llm_tokens_used
            output["llm_usage"] = {**llm_usage.snapshot(), "by_block_type": by_type}
        return output, markdown.replace(PAGE_SEPARATOR, "\n\n")

    meta = {"parser": "marker-llm" if llm else "marker-strip" if strip else "marker", "version": md.version("marker-pdf"), "surya": md.version("surya-ocr"),
            "settings": settings, "torch_device": os.environ.get("TORCH_DEVICE", "auto"),
            "native": "JSONRenderer output of the same document, images left out"}
    run(load, convert, args, meta)


if __name__ == "__main__":
    main()
