"""Marker 2.1 on each page, in the marker2 venv, with the Marker service's settings (PR 91) that 2.1 still has.

    convert_marker.py <pages> <out>                              # OCR model in llama.cpp (llama-server on PATH)
    convert_marker.py <pages> <out> --mlx-model <dir>            # OCR model in mlx_vlm.server instead

The service sets languages "no,en", which Marker 2.x no longer reads, and paginates its output, which a
one-page PDF doesn't need. Mode "balanced" is Marker 2.1's default on CUDA, the GPU host it would run on; on
a Mac it would pick "fast". Marker's own detectors run in torch on MPS. Its OCR model
(datalab-to/surya-ocr-2.5, a VLM since Surya 0.2x) runs behind an inference server: vLLM on NVIDIA,
llama.cpp elsewhere (Datalab's GGUF, datalab-to/surya-ocr-2.5-gguf). The MLX route runs an unquantised bf16
copy built with Surya's own script, `surya/scripts/build_mlx.py --checkpoint datalab-to/surya-ocr-2.5`; on
4 November 2026 it gave U+FFFD in place of many æ, ø and å, so it is not used for grading.
"""
import importlib.metadata as md
import os
import shutil
import sys
from pathlib import Path

from convert_common import arguments, run

SETTINGS = {"output_format": "markdown", "disable_image_extraction": True, "mode": "balanced"}


def main():
    mlx_model = None
    if "--mlx-model" in sys.argv:
        i = sys.argv.index("--mlx-model")
        mlx_model = Path(sys.argv[i + 1]).resolve()
        del sys.argv[i:i + 2]
        os.environ["SURYA_INFERENCE_BACKEND"] = "mlx"
        os.environ["SURYA_MLX_MODEL"] = str(mlx_model)
    else:
        if not shutil.which(os.environ.get("LLAMA_CPP_BINARY", "llama-server")):
            raise SystemExit("llama-server not found: brew install llama.cpp, or pass --mlx-model")
        os.environ["SURYA_INFERENCE_BACKEND"] = "llamacpp"
    a = arguments()
    from marker.config.parser import ConfigParser
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.settings import settings as marker_settings
    from surya.settings import settings as surya_settings

    config = ConfigParser(dict(SETTINGS))
    converter = PdfConverter(config=config.generate_config_dict(), artifact_dict=create_model_dict(),
                             processor_list=config.get_processors(), renderer=config.get_renderer(),
                             llm_service=config.get_llm_service())
    if mlx_model:
        ocr = {"backend": "mlx", "mlx_vlm": md.version("mlx-vlm"),
               "model": f"{surya_settings.SURYA_MODEL_CHECKPOINT}, snapshot {mlx_model.name.removesuffix('-mlx')}, bf16"}
    else:
        ocr = {"backend": "llamacpp", "binary": shutil.which(surya_settings.LLAMA_CPP_BINARY),
               "model": f"{surya_settings.SURYA_GGUF_REPO}/{surya_settings.SURYA_GGUF_MODEL_FILE}"}
    models = {k: getattr(surya_settings, k) for k in dir(surya_settings) if k.endswith("CHECKPOINT")}
    meta = {"parser": "marker-pdf", "version": md.version("marker-pdf"), "surya": md.version("surya-ocr"),
            "torch": md.version("torch"), "settings": SETTINGS, "device": marker_settings.TORCH_DEVICE_MODEL,
            "ocr_inference": ocr, "models": models}
    run(lambda pdf: converter(str(pdf)).markdown, a.pages, a.out, meta, a.only)


if __name__ == "__main__":
    main()
