#!/bin/sh
# Convert every dataset page with each parser that runs on this Mac, side by side (issue 337).
# Seconds per page are taken with the parsers sharing the machine, so they are a note, never a ranking.
#   INGESTION_BENCHMARK_DATA=... parsers/run_all.sh [side...]
# PaddleOCR-VL needs `mlx_vlm.server --host 127.0.0.1 --port 8111 --model PaddlePaddle/PaddleOCR-VL-1.6`
# running from the paddle venv; Marker 2.1 needs llama-server on PATH (brew install llama.cpp).
set -u
cd "$(dirname "$0")"
VENVS=../.data/venvs
LOGS=../.data/logs
OUT="${INGESTION_BENCHMARK_DATA:?set INGESTION_BENCHMARK_DATA}/opb/conversions"
PAGES="$OUT/pages"
mkdir -p "$LOGS"
sides="${*:-pp-structurev3 paddleocr-vl mineru docling}"
for side in $sides; do
  case "$side" in
    pp-structurev3) cmd="$VENVS/paddle/bin/python convert_paddle.py pp-structurev3 $PAGES $OUT/$side" ;;
    paddleocr-vl) cmd="$VENVS/paddle/bin/python convert_paddle.py paddleocr-vl $PAGES $OUT/$side --server http://127.0.0.1:8111/" ;;
    mineru) cmd="$VENVS/mineru/bin/python convert_mineru.py $PAGES $OUT/$side" ;;
    docling) cmd="$VENVS/docling/bin/python convert_docling.py $PAGES $OUT/$side" ;;
    docling-no) cmd="$VENVS/docling/bin/python convert_docling.py $PAGES $OUT/$side --ocr no" ;;
    docling-tess) cmd="$VENVS/docling/bin/python convert_docling.py $PAGES $OUT/$side --ocr tess" ;;
    docling-easyocr-en) cmd="$VENVS/docling/bin/python convert_docling.py $PAGES $OUT/$side --ocr easy-en" ;;
    mineru-noimg) cmd="$VENVS/mineru/bin/python convert_mineru.py $PAGES $OUT/$side --no-image-analysis" ;;
    docling-rapid) cmd="$VENVS/docling-rapid/bin/python convert_docling.py $PAGES $OUT/$side --ocr rapid" ;;
    marker-2.1) cmd="$VENVS/marker2/bin/python convert_marker.py $PAGES $OUT/$side" ;;
    *) echo "unknown side $side"; exit 2 ;;
  esac
  ( $cmd > "$LOGS/run-$side.log" 2>&1; echo "DONE $side exit $?" >> "$LOGS/run-$side.log" ) &
done
wait
