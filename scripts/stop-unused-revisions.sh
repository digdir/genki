#!/usr/bin/env bash
set -euo pipefail

group=$1
app=$2
live=$3
mode=${4:-unlabelled}

keep=$(az containerapp ingress traffic show -g "$group" -n "$app" --query '[].revisionName' -o tsv)
echo "$keep" | grep -qxF "$live" || exit 0
if [ "$mode" = all-but-live ]; then
  for label in $(az containerapp ingress traffic show -g "$group" -n "$app" --query "[?label && revisionName != '$live'].label" -o tsv); do
    az containerapp revision label remove -g "$group" -n "$app" --label "$label" -o none
  done
  keep=$live
fi
for revision in $(az containerapp revision list -g "$group" -n "$app" --query '[?properties.active].name' -o tsv); do
  echo "$keep" | grep -qxF "$revision" || az containerapp revision deactivate -g "$group" -n "$app" --revision "$revision"
done
