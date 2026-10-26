#!/usr/bin/env bash
# Start the pilot API for one model of models.json on its own port, platform database and knowledge database,
# with the generated config from setup_models.py. Logs to .data/api-<key>.log.
#
#   benchmarks/kudos-pilot/start_model_api.sh borealis
set -euo pipefail
key="$1"
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/.data"
port="$(python3 -c "import json,sys; print(next(m['api'] for m in json.load(open('$here/models.json'))['models'] if m['key']=='$key'))")"
db="${key//-/_}"
cd "$here/../../apps/api"
exec env PORT="$port" GENAI_DEV_MODE=true CONFIG_DIR="$data/config" \
  DATABASE_URL="postgres://genai:genai-local-only@127.0.0.1:55442/genai_$db" DATABASE_RUNTIME_URL= \
  KNOWLEDGE_DATABASE_URL="postgres://genai:genai-local-only@127.0.0.1:55443/knowledge_$db" \
  DOCUMENT_CONVERTER=marker MARKER_URL=http://localhost:8091/api/v1/marker-pdf-to-markdown \
  MARKER_API_KEY="$(cat "$data/marker-api-key")" \
  TYPESENSE_LOCAL_URL=http://127.0.0.1:8108 TYPESENSE_LOCAL_KEY="$(cat "$data/typesense-local-key")" \
  LOCAL_EMBEDDINGS_KEY=local TRACES_ENDPOINT= LANGFUSE_SECRET_KEY= \
  npx tsx --conditions=source src/main.ts > "$data/api-$key.log" 2>&1
