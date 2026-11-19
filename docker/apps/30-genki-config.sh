#!/bin/sh
set -eu

case "${APP:-}" in
  portal | workspace | console | assistant) ;;
  *) echo "Set APP to portal, workspace, console or assistant" >&2; exit 1 ;;
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
frame="'self'"
for url in "${ANSATTPORTEN_ISSUER:-}" "${OIDC_ISSUER:-}"; do
  case "$url" in https://*) frame="$frame $(origin "$url")" ;; esac
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

sed -e "s#__CONNECT_SRC__#$connect#g" -e "s#__FRAME_SRC__#$frame#g" /etc/nginx/genki-headers.conf >/tmp/genki/headers.conf
sed -e 's#X-Frame-Options "DENY"#X-Frame-Options "SAMEORIGIN"#' -e "s#frame-ancestors 'none'#frame-ancestors 'self'#" \
  /tmp/genki/headers.conf >/tmp/genki/headers-same-origin.conf
# The assistant host's BFF (ADR 0061): /auth/ goes to the API's /bff/auth/, and both carry the
# hostname and the proxy key, which the API trusts the forwarded hostname by.
: >/tmp/genki/bff-api.conf
: >/tmp/genki/bff.conf
if [ "$APP" = assistant ] && [ -n "${GENAI_PROXY_KEY:-}" ]; then
  case "$GENAI_PROXY_KEY" in *[!A-Za-z0-9_-]*) key_ok=no ;; *) key_ok=yes ;; esac
  if [ "$key_ok" != yes ] || [ ${#GENAI_PROXY_KEY} -lt 32 ] || [ ${#GENAI_PROXY_KEY} -gt 255 ]; then
    echo "GENAI_PROXY_KEY must be 32 to 255 letters, digits, - or _" >&2
    exit 1
  fi
  printf 'proxy_set_header X-Forwarded-Host $host;\nproxy_set_header GenAI-Proxy-Key "%s";\n' \
    "$GENAI_PROXY_KEY" >/tmp/genki/bff-api.conf
  cat >/tmp/genki/bff.conf <<'CONF'
location /auth/ {
  access_log off;
  proxy_pass __API_SCHEME__://genki_api__API_PATH__/bff$request_uri;
  proxy_ssl_server_name on;
  proxy_ssl_name __API_HOSTNAME__;
  proxy_ssl_verify on;
  proxy_ssl_verify_depth 3;
  proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
  proxy_set_header Host __API_HOST__;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto https;
  include /tmp/genki/bff-api.conf;
  proxy_http_version 1.1;
  include /tmp/genki/headers.conf;
}
CONF
  sed -i -e "s#__API_SCHEME__#$api_scheme#g" -e "s#__API_PATH__#$api_path#g" \
    -e "s#__API_HOSTNAME__#$api_hostname#g" -e "s#__API_HOST__#$api_host#g" /tmp/genki/bff.conf
fi
sed -e "s#__APP__#$APP#g" -e "s#__API_SCHEME__#$api_scheme#g" -e "s#__API_SERVER__#$api_server#g" \
  -e "s#__API_PATH__#$api_path#g" -e "s#__API_HOSTNAME__#$api_hostname#g" -e "s#__API_HOST__#$api_host#g" \
  -e "s#/etc/nginx/genki-headers.conf#/tmp/genki/headers.conf#g" \
  -e "s#/etc/nginx/genki-headers-same-origin.conf#/tmp/genki/headers-same-origin.conf#g" \
  /etc/genki/default.conf.template >/etc/nginx/conf.d/default.conf
