#!/usr/bin/env bash
# Whether a deploy applies the whole template or only the container apps: prints `fingerprint=<hash>` and
# `infrastructure=true|false` for $GITHUB_OUTPUT. The fingerprint hashes what a full deploy applies apart from the
# images and revisions: the compiled template and the environment's resolved parameters. The infrastructure is skipped
# only when it equals the fingerprint of the last full deploy that succeeded. See infra/README.md, "Deploys that skip
# the infrastructure".
#
#   scripts/infra-state.sh <bicepparam file> <resource group> [force: true|false]
set -euo pipefail

params=$1
group=$2
force=${3:-false}

hash() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }

# The Bicep version stamps each template it compiles (_generator); leaving it out keeps a new Bicep from forcing a
# full deploy.
fingerprint=$(az bicep build-params --file "$params" --stdout |
  jq -S '{parameters: (.parametersJson | fromjson), template: (.templateJson | fromjson)}
    | walk(if type == "object" then del(._generator) else . end)' |
  hash | cut -d' ' -f1)

# A deploy of infra/main.bicep has the apiUrl output; one from before the fingerprint has no infrastructureDeployed
# output, counts as full and has no fingerprint, so the next deploy is full.
last=$(az deployment group list -g "$group" \
  --query "[?properties.provisioningState=='Succeeded' && properties.outputs.apiUrl != null && properties.outputs.infrastructureDeployed.value != \`false\`] | sort_by(@, &properties.timestamp) | [-1].properties.outputs.infraFingerprint.value" \
  -o tsv)

infrastructure=true
if [ "$force" != true ] && [ -n "$last" ] && [ "$last" = "$fingerprint" ]; then infrastructure=false; fi

echo "fingerprint=$fingerprint"
echo "infrastructure=$infrastructure"
echo "last=$last" >&2
