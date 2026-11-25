#!/bin/sh
set -eu

api_image=${1:?usage: docker/smoke.sh <api image> <apps image>}
apps_image=${2:?usage: docker/smoke.sh <api image> <apps image>}
name=genki-smoke-$$

cleanup() {
  docker rm -f "$name-echo" "$name-apps" "$name-console" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "api image: judges, test sets and parity services load"
docker run --rm --entrypoint node "$api_image" --input-type=module -e "
import { existsSync } from 'node:fs';
import { bundledJudge } from '@genai/eval';
import { readTestSets } from '/app/apps/api/dist/seed-test-sets.js';
bundledJudge('answer-quality');
bundledJudge('pairwise-preference');
const { sets, unreadable } = readTestSets(['/app/packages/eval/testsets', '/app/packages/jobs/examples/testsets']);
if (sets.length === 0 || unreadable.length > 0) throw new Error('test sets: ' + JSON.stringify({ sets: sets.length, unreadable }));
if (!existsSync('/app/apps/parity/config/services')) throw new Error('parity services are missing');
console.log('ok:', sets.length, 'test sets');
"

echo "apps image: /api/ reaches the API with the request URI as sent"
docker network create "$name" >/dev/null
docker run -d --name "$name-echo" --network "$name" --network-alias echo --entrypoint node "$api_image" -e "
require('node:http').createServer((req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    setTimeout(() => res.end('data: last\n\n'), 3000);
    return;
  }
  res.end(req.headers.host + ' ' + req.url);
}).listen(9000);
" >/dev/null
docker run -d --name "$name-apps" --network "$name" -p 127.0.0.1::8080 \
  -e APP=portal -e API_UPSTREAM=http://echo:9000 "$apps_image" >/dev/null
base="http://$(docker port "$name-apps" 8080 | head -n 1)"

tries=0
until curl -fsS "$base/healthz" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    docker logs "$name-apps" >&2
    exit 1
  fi
  sleep 1
done

failed=0
expect() {
  actual=$(curl -sS "$base$1")
  if [ "$actual" = "$2" ]; then
    echo "ok: $1"
  else
    echo "FAILED: $1 reached the API as '$actual', expected '$2'" >&2
    failed=1
  fi
}
expect '/api/tenants/x/datasets/digdir%2Fkudos?a=b%2Fc' 'echo:9000 /tenants/x/datasets/digdir%2Fkudos?a=b%2Fc'
expect '/api/tenants/x/datasets' 'echo:9000 /tenants/x/datasets'
expect '/api/search?q=hello%20world&page=2' 'echo:9000 /search?q=hello%20world&page=2'

first=$(curl -sS -N --max-time 2 "$base/api/stream" 2>/dev/null || true)
if [ "$first" = "data: first" ]; then
  echo "ok: events stream before the response ends"
else
  echo "FAILED: no event within 2 seconds, got '$first'" >&2
  failed=1
fi

asset=$(curl -fsS "$base/" | grep -o '/assets/[^"]*\.js' | head -n 1)
encoding() { curl -sS -o /dev/null -w '%header{content-encoding}' "$@"; }
if [ -n "$asset" ] &&
  [ "$(encoding -H 'Accept-Encoding: gzip' "$base$asset")" = gzip ] &&
  [ -z "$(encoding "$base$asset")" ] &&
  [ "$(curl -sS -H 'Accept-Encoding: gzip' "$base$asset" | gunzip | cksum)" = "$(curl -sS "$base$asset" | cksum)" ] &&
  [ -z "$(encoding -H 'Accept-Encoding: gzip' "$base/api/tenants/x/datasets")" ]; then
  echo "ok: $asset goes out gzipped only to clients that accept it, and /api/ as the API sent it"
else
  echo "FAILED: precompressed assets" >&2
  failed=1
fi

docker run -d --name "$name-console" --network "$name" -p 127.0.0.1::8080 \
  -e APP=console -e API_UPSTREAM=http://echo:9000 "$apps_image" >/dev/null
console="http://$(docker port "$name-console" 8080 | head -n 1)"
tries=0
until curl -fsS "$console/healthz" >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 30 ] || { docker logs "$name-console" >&2; exit 1; }
  sleep 1
done
headers() { curl -sS -o /dev/null -D - "$console$1" | tr -d '\r'; }
if headers /system-atlas.html | grep -qi "^x-frame-options: SAMEORIGIN" &&
  headers /system-atlas.html | grep -qi "frame-ancestors 'self'" &&
  headers / | grep -qi "^x-frame-options: DENY" &&
  curl -fsS "$console/system-atlas.js" >/dev/null &&
  ! curl -sS "$console/system-atlas.html" | grep -q "<script>"; then
  echo "ok: the console frames its System Atlas from its own origin only, without inline script"
else
  echo "FAILED: System Atlas headers or script file in the console" >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  docker logs "$name-apps" >&2
  exit 1
fi
