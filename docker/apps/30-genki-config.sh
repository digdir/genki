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
api_scheme=${upstream%%://*}
api_rest=${upstream#*://}
api_host=${api_rest%%/*}
api_path=${api_rest#"$api_host"}
api_hostname=${api_host%:*}
case "$api_host" in
  *:*) api_server=$api_host ;;
  *) api_server="$api_host:$([ "$api_scheme" = https ] && echo 443 || echo 80)" ;;
esac

sed -e "s#__CONNECT_SRC__#$connect#g" /etc/nginx/genki-headers.conf >/tmp/genki/headers.conf
sed -e 's#X-Frame-Options "DENY"#X-Frame-Options "SAMEORIGIN"#' -e "s#frame-ancestors 'none'#frame-ancestors 'self'#" \
  /tmp/genki/headers.conf >/tmp/genki/headers-same-origin.conf
sed -e "s#__APP__#$APP#g" -e "s#__API_SCHEME__#$api_scheme#g" -e "s#__API_SERVER__#$api_server#g" \
  -e "s#__API_PATH__#$api_path#g" -e "s#__API_HOSTNAME__#$api_hostname#g" -e "s#__API_HOST__#$api_host#g" \
  -e "s#/etc/nginx/genki-headers.conf#/tmp/genki/headers.conf#g" \
  -e "s#/etc/nginx/genki-headers-same-origin.conf#/tmp/genki/headers-same-origin.conf#g" \
  /etc/genki/default.conf.template >/etc/nginx/conf.d/default.conf
