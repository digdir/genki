"""PaddleOCR's two document pipelines on each page, in the paddle venv (paddleocr[doc-parser], paddlepaddle).

    convert_paddle.py pp-structurev3 <pages> <out>
    convert_paddle.py paddleocr-vl <pages> <out> --server http://127.0.0.1:8111/

pp-structurev3  PP-StructureV3 with its defaults, lang "no" (PP-OCRv5 detection, the Latin recogniser)
paddleocr-vl    PaddleOCR-VL-1.6: PaddleOCR's layout model in paddle, the VLM in an mlx-vlm server, the
                Apple Silicon setup the PaddleOCR docs give (`mlx_vlm.server --port 8111`)

Paddle runs on the CPU on a Mac. Each page's Markdown is the pipeline's own (`res.markdown`), images left out.
"""
import importlib.metadata as md
import sys
from pathlib import Path

from convert_common import arguments, run

VL_MODEL = "PaddlePaddle/PaddleOCR-VL-1.6"
MODELS = Path.home() / ".paddlex" / "official_models"


def downloaded():
    return sorted(p.name for p in MODELS.iterdir()) if MODELS.exists() else []


def main():
    side = sys.argv.pop(1)
    server = None
    if "--server" in sys.argv:
        i = sys.argv.index("--server")
        server = sys.argv[i + 1]
        del sys.argv[i:i + 2]
    a = arguments()
    before = set(downloaded())
    if side == "pp-structurev3":
        from paddleocr import PPStructureV3
        settings = {"pipeline": "PP-StructureV3", "lang": "no", "device": "cpu", "other": "library defaults"}
        pipeline = PPStructureV3(lang="no", device="cpu")
    elif side == "paddleocr-vl":
        from paddleocr import PaddleOCRVL
        settings = {"pipeline": "PaddleOCR-VL", "vl_rec_backend": "mlx-vlm-server", "vl_rec_api_model_name": VL_MODEL,
                    "device": "cpu (layout), mlx (VLM)", "other": "library defaults",
                    "mlx_vlm": md.version("mlx-vlm")}
        pipeline = PaddleOCRVL(vl_rec_backend="mlx-vlm-server", vl_rec_server_url=server,
                               vl_rec_api_model_name=VL_MODEL, device="cpu")
    else:
        raise SystemExit(f"unknown side {side}")

    def convert(pdf):
        results = list(pipeline.predict(str(pdf)))
        if len(results) != 1:
            raise ValueError(f"{len(results)} results for a one-page PDF")
        return results[0].markdown["markdown_texts"]

    meta = {"parser": "paddleocr", "version": md.version("paddleocr"), "paddlepaddle": md.version("paddlepaddle"),
            "paddlex": md.version("paddlex"), "settings": settings}
    run(convert, a.pages, a.out, {**meta, "models": downloaded()}, a.only)
    # Note: the models the run downloaded or found, from PaddleX's model folder; written again after the run
    # so a first run lists them too
    from convert_common import write_meta
    write_meta(a.out, {**meta, "models": downloaded(), "models_new_this_run": sorted(set(downloaded()) - before)})


if __name__ == "__main__":
    main()
