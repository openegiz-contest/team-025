#!/bin/sh
set -eu

: "${DITTO_PASSWORD:?DITTO_PASSWORD is required}"

# Computed here, not in the nginx template, so the real password is never
# written to disk anywhere -- only its base64'd Basic-auth form, baked into
# the rendered nginx.conf inside this container.
export DITTO_AUTH_BASE64="$(printf '%s' "ditto:${DITTO_PASSWORD}" | base64 | tr -d '\n')"

# Restrict envsubst to this one placeholder: nginx config syntax uses `$var`
# for its own built-in variables (e.g. $http_host), and a plain `envsubst`
# with no variable list would mangle every one of those too.
envsubst '${DITTO_AUTH_BASE64}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
