"""MinerU 4.1.6 on whole documents, with the settings the page tests graded (opb/parsers/convert_mineru.py):
the standard tier (small models plus the MinerU2.5-Pro VLM), OCR mode auto, image analysis on, telemetry off.
Native output: MinerU's middle JSON (ParseResult.to_dict(), schema docvortex.middle), which MinerU itself
renders Markdown from offline; blocks in reading order per page, with boxes as fractions of the page.

    python convert_mineru.py <pdfs> <out> [--device auto|vllm|mlx|llama-cpp] [--no-image-analysis]

--device picks the VLM engine: auto lets MinerU choose (vLLM on Linux with CUDA, from mineru[full]); the page
tests ran mlx on a Mac, which loads the same official weights. --no-image-analysis turns off the model-written
descriptions of pictures, which otherwise land in the text (parser mineru-noimg).
"""
import os

os.environ["MINERU_TELEMETRY_DISABLED"] = "1"

import importlib.metadata as md  # noqa: E402
import re  # noqa: E402

from common import arguments, run  # noqa: E402

TIER, OCR_MODE = "standard", "auto"
# MinerU inlines each picture as a base64 data URI in its Markdown; the link stays, the bytes go
DATA_URI = re.compile(r"(!\[[^\]]*\]\()data:[^)]*\)")


def version(package):
    try:
        return md.version(package)
    except md.PackageNotFoundError:
        return None


def main():
    import sys
    image_analysis = "--no-image-analysis" not in sys.argv
    if not image_analysis:
        sys.argv.remove("--no-image-analysis")
    args = arguments(["auto", "vllm", "mlx", "llama-cpp"])
    from mineru.config import VlmConfig
    from mineru.parser import MinerUParser

    def load():
        return MinerUParser(tier=TIER, parse_mode=OCR_MODE, image_analysis=image_analysis,
                            vlm_config=VlmConfig(engine=args.device))

    def convert(parser, pdf):
        result = parser.parse(pdf)
        return result.to_dict(), DATA_URI.sub(r"\1)", result.markdown())

    from mineru.model.registry import small_model_repo, vlm_model_repo
    meta = {"parser": "mineru" if image_analysis else "mineru-noimg", "version": md.version("mineru"), "mineru_vl_utils": version("mineru-vl-utils"),
            "docvortex": version("docvortex"), "vllm": version("vllm"), "mlx_vlm": version("mlx-vlm"),
            "settings": {"tier": TIER, "ocr_mode": OCR_MODE, "image_analysis": image_analysis,
                         "vlm_engine": args.device, "telemetry": "off"},
            "models": {"small": small_model_repo().name,
                       "vlm": vlm_model_repo(args.device if args.device != "auto" else "vllm").name},
            "native": "ParseResult.to_dict() (docvortex.middle), image bytes left out"}
    run(load, convert, args, meta)


if __name__ == "__main__":
    main()
