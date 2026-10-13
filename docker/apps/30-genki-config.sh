#!/bin/sh
set -eu

case "${APP:-}" in
  portal | workspace | console) ;;
  *) echo "Set APP to portal, workspace or console" >&2; exit 1 ;;
esac
case "${API_UPSTREAM:-}" in
  http://* | https://*) ;;
  *) echo "Set API_UPSTREAM to the API address, for example https://api.genki-test.digdir.cloud" >&2; exit 1 ;;
esac

escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
origin() { printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1#'; }

mkdir -p /tmp/genki
{
  printf 'globalThis.__GENKI_CONFIG__ = {'
  separator=''
  for name in ANSATTPORTEN_ISSUER OIDC_ISSUER OIDC_CLIENT_ID OIDC_TOKEN_ENDPOINT API_AUDIENCE \
    ALTINN_RESOURCE PUBLIC_API_BASE PORTAL_URL ENVIRONMENT; do
    eval "value=\${$name:-}"
    if [ -n "$value" ]; then
      printf '%s"%s":"%s"' "$separator" "$name" "$(escape "$value")"
      separator=','
    fi
  done
  printf '};\n'
} >/tmp/genki/config.js

connect="'self'"
for url in "${ANSATTPORTEN_ISSUER:-}" "${OIDC_ISSUER:-}" "${OIDC_TOKEN_ENDPOINT:-}"; do
  case "$url" in https://*) connect="$connect $(origin "$url")" ;; esac
done
upstream=${API_UPSTREAM%/}
api_host=$(printf '%s' "$upstream" | sed -E 's#^https?://([^/]+).*#\1#')

sed -e "s#__CONNECT_SRC__#$connect#g" /etc/nginx/genki-headers.conf >/tmp/genki/headers.conf
sed -e "s#__APP__#$APP#g" -e "s#__API_UPSTREAM__#$upstream#g" -e "s#__API_HOST__#$api_host#g" \
  -e "s#/etc/nginx/genki-headers.conf#/tmp/genki/headers.conf#g" \
  /etc/genki/default.conf.template >/etc/nginx/conf.d/default.conf
