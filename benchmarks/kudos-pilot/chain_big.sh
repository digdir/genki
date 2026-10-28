#!/usr/bin/env bash
# The last part of the Kudos pilot's chained run (genki issue 92), after the index benchmark:
# - in parallel: the search without the planner (score_search.py) for the baseline and the four small models;
# - Qwen3-Embedding-4B, then -8B: pages embedded on MLX into the cache, ingest, vector scores (run_model.sh), the
#   full genki search with the planner (3 rounds), and the search without the planner. 4B's server and API stop
#   before 8B starts, to leave it the memory.
# Steps log to .data; .data/chain-big.log says what happened.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/.data"
repo="$here/../.."
py="$data/embed-venv/bin/python"
log="$data/chain-big.log"
step() { echo "$1 $(date -u +%FT%TZ)" >> "$log"; }
compare() { (cd "$repo" && npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts "$@"); }
field() { python3 -c "import json; m=next(m for m in json.load(open('$here/models.json'))['models'] if m['key']=='$1'); print(m['$2'] or '')"; }
wait_for() { for _ in $(seq 1 180); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
alive() { [ -f "$data/pids/$1.pid" ] && kill -0 "$(cat "$data/pids/$1.pid")" 2>/dev/null; }
stop_pid() { [ -f "$data/pids/$1.pid" ] && kill "$(cat "$data/pids/$1.pid")" 2>/dev/null; rm -f "$data/pids/$1.pid"; }
stop_api() { lsof -ti "tcp:$1" -sTCP:LISTEN | xargs kill 2>/dev/null; rm -f "$data/pids/api-$2.pid"; }
serve() {
  local key="$1" server api
  server="$(field "$key" server)"; api="$(field "$key" api)"
  if ! alive "embed-$key"; then
    (cd "$here" && EMBED_MODEL="$(field "$key" hf)" EMBED_REVISION="$(field "$key" revision)" EMBED_PORT="$server" \
      EMBED_DTYPE="$(field "$key" dtype)" EMBED_BATCH="$(field "$key" batch)" \
      nohup "$py" embed_server.py > "$data/embed-$key.log" 2>&1 & echo $! > "$data/pids/embed-$key.pid")
  fi
  wait_for "http://127.0.0.1:$server/health"
  if ! curl -sf "http://localhost:$api/health" >/dev/null 2>&1; then
    nohup "$here/start_model_api.sh" "$key" > /dev/null 2>&1 &
    echo $! > "$data/pids/api-$key.pid"
  fi
  wait_for "http://localhost:$api/health"
}

small_search() {
  step "search without planner, small models: start"
  # The baseline API gets the generated config, which has the no-planner services
  lsof -ti tcp:8096 -sTCP:LISTEN | xargs kill 2>/dev/null; sleep 3
  (cd "$repo/apps/api" && PORT=8096 GENAI_DEV_MODE=true CONFIG_DIR="$data/config" \
    DATABASE_URL=postgres://genai:genai-local-only@127.0.0.1:55442/genai DATABASE_RUNTIME_URL= \
    KNOWLEDGE_DATABASE_URL=postgres://genai:genai-local-only@127.0.0.1:55443/knowledge \
    DOCUMENT_CONVERTER=marker MARKER_URL=http://localhost:8091/api/v1/marker-pdf-to-markdown \
    MARKER_API_KEY="$(cat "$data/marker-api-key")" TYPESENSE_LOCAL_URL=http://127.0.0.1:8108 \
    TYPESENSE_LOCAL_KEY="$(cat "$data/typesense-local-key")" LOCAL_EMBEDDINGS_KEY=local TRACES_ENDPOINT= \
    LANGFUSE_SECRET_KEY= nohup npx tsx --conditions=source src/main.ts > "$data/api-pilot.log" 2>&1 &)
  wait_for http://localhost:8096/health
  for key in borealis bge-m3 arctic-l-v2 qwen3-0-6b; do serve "$key"; done
  (cd "$here" && "$py" score_search.py baseline borealis bge-m3 arctic-l-v2 qwen3-0-6b > "$data/search-small.log" 2>&1) \
    && step "search without planner, small models: done" || step "search without planner, small models: FAILED"
  for pair in borealis:8301 bge-m3:8302 arctic-l-v2:8303 qwen3-0-6b:8304; do
    stop_pid "embed-${pair%%:*}"; stop_api "${pair##*:}" "${pair%%:*}"
  done
}

small_search &

for key in qwen3-4b qwen3-8b; do
  if [ "$key" = qwen3-8b ]; then stop_pid embed-qwen3-4b; stop_api 8305 qwen3-4b; fi
  step "$key: start"
  "$here/run_model.sh" "$key" > "$data/run-model-$key.log" 2>&1 && step "$key: ingested and scored" || step "$key: FAILED"
  compare run 3 "$key" > "$data/full-search-$key.log" 2>&1 && step "$key: full search done" || step "$key: full search FAILED"
  (cd "$here" && "$py" score_search.py "$key" > "$data/search-$key.log" 2>&1) \
    && step "$key: search without planner done" || step "$key: search without planner FAILED"
done
wait
step "chain finished"
