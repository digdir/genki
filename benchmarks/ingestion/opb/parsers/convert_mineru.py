"""MinerU 4.1.6 on each page, in the mineru venv (mineru[full], mineru-vl-utils[mlx]), telemetry off.

Its default PDF tier (standard: small models plus the MinerU2.5-Pro VLM), OCR mode auto, image analysis on
(the CLI's defaults). With --no-image-analysis (side mineru-noimg) image analysis is off, so MinerU writes no
model-made descriptions of pictures into the text; the rest is unchanged. The VLM runs on MinerU's mlx engine, which loads the official weights
(opendatalab/MinerU2.5-Pro-2605-1.2B, as vLLM would on an NVIDIA host); macOS's default llama.cpp engine
loads a quantised copy from another Hugging Face account instead.
"""
import os

os.environ["MINERU_TELEMETRY_DISABLED"] = "1"

import importlib.metadata as md  # noqa: E402
import re  # noqa: E402

from convert_common import arguments, run  # noqa: E402

import sys  # noqa: E402

TIER, OCR_MODE, ENGINE = "standard", "auto", "mlx"
IMAGE_ANALYSIS = "--no-image-analysis" not in sys.argv
if not IMAGE_ANALYSIS:
    sys.argv.remove("--no-image-analysis")
# MinerU inlines each picture as a base64 data URI; the link stays, the bytes go (no test reads them)
DATA_URI = re.compile(r"(!\[[^\]]*\]\()data:[^)]*\)")


def main():
    a = arguments()
    from mineru.config import VlmConfig
    from mineru.model.registry import small_model_repo, vlm_model_repo
    from mineru.parser import MinerUParser

    parser = MinerUParser(tier=TIER, parse_mode=OCR_MODE, image_analysis=IMAGE_ANALYSIS,
                          vlm_config=VlmConfig(engine=ENGINE))
    small, vlm = small_model_repo(), vlm_model_repo(ENGINE)
    meta = {"parser": "mineru" if IMAGE_ANALYSIS else "mineru-noimg", "version": md.version("mineru"), "mineru_vl_utils": md.version("mineru-vl-utils"),
            "mlx_vlm": md.version("mlx-vlm"), "torch": md.version("torch"),
            "settings": {"tier": TIER, "ocr_mode": OCR_MODE, "image_analysis": IMAGE_ANALYSIS, "vlm_engine": ENGINE,
                         "telemetry": "off", "images": "data URIs removed from the Markdown"},
            "models": {"small": small.name, "vlm": vlm.name}}
    run(lambda pdf: DATA_URI.sub(r"\1)", parser.parse(pdf).markdown()), a.pages, a.out, meta, a.only)


if __name__ == "__main__":
    main()
