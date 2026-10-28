#!/usr/bin/env bash
# genki's search without the planner taken apart (genki issue 92): each of common.SEARCH_STEPS for the keys in
# common.STEP_KEYS, through the services setup_models.py writes (score_search.py --step). Needs the pilot API
# (start_model_api.sh baseline) and pplx-embed-v1-0.6b's server and API running with the config setup_models.py wrote.
#
#   ./chain_steps.sh [step ...]   # every step by default
#
# A step after which an API has logged skipped reranking or failed searches (a dropped network, say) runs again, up
# to three times, so no published answer of a ColBERT step lacks ColBERT. The Mac is kept from idle sleep while it
# runs. .data/chain-steps.log says what happened.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/.data"
py="$data/embed-venv/bin/python"
log="$data/chain-steps.log"
step() { echo "$1 $(date -u +%FT%TZ)" >> "$log"; }
marks() { local n; n=$(cat "$data/api-pilot.log" "$data/api-pplx-0-6b.log" 2>/dev/null | grep -c -E 'RERANKING DEGRADED|"task failed"'); echo "${n:-0}"; }

caffeinate -i -s -w $$ &
[ $# -gt 0 ] && steps=("$@") || steps=(vector-colbert fusion-colbert vector fusion nocolbert)
for s in "${steps[@]}"; do
  for try in 1 2 3; do
    before="$(marks)"
    step "$s: start ($try)"
    if (cd "$here" && "$py" score_search.py --step "$s" baseline pplx-0-6b > "$data/search-$s.log" 2>&1); then
      if [ "$(marks)" = "$before" ]; then
        step "$s: done"
        continue 2
      fi
      step "$s: skipped reranking or failed searches; again ($try)"
    else
      step "$s: FAILED ($try)"
    fi
  done
  step "$s: gave up"
done
step "chain finished"
