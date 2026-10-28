#!/usr/bin/env bash
# One model of models.json end to end for the Kudos pilot's comparison: its databases (setup_models.py), for models
# marked `mlx` the pages embedded on MLX into the cache (pre_embed.py), for shortened models (`shortenedFrom`) the full
# model's stored page vectors cut into the cache (shorten.py), its embedding server and API (left running, PIDs in
# .data/pids; the server embeds the questions, and models from genki's own catalog (`catalogModel`) need none), the
# ingest of all 300 documents, and the vector-only scores (score_vectors.py). Logs to .data/run-model-<key>.log.
#
#   benchmarks/kudos-pilot/run_model.sh bge-m3
set -euo pipefail
key="$1"
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/.data"
py="$data/embed-venv/bin/python"
mkdir -p "$data/pids"
field() { python3 -c "import json; m=next(m for m in json.load(open('$here/models.json'))['models'] if m['key']=='$key'); print(m.get('$1') or '')"; }
wait_for() { for _ in $(seq 1 180); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 2; done; echo "timed out waiting for $1"; return 1; }
alive() { [ -f "$data/pids/$1.pid" ] && kill -0 "$(cat "$data/pids/$1.pid")" 2>/dev/null; }

cd "$here"
echo "== $key $(date -u +%FT%TZ) setup"
"$py" setup_models.py "$key"

# Qwen3-architecture models embed every page on MLX first (pre_embed.py), straight into the model's genki embedding
# cache: faster on this GPU than through the server, and the ingest below then reads the cache
if [ "$(field mlx)" = True ]; then
  echo "== $key $(date -u +%FT%TZ) pre-embed on MLX"
  HF_HOME="$data/hf" HF_HUB_OFFLINE=1 "$py" pre_embed.py "$key"
fi

# A shortened model takes its pages from the full model's stored vectors; its server cuts the questions the same way
shortened="$(field shortenedFrom)"
if [ -n "$shortened" ]; then
  echo "== $key $(date -u +%FT%TZ) pages cut from $shortened"
  "$py" shorten.py "$key"
fi

server="$(field server)"
if [ -n "$server" ]; then
  venv="$(field venv)"  # the environment that serves the model; embed-venv unless models.json says otherwise
  if ! alive "embed-$key"; then
    EMBED_MODEL="$(field hf)" EMBED_REVISION="$(field revision)" EMBED_PORT="$server" EMBED_DTYPE="$(field dtype)" \
      EMBED_BATCH="$(field batch)" EMBED_TRUST_REMOTE_CODE="$([ "$(field trustRemoteCode)" = True ] && echo 1)" \
      EMBED_DIMENSIONS="$([ -n "$shortened" ] && field dimensions)" \
      nohup "$data/${venv:-embed-venv}/bin/python" embed_server.py > "$data/embed-$key.log" 2>&1 &
    echo $! > "$data/pids/embed-$key.pid"
  fi
  wait_for "http://127.0.0.1:$server/health"
fi

api="$(field api)"
if ! alive "api-$key"; then
  nohup "$here/start_model_api.sh" "$key" > /dev/null 2>&1 &
  echo $! > "$data/pids/api-$key.pid"
fi
wait_for "http://localhost:$api/health"

echo "== $key $(date -u +%FT%TZ) ingest"
started=$(date +%s)
python3 run_ingest.py --api "http://localhost:$api" --dataset "digdir/kudos-next-$key"
echo "ingest_seconds=$(( $(date +%s) - started ))"
if [ -n "$server" ]; then
  curl -s "http://127.0.0.1:$server/health" > "$data/embed-stats-$key.json"
  cat "$data/embed-stats-$key.json"; echo
fi

echo "== $key $(date -u +%FT%TZ) vector scores"
"$py" score_vectors.py "$key"
echo "== $key $(date -u +%FT%TZ) done"
