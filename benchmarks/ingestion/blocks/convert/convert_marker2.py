"""Marker 2.1 on whole documents, with the settings the page tests graded (opb/parsers/convert_marker.py: mode
"balanced", Marker 2.1's default on CUDA, no image extraction), paginated so pages can be told apart, rendered
both as Markdown and as Marker's JSON block tree, with the images left out of the JSON.

    python convert_marker2.py <pdfs> <out> [--device auto|cuda|cpu|mps]

Marker 2.1's OCR and layout model (datalab-to/surya-ocr-2.5, a VLM) runs behind an inference server. On NVIDIA
Surya starts vLLM itself, in Docker (VLLM_DOCKER_IMAGE); run.sh sets VLLM_GPU_TYPE and VLLM_DTYPE for the host's
GPU (Surya's own settings: batch size and memory by GPU type, float16 on GPUs without bfloat16 such as the T4).
--device sets TORCH_DEVICE for Marker's own torch models before Marker loads.
"""
import importlib.metadata as md
import os
import sys

from common import arguments, run

PAGE_SEPARATOR = "___PAGE_SEPARATOR___"
SETTINGS = {"output_format": "markdown", "disable_image_extraction": True, "mode": "balanced",
            "paginate_output": True, "page_separator": PAGE_SEPARATOR}


def without_images(block):
    kept = {key: value for key, value in block.items() if key != "images"}
    if block.get("children"):
        kept["children"] = [without_images(child) for child in block["children"]]
    return kept


def main():
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
    from surya.settings import settings as surya

    def load():
        config = ConfigParser(dict(SETTINGS))
        return PdfConverter(config=config.generate_config_dict(), artifact_dict=create_model_dict(),
                            processor_list=config.get_processors(), renderer=config.get_renderer(),
                            llm_service=config.get_llm_service())

    def convert(converter, pdf):
        document = converter.build_document(str(pdf))
        markdown = converter.resolve_dependencies(MarkdownRenderer)(document).markdown
        output = converter.resolve_dependencies(JSONRenderer)(document).model_dump(mode="json")
        output["children"] = [without_images(page) for page in output["children"]]
        return output, markdown.replace(PAGE_SEPARATOR, "\n\n")

    inference = {k: getattr(surya, k) for k in (
        "SURYA_INFERENCE_BACKEND", "SURYA_MODEL_CHECKPOINT", "VLLM_DOCKER_IMAGE", "VLLM_GPU_TYPE", "VLLM_DTYPE",
        "VLLM_MAX_MODEL_LEN", "VLLM_GPU_MEMORY_UTILIZATION", "VLLM_ENABLE_MTP", "SURYA_INFERENCE_PARALLEL")}
    meta = {"parser": "marker2", "version": md.version("marker-pdf"), "surya": md.version("surya-ocr"),
            "settings": SETTINGS, "torch_device": os.environ.get("TORCH_DEVICE", "auto"),
            "ocr_inference": inference,
            "native": "JSONRenderer output of the same document, images left out"}
    run(load, convert, args, meta)


if __name__ == "__main__":
    main()
