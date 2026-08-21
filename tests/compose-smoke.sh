#!/usr/bin/env bash

set -euo pipefail

smoke_project="turblog-analytics-smoke-$$"
smoke_image="${SMOKE_IMAGE:-turblog}"
smoke_version="${SMOKE_VERSION:-analytics-test}"
smoke_port="${SMOKE_PORT:-18089}"
smoke_hash_key="0123456789abcdef0123456789abcdef"
smoke_watchtower_token="0123456789abcdef0123456789abcdef"
smoke_base_url="http://127.0.0.1:${smoke_port}"

compose() {
  env \
    BLOG_IMAGE="$smoke_image" \
    BLOG_VERSION="$smoke_version" \
    BLOG_PORT="$smoke_port" \
    TURBLOG_VISITOR_HASH_KEY="$smoke_hash_key" \
    WATCHTOWER_HTTP_API_TOKEN="$smoke_watchtower_token" \
    docker compose -p "$smoke_project" "$@"
}

cleanup() {
  compose down --volumes >/dev/null 2>&1 || true
}
trap cleanup EXIT

query_metrics() {
  curl \
    --retry 10 \
    --retry-delay 1 \
    --retry-all-errors \
    --fail \
    --silent \
    --show-error \
    -X POST "${smoke_base_url}/api/v1/analytics/metrics/query" \
    -H 'Content-Type: application/json' \
    --data '{"metric":"article_unique_views","subject_type":"article","subject_ids":["go-atomic-generics","row-linked-list"]}'
}

compose up -d

curl \
  --retry 20 \
  --retry-delay 1 \
  --retry-all-errors \
  --fail \
  --silent \
  --show-error \
  --output /dev/null \
  "${smoke_base_url}/"

for _ in 1 2; do
  curl \
    --fail \
    --silent \
    --show-error \
    --output /dev/null \
    -A 'curl/turblog-compose-smoke' \
    -H "CF-Connecting-IP: 203.0.113.${_}" \
    -H "X-Forwarded-For: 198.51.100.${_}" \
    -H "X-Real-IP: 192.0.2.${_}" \
    "${smoke_base_url}/posts/go-atomic-generics/"
done

curl \
  --fail \
  --silent \
  --show-error \
  --head \
  --output /dev/null \
  -A 'curl/turblog-compose-smoke-head' \
  "${smoke_base_url}/posts/row-linked-list/"

cache_header_count="$({ curl --fail --silent --show-error --head "${smoke_base_url}/posts/go-atomic-generics/" || true; } | tr -d '\r' | grep -c -i '^cache-control:')"
test "$cache_header_count" = "1"

metrics="$(query_metrics)"
printf '%s' "$metrics" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const payload = JSON.parse(input);
    if (payload.values["go-atomic-generics"] !== 1) process.exit(1);
    if (payload.values["row-linked-list"] !== 0) process.exit(1);
    if (!Array.isArray(payload.unknown) || payload.unknown.length !== 0) process.exit(1);
  });
'

compose stop server
curl --fail --silent --show-error --output /dev/null "${smoke_base_url}/posts/go-atomic-generics/"
curl --fail --silent --show-error --output /dev/null "${smoke_base_url}/"
curl --fail --silent --show-error --output /dev/null "${smoke_base_url}/favicon.svg"
api_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' -X POST "${smoke_base_url}/api/v1/analytics/metrics/query" -H 'Content-Type: application/json' --data '{"metric":"article_unique_views","subject_type":"article","subject_ids":["go-atomic-generics"]}')"
test "$api_status" = "502"

compose start server
metrics="$(query_metrics)"
printf '%s' "$metrics" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const payload = JSON.parse(input);
    if (payload.values["go-atomic-generics"] !== 1) process.exit(1);
  });
'

echo "Compose analytics smoke test passed"
