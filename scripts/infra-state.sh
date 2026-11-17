#!/usr/bin/env bash
# Usage: infra-state.sh <bicepparam> <resource group> [force]; prints fingerprint= and infrastructure= (infra/README.md).
set -euo pipefail

params=$1
group=$2
force=${3:-false}

hash() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }

# The template and its resolved settings, without the Bicep version stamps (_generator).
fingerprint=$(az bicep build-params --file "$params" --stdout |
  jq -S '{parameters: (.parametersJson | fromjson), template: (.templateJson | fromjson)}
    | walk(if type == "object" then del(._generator) else . end)' |
  hash | cut -d' ' -f1)

# The newest deploy of main.bicep that applied, or tried to apply, the whole template, whether it succeeded or not.
newest=$(az deployment group list -g "$group" \
  --query "[?properties.parameters.postgresAdminGroupObjectId != null && properties.parameters.deployInfrastructure.value != \`false\`] | sort_by(@, &properties.timestamp) | [-1].{state: properties.provisioningState, fingerprint: properties.parameters.infraFingerprint.value}" \
  -o json)
state=$(jq -r '.state // ""' <<< "${newest:-null}")
last=$(jq -r '.fingerprint // ""' <<< "${newest:-null}")

infrastructure=true
if [ "$force" != true ] && [ "$state" = Succeeded ] && [ -n "$last" ] && [ "$last" = "$fingerprint" ]; then
  infrastructure=false
fi

echo "fingerprint=$fingerprint"
echo "infrastructure=$infrastructure"
echo "newest full deploy: ${state:-none} ${last:-without a fingerprint}" >&2
