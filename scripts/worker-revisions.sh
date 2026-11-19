#!/usr/bin/env bash
set -euo pipefail

group=$1
action=$2
deployment=${3:-}

app=$(az containerapp list -g "$group" --query "[?ends_with(name, '-worker')].name | [0]" -o tsv)
[ -n "$app" ] || exit 0
[ "$(az containerapp show -g "$group" -n "$app" --query properties.configuration.activeRevisionsMode -o tsv)" = Multiple ] || exit 0

active() { az containerapp revision list -g "$group" -n "$app" --query '[?properties.active].name' -o tsv; }
running() {
  local state=""
  for _ in $(seq 1 60); do
    state=$(az containerapp revision show -g "$group" -n "$app" --revision "$1" --query properties.runningState -o tsv)
    case "$state" in Running | RunningAtMaxScale) return 0 ;; esac
    sleep 5
  done
  echo "worker revision $1 is $state, not running" >&2
  return 1
}
only() {
  for revision in $(active); do
    [ "$revision" = "$1" ] || az containerapp revision deactivate -g "$group" -n "$app" --revision "$revision"
  done
  active | grep -qxF "$1" || az containerapp revision activate -g "$group" -n "$app" --revision "$1" || true
}

if [ "$action" = stop ]; then
  for revision in $(active); do
    az containerapp revision deactivate -g "$group" -n "$app" --revision "$revision"
  done
  exit 0
fi

if [ -n "$deployment" ] && [ "$(az deployment group show -g "$group" -n "$deployment" --query properties.provisioningState -o tsv 2>/dev/null)" = Running ]; then
  az deployment group cancel -g "$group" -n "$deployment" || true
  for _ in $(seq 1 60); do
    [ "$(az deployment group show -g "$group" -n "$deployment" --query properties.provisioningState -o tsv)" = Running ] || break
    sleep 5
  done
fi

previous=$(az containerapp show -g "$group" -n "$app" --query properties.latestReadyRevisionName -o tsv)
latest=$(az containerapp show -g "$group" -n "$app" --query properties.latestRevisionName -o tsv)
only "$latest"
running "$latest" && exit 0
if [ "$previous" != "$latest" ]; then
  only "$previous"
  running "$previous" || true
fi
echo "the newest worker revision $latest did not start; $previous runs instead" >&2
exit 1
