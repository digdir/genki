#!/usr/bin/env bash
# The Kudos pilot's second model round (genki issue 92): gte-multilingual-base, F2LLM-v2-0.6B, harrier-oss-v1-0.6b
# and pplx-embed-v1-0.6b, each through the same steps as the first round's models: run_model.sh (databases, MLX
# pre-embed where models.json says `mlx`, server, API, ingest, vector scores), the full genki search with the planner
# (3 rounds of the 76 draft questions) and the search without the planner (676 questions).
# The next model's embedding starts while one model searches; one model searches at a time, and a model's server and
# API stop after its searches. Steps log to .data; .data/chain-round2.log says what happened.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/.data"
repo="$here/../.."
py="$data/embed-venv/bin/python"
log="$data/chain-round2.log"
step() { echo "$1 $(date -u +%FT%TZ)" >> "$log"; }
compare() { (cd "$repo" && npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts "$@"); }
field() { python3 -c "import json; m=next(m for m in json.load(open('$here/models.json'))['models'] if m['key']=='$1'); print(m.get('$2') or '')"; }
stop_pid() { [ -f "$data/pids/$1.pid" ] && kill "$(cat "$data/pids/$1.pid")" 2>/dev/null; rm -f "$data/pids/$1.pid"; }
stop_api() { lsof -ti "tcp:$1" -sTCP:LISTEN | xargs kill 2>/dev/null; rm -f "$data/pids/api-$2.pid"; }

searches() {
  local key="$1"
  compare run 3 "$key" > "$data/full-search-$key.log" 2>&1 \
    && step "$key: full search done" || step "$key: full search FAILED"
  (cd "$here" && "$py" score_search.py "$key" > "$data/search-$key.log" 2>&1) \
    && step "$key: search without planner done" || step "$key: search without planner FAILED"
  stop_pid "embed-$key"; stop_api "$(field "$key" api)" "$key"
}

searching=""
for key in gte-ml-base f2llm-0-6b harrier-0-6b pplx-0-6b; do
  step "$key: start"
  if ! "$here/run_model.sh" "$key" > "$data/run-model-$key.log" 2>&1; then
    step "$key: FAILED"
    continue
  fi
  step "$key: ingested and scored"
  [ -n "$searching" ] && wait "$searching"
  searches "$key" &
  searching=$!
done
wait
step "chain finished"
