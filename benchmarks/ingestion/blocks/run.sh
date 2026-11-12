#!/usr/bin/env bash
# Convert the PDFs of documents.json with each parser in its own container on this host, one parser at a time
# so each has the machine to itself, then normalise the output to blocks and compare the structure.
#
#   HOST_LABEL=azure-NC4as_T4_v3-swedencentral ./run.sh [--cpu] [parser ...]
#   ONLY="102474 5944" HOST_LABEL=... ./run.sh marker-llm     # convert only these documents
#   DOCUMENTS=documents-run2.json HOST_LABEL=... ./run.sh ...  # another document list in this folder (default documents.json)
#
# Parsers: docling docling-no mineru marker (default: all four); by name only: marker2 (Marker 2.1), docling-tess
# (Tesseract, Norwegian), docling-tess-<variant> (one setting changed: repair, nocells, egret, noreng, best), docling-rapid (RapidOCR via onnxruntime), mineru-noimg (no picture descriptions), marker-strip
# (Marker re-OCRs old OCR text layers), marker-llm (use_llm with Azure OpenAI; AZURE_OPENAI_* in the
# environment). Needs
# Docker, Python 3.9+, and on a GPU host the NVIDIA driver and container toolkit (docker run --gpus). --cpu runs
# without a GPU; MinerU's standard tier and Marker 2.1's OCR model need vLLM on a GPU, so --cpu skips them. Output: $BLOCKS_DATA/runs/$HOST_LABEL (default .data/runs/...),
# and the small files worth keeping (structure.md, meta, timings, GPU samples) are copied to results/$HOST_LABEL.
set -euo pipefail
cd "$(dirname "$0")"
: "${HOST_LABEL:?set HOST_LABEL to name this host, for example azure-NC4as_T4_v3-swedencentral}"

GPU=1
if [[ "${1:-}" == "--cpu" ]]; then GPU=0; shift; fi
PARSERS=("$@")
[[ ${#PARSERS[@]} -eq 0 ]] && PARSERS=(docling docling-no mineru marker)

export DOCUMENTS="${DOCUMENTS:-documents.json}"
[[ -f "$DOCUMENTS" ]] || { echo "no document list $DOCUMENTS"; exit 1; }
DATA="${BLOCKS_DATA:-$PWD/.data}"
RUN="$DATA/runs/$HOST_LABEL"
mkdir -p "$RUN/logs" "$DATA/home"
python3 fetch.py "$DATA/pdf"

image_of() {
  case "$1" in
    docling|docling-no|docling-tess|docling-tess-*) echo docling ;;
    mineru-noimg) echo mineru ;;
    marker-strip|marker-llm) echo marker ;;
    *) echo "$1" ;;
  esac
}
device_of() {
  case "$1:$GPU" in
    mineru:1|mineru-noimg:1) echo auto ;;      # MinerU picks vLLM on CUDA
    *:1) echo cuda ;;
    *:0) echo cpu ;;
  esac
}

for parser in "${PARSERS[@]}"; do
  if [[ ( "$parser" == mineru* || "$parser" == marker2 ) && $GPU -eq 0 ]]; then
    echo "skipping $parser: it needs vLLM on a GPU"; continue
  fi
  image="genki-blocks-$(image_of "$parser")"
  docker build -q -f "docker/Dockerfile.$(image_of "$parser")" -t "$image" . > /dev/null
  out="$RUN/$parser"
  mkdir -p "$out"
  extra=()
  case "$parser" in
    docling-no) extra=(--ocr no) ;;
    docling-tess) extra=(--ocr tess) ;;
    docling-tess-*) extra=(--ocr tess --variant "${parser#docling-tess-}") ;;
    docling-rapid) extra=(--ocr rapid) ;;
    mineru-noimg) extra=(--no-image-analysis) ;;
    marker-strip) extra=(--strip-existing-ocr) ;;
    marker-llm) extra=(--use-llm) ;;
  esac
  # Marker 2.1: Surya starts its vLLM server as a sibling container through the Docker socket and reaches it on
  # the host network. Its own settings pick batch size and memory by GPU type, and float16 where the GPU has no
  # bfloat16 (compute capability below 8.0, such as the T4). vLLM's model cache gets its own folder, as vLLM
  # writes it as root.
  sibling=()
  if [[ "$parser" == marker2 ]]; then
    name=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
    cap=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1)
    case "$name" in
      *T4*) gpu_type=t4 ;; *A100*80GB*) gpu_type=a100-80 ;; *A100*) gpu_type=a100 ;; *H100*) gpu_type=h100 ;;
      *L40S*) gpu_type=l40s ;; *L4*) gpu_type=l4 ;; *A10*) gpu_type=a10 ;; *) gpu_type=4090 ;;
    esac
    dtype=bfloat16; [[ "${cap%%.*}" -lt 8 ]] && dtype=float16
    mkdir -p "$DATA/vllm-hf"
    sibling=(-v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)"
             --network host -e SURYA_INFERENCE_BACKEND=vllm -e VLLM_GPU_TYPE="$gpu_type" -e VLLM_DTYPE="$dtype"
             -e DOCKER_HF_CACHE_PATH="$DATA/vllm-hf")
  fi
  gpu_flags=()
  monitor=""
  if [[ $GPU -eq 1 ]]; then
    gpu_flags=(--gpus all)
    nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used,memory.total --format=csv -l 2 > "$out/gpu.csv" &
    monitor=$!
  fi
  echo "== $parser ($image, device $(device_of "$parser"))"
  # Model downloads and caches live in $DATA/home, so a second run on the host downloads nothing
  llm_env=()
  [[ "$parser" == marker-llm ]] && llm_env=(-e AZURE_OPENAI_ENDPOINT -e AZURE_OPENAI_API_KEY -e AZURE_OPENAI_DEPLOYMENT \
    -e AZURE_OPENAI_API_VERSION)
  docker run --rm "${gpu_flags[@]}" "${sibling[@]}" "${llm_env[@]}" --shm-size=8g --user "$(id -u):$(id -g)" \
    -e HOST_LABEL -e HOME=/home/runner -e HF_HOME=/home/runner/.cache/huggingface \
    -v "$DATA/pdf:/pdf:ro" -v "$out:/out" -v "$DATA/home:/home/runner" -v "$PWD/$DOCUMENTS:/documents.json:ro" \
    "$image" /pdf /out --documents /documents.json --device "$(device_of "$parser")" "${extra[@]}" ${ONLY:+--only $ONLY} 2>&1 | tee "$RUN/logs/$parser.log" \
    || echo "$parser failed: see $RUN/logs/$parser.log"
  [[ -n "$monitor" ]] && kill "$monitor" 2>/dev/null || true
  # A vLLM server Surya started and left behind (if the converter crashed)
  [[ "$parser" == marker2 ]] && docker ps -q --filter name=surya-vllm | xargs -r docker rm -f > /dev/null || true
done

python3 normalise.py "$RUN"
python3 compare.py "$RUN"

keep="results/$HOST_LABEL"
mkdir -p "$keep"
cp "$RUN/structure.md" "$keep/"
for parser in "${PARSERS[@]}"; do
  [[ -d "$RUN/$parser" ]] || continue
  mkdir -p "$keep/$parser"
  for f in meta.json timings.jsonl gpu.csv; do
    [[ -f "$RUN/$parser/$f" ]] && cp "$RUN/$parser/$f" "$keep/$parser/"
  done
done
echo "done: $RUN (blocks and native output), $keep (structure.md, meta, timings)"
