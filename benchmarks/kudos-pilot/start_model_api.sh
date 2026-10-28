#!/usr/bin/env bash
# Start the pilot API for one model of models.json on its own port, platform database and knowledge database,
# with the generated config from setup_models.py. Logs to .data/api-<key>.log. `baseline` is the pilot's own API
# (text-embedding-3-large) on port 8096 and the pilot databases, logging to .data/api-pilot.log.
#
#   benchmarks/kudos-pilot/start_model_api.sh borealis
set -euo pipefail
key="$1"
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/.data"
if [ "$key" = baseline ]; then
  port=8096 platform=genai knowledge=knowledge log=pilot
else
  port="$(python3 -c "import json,sys; print(next(m['api'] for m in json.load(open('$here/models.json'))['models'] if m['key']=='$key'))")"
  platform="genai_${key//-/_}" knowledge="knowledge_${key//-/_}" log="$key"
fi
cd "$here/../../apps/api"
exec env PORT="$port" GENAI_DEV_MODE=true CONFIG_DIR="$data/config" \
  DATABASE_URL="postgres://genai:genai-local-only@127.0.0.1:55442/$platform" DATABASE_RUNTIME_URL= \
  KNOWLEDGE_DATABASE_URL="postgres://genai:genai-local-only@127.0.0.1:55443/$knowledge" \
  DOCUMENT_CONVERTER=marker MARKER_URL=http://localhost:8091/api/v1/marker-pdf-to-markdown \
  MARKER_API_KEY="$(cat "$data/marker-api-key")" \
  TYPESENSE_LOCAL_URL=http://127.0.0.1:8108 TYPESENSE_LOCAL_KEY="$(cat "$data/typesense-local-key")" \
  LOCAL_EMBEDDINGS_KEY=local TRACES_ENDPOINT= LANGFUSE_SECRET_KEY= \
  npx tsx --conditions=source src/main.ts >> "$data/api-$log.log" 2>&1
