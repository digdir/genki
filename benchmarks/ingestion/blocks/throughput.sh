#!/usr/bin/env bash
# Throughput of docling-tess on one CPU host: the documents split across N containers that run at the same time,
# each with Docling num_threads = vCPUs / N. One round per N, one after another, each with the machine to itself.
#
#   DOCUMENTS=documents-run2.json HOST_LABEL=azure-D32as_v6-swedencentral-run2 ./throughput.sh 1 4 8
#
# Run after run.sh has built the docling image and filled the model cache (.data/home). Per round N it writes
# $RUN/throughput/n<N>/ with one folder per worker (w<i>: the converter's usual output, its document list and
# log), cpu.csv (/proc/stat every 2 s: time, then the cpu line's counters) and round.json (wall clock of the round,
# containers started to all exited). throughput.py turns that into results/<HOST_LABEL>/throughput.md.
# The split balances pages (largest document first to the worker with the fewest pages); scans take longer
# per page than digital pages, so workers can still finish at different times, and the report says how far apart.
set -euo pipefail
cd "$(dirname "$0")"
: "${HOST_LABEL:?set HOST_LABEL}"
export DOCUMENTS="${DOCUMENTS:-documents.json}"
DATA="${BLOCKS_DATA:-$PWD/.data}"
RUN="$DATA/runs/$HOST_LABEL"
CPUS=$(nproc)
[[ $# -gt 0 ]] || set -- 1 4 8
python3 fetch.py "$DATA/pdf"
docker build -q -f docker/Dockerfile.docling -t genki-blocks-docling . > /dev/null

for n in "$@"; do
  round="$RUN/throughput/n$n"
  if [[ -f "$round/round.json" ]]; then echo "== throughput n=$n already done"; continue; fi
  rm -rf "$round"; mkdir -p "$round"
  threads=$(( CPUS / n )); (( threads < 1 )) && threads=1
  python3 - "$DOCUMENTS" "$n" "$round" <<'EOF'
import json, sys
from pathlib import Path
docs = json.loads(Path(sys.argv[1]).read_text())["documents"]
n, round_dir = int(sys.argv[2]), Path(sys.argv[3])
workers = [[] for _ in range(n)]
for d in sorted(docs, key=lambda d: -d["pages"]):
    min(workers, key=lambda w: sum(x["pages"] for x in w)).append(d)
for i, w in enumerate(workers):
    (round_dir / f"w{i}").mkdir()
    (round_dir / f"w{i}" / "documents.json").write_text(json.dumps({"documents": w}, indent=1) + "\n")
    print(f"w{i}: {len(w)} documents, {sum(x['pages'] for x in w)} pages")
EOF
  echo "== throughput n=$n ($threads threads each)"
  ( while :; do echo "$(date +%s.%N) $(head -1 /proc/stat)"; sleep 2; done ) > "$round/cpu.csv" &
  sampler=$!
  start=$(date +%s.%N)
  pids=()
  for (( i = 0; i < n; i++ )); do
    w="$round/w$i"
    docker run --rm --shm-size=8g --user "$(id -u):$(id -g)" -e HOST_LABEL -e DOCLING_THREADS="$threads" \
      -e HOME=/home/runner -e HF_HOME=/home/runner/.cache/huggingface \
      -v "$DATA/pdf:/pdf:ro" -v "$w:/out" -v "$DATA/home:/home/runner" \
      genki-blocks-docling /pdf /out --documents /out/documents.json --device cpu --ocr tess > "$w/log.txt" 2>&1 &
    pids+=($!)
  done
  failed=0
  for pid in "${pids[@]}"; do wait "$pid" || failed=$((failed + 1)); done
  end=$(date +%s.%N)
  kill "$sampler" 2>/dev/null || true
  printf '{"workers": %d, "threads_each": %d, "cpus": %d, "start": %s, "end": %s, "failed_workers": %d}\n' \
    "$n" "$threads" "$CPUS" "$start" "$end" "$failed" > "$round/round.json"
  echo "== throughput n=$n done in $(python3 -c "print(round($end - $start))") s, failed workers: $failed"
done
python3 throughput.py "$RUN" > /dev/null
mkdir -p "results/$HOST_LABEL"
cp "$RUN/throughput/throughput.md" "$RUN/throughput/throughput.json" "results/$HOST_LABEL/"
echo "EXIT=0 throughput"
