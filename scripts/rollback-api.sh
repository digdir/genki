#!/usr/bin/env bash
set -euo pipefail

group=$1

app=$(az containerapp list -g "$group" --query "[?ends_with(name, '-api')].name | [0]" -o tsv)
live=$(az containerapp ingress traffic show -g "$group" -n "$app" --query "[?weight==\`100\`].revisionName | [0]" -o tsv)
labelled=$(az containerapp ingress traffic show -g "$group" -n "$app" --query "[?label=='previous'].revisionName | [0]" -o tsv)
previous=$labelled
if [ -z "$previous" ]; then
  provisioned=$(az containerapp revision list -g "$group" -n "$app" --all --query "[?properties.provisioningState=='Provisioned'].name" -o tsv)
  for revision in $(az deployment group list -g "$group" --query "reverse(sort_by([?properties.provisioningState=='Succeeded' && (starts_with(name, 'genki-') || starts_with(name, 'infra-')) && !ends_with(name, '-candidate')], &properties.timestamp))[].properties.parameters.apiLiveRevision.value" -o tsv); do
    if [ "$revision" != "$live" ] && echo "$provisioned" | grep -qxF "$revision"; then
      previous=$revision
      break
    fi
  done
fi
if [ -z "$previous" ]; then
  echo "No API revision that reached users before $live to roll back to." >&2
  exit 1
fi

[ "$(az containerapp revision show -g "$group" -n "$app" --revision "$previous" --query properties.active -o tsv)" = true ] ||
  az containerapp revision activate -g "$group" -n "$app" --revision "$previous"
state=""
for _ in $(seq 1 60); do
  state=$(az containerapp revision show -g "$group" -n "$app" --revision "$previous" --query properties.runningState -o tsv)
  case "$state" in Running | RunningAtMaxScale) break ;; esac
  sleep 5
done
case "$state" in
  Running | RunningAtMaxScale) ;;
  *)
    echo "$previous did not start ($state), so users stay on $live." >&2
    exit 1
    ;;
esac

[ -n "$labelled" ] || az containerapp revision label add -g "$group" -n "$app" --revision "$previous" --label previous --yes -o none
az containerapp revision label swap -g "$group" -n "$app" --source previous --target live -o none
echo "$previous"
