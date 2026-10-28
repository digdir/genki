#!/usr/bin/env bash
# The rest of the Kudos pilot's chained run (genki issue 92), after the small models: the full genki search for
# them, the index and scale benchmark, then Qwen3-Embedding-4B and -8B end to end with their full search. Each
# step logs to .data and the next step starts even if one fails; .data/chain-rest.log says what happened.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/.data"
repo="$here/../.."
log="$data/chain-rest.log"
step() { echo "$1 $(date -u +%FT%TZ)" >> "$log"; }
compare() { (cd "$repo" && npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts "$@"); }
stop_pid() { [ -f "$data/pids/$1.pid" ] && kill "$(cat "$data/pids/$1.pid")" 2>/dev/null; rm -f "$data/pids/$1.pid"; }
# An API runs as npx with a node child, so it is stopped by the process listening on its own port (830x)
stop_api() { lsof -ti "tcp:$1" -sTCP:LISTEN | xargs kill 2>/dev/null; rm -f "$data/pids/api-$2.pid"; }

while ! grep -q "chain finished" "$data/chain-small.log" 2>/dev/null; do sleep 60; done

step "full search small: start"
compare run 3 borealis,bge-m3,arctic-l-v2,qwen3-0-6b,pgvector > "$data/full-search-small.log" 2>&1 \
  && step "full search small: done" || step "full search small: FAILED"

# Free memory for the index benchmark: the small models' servers and APIs are done once their full search is
for pair in borealis:8301 bge-m3:8302 arctic-l-v2:8303 qwen3-0-6b:8304; do
  stop_pid "embed-${pair%%:*}"; stop_api "${pair##*:}" "${pair%%:*}"
done

step "index bench: start"
while ! grep -q "^exit 0" "$data/dbpedia-download.log" 2>/dev/null; do sleep 60; done
"$data/embed-venv/bin/python" "$here/indexes/bench_index.py" > "$data/index-bench.log" 2>&1 \
  && step "index bench: done" || step "index bench: FAILED"
docker stop genki-kudos-pilot-bench > /dev/null 2>&1

for key in qwen3-4b qwen3-8b; do
  if [ "$key" = qwen3-8b ]; then stop_pid embed-qwen3-4b; stop_api 8305 qwen3-4b; fi
  step "$key: start"
  "$here/run_model.sh" "$key" > "$data/run-model-$key.log" 2>&1 && step "$key: ingested and scored" || step "$key: FAILED"
  compare run 3 "$key" > "$data/full-search-$key.log" 2>&1 && step "$key: full search done" || step "$key: full search FAILED"
done
step "chain finished"
