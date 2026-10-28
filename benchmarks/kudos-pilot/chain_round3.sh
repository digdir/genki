#!/usr/bin/env bash
# The Kudos pilot's third model round (genki issue 92): text-embedding-3-small, and the best models cut to fewer
# dimensions from their stored vectors (shorten.py): Arctic Embed L v2 at 512, Qwen3-Embedding-4B and -8B at 1,024 and
# 1,536. Each goes through the same steps as the earlier rounds: run_model.sh, the full genki search with the planner
# (3 rounds of the 76 draft questions) and the search without the planner (676 questions). One model at a time, since
# the Qwen3-8B server alone takes 16 GB.
#
#   ./chain_round3.sh [key ...]   # the six models by default; key:noplan runs only the search without the planner
#
# A search step after which the model's API has logged skipped reranking or failed searches (a dropped network, say)
# runs again, up to three times, so no published answer lacks ColBERT. The Mac is kept from idle sleep while it runs.
# .data/chain-round3.log says what happened.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/.data"
repo="$here/../.."
py="$data/embed-venv/bin/python"
log="$data/chain-round3.log"
step() { echo "$1 $(date -u +%FT%TZ)" >> "$log"; }
compare() { (cd "$repo" && npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts "$@"); }
field() { python3 -c "import json; m=next(m for m in json.load(open('$here/models.json'))['models'] if m['key']=='$1'); print(m.get('$2') or '')"; }
stop_pid() { [ -f "$data/pids/$1.pid" ] && kill "$(cat "$data/pids/$1.pid")" 2>/dev/null; }
stop_api() { lsof -ti "tcp:$1" -sTCP:LISTEN | xargs kill 2>/dev/null; }
stop() { stop_pid "embed-$1"; stop_api "$(field "$1" api)"; }
# Skipped reranking and failed searches the model's API has logged so far
marks() { local n; n=$(grep -c -E 'RERANKING DEGRADED|"task failed"' "$data/api-$1.log" 2>/dev/null); echo "${n:-0}"; }
full() { compare run 3 "$1" > "$data/full-search-$1.log" 2>&1; }
noplan() { (cd "$here" && "$py" score_search.py "$1" > "$data/search-$1.log" 2>&1); }
attempt() {
  local what="$1" key="$2" before
  for try in 1 2 3; do
    before="$(marks "$key")"
    if "$3" "$key"; then
      if [ "$(marks "$key")" = "$before" ]; then
        step "$key: $what done"
        return 0
      fi
      step "$key: $what skipped reranking or failed searches; again ($try)"
    else
      step "$key: $what FAILED ($try)"
    fi
  done
  step "$key: $what gave up"
}

caffeinate -i -s -w $$ &
[ $# -gt 0 ] && entries=("$@") || entries=(te3-small arctic-l-v2-512 qwen3-4b-1024 qwen3-4b-1536 qwen3-8b-1024 qwen3-8b-1536)
for entry in "${entries[@]}"; do
  key="${entry%%:*}"
  step "$key: start"
  if ! "$here/run_model.sh" "$key" > "$data/run-model-$key.log" 2>&1; then
    step "$key: FAILED"
    stop "$key"
    continue
  fi
  step "$key: ingested and scored"
  [ "$entry" = "$key:noplan" ] || attempt "full search" "$key" full
  attempt "search without planner" "$key" noplan
  stop "$key"
done
step "chain finished"
