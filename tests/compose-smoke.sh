#!/usr/bin/env bash

set -euo pipefail

smoke_project="turblog-analytics-smoke-$$"
smoke_image="${SMOKE_IMAGE:-turblog}"
smoke_version="${SMOKE_VERSION:-analytics-test}"
smoke_port="${SMOKE_PORT:-18089}"
smoke_hash_key="0123456789abcdef0123456789abcdef"
smoke_book_password="book-pass"
smoke_private_chapter="/books/daode-yu-fazhi-7-shang/daode-yu-fazhi-7-shang-lesson-01/"
smoke_private_adjacent_chapter="/books/daode-yu-fazhi-7-shang/daode-yu-fazhi-7-shang-lesson-02/"
smoke_watchtower_token="0123456789abcdef0123456789abcdef"
smoke_base_url="http://127.0.0.1:${smoke_port}"
smoke_cookie_jar="/tmp/${smoke_project}-cookies.txt"
smoke_private_image="/images/books/daode-yu-fazhi-7-shang/cover.jpg"
smoke_public_image="/images/books/guns-germs-steel/0001.jpeg"
smoke_artifacts="$(mktemp -d)"
smoke_compose_file="$(realpath "$(dirname "${BASH_SOURCE[0]}")/../docker-compose.yml")"
smoke_shared_cookie_jar="/tmp/${smoke_project}-shared-cookies.txt"

compose() {
  env \
    BLOG_IMAGE="$smoke_image" \
    BLOG_VERSION="$smoke_version" \
    BLOG_PORT="$smoke_port" \
    TURBLOG_VISITOR_HASH_KEY="$smoke_hash_key" \
    TURBLOG_BOOK_ACCESS_PASSWORD="$smoke_book_password" \
    WATCHTOWER_HTTP_API_TOKEN="$smoke_watchtower_token" \
    docker compose --project-directory "$smoke_artifacts" -f "$smoke_compose_file" -p "$smoke_project" "$@"
}

cleanup() {
  compose down --volumes >/dev/null 2>&1 || true
  rm -f "$smoke_cookie_jar" "$smoke_shared_cookie_jar"
  rm -rf "$smoke_artifacts"
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

assert_no_store() {
  local headers
  headers="$(curl --silent --show-error --head "$smoke_base_url$1" | tr -d '\r')"
  test "$(printf '%s\n' "$headers" | grep -ci '^cache-control:')" = "1"
  printf '%s\n' "$headers" | grep -qi '^cache-control: no-store$'
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

curl --fail --silent --show-error --output /dev/null "${smoke_base_url}/books/guns-germs-steel/chapter-01/"
for path in /book-access-manifest.json /post-access-manifest.json /_internal /_internal/content-catalog.xml /_internal/missing.svg /_content /_content/content-catalog.xml /_owner /_owner/ /_owner/archive/index.html /books/_owner/ /books/_owner/index.html "$smoke_private_chapter" "$smoke_private_image"; do
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${smoke_base_url}${path}")"
  test "$status" = "404"
done
redirect="$(curl --silent --show-error --head "${smoke_base_url}/books" | tr -d '\r')"
printf '%s\n' "$redirect" | grep -q '^HTTP/1.1 301'
printf '%s\n' "$redirect" | grep -qi '^location: /books/$'
curl --fail --silent --show-error --output /dev/null "${smoke_base_url}${smoke_public_image}"
for path in / /index.html /archive/ /tags/ /_access/ /books /books/ "$smoke_private_chapter" "$smoke_private_image" "$smoke_public_image"; do
  assert_no_store "$path"
done

compose cp blog:/usr/share/nginx/html/book-access-manifest.json "$smoke_artifacts/manifest.json"
compose cp blog:/usr/share/nginx/html/post-access-manifest.json "$smoke_artifacts/post-manifest.json"
compose cp server:/usr/share/nginx/html/_internal/content-catalog.xml "$smoke_artifacts/catalog.xml"
smoke_private_post_slug="$(node -e '
  const manifest = require(process.argv[1]);
  const slug = manifest.privatePosts[0] ?? "";
  if (typeof slug !== "string" || (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) process.exit(1);
  process.stdout.write(slug);
' "$smoke_artifacts/post-manifest.json")"
smoke_private_post="/posts/${smoke_private_post_slug}/"
if [ -n "$smoke_private_post_slug" ]; then
  compose exec -T blog sh -c 'test ! -e "/usr/share/nginx/html/posts/$1" && test -f "/usr/share/nginx/html/_internal/posts/$1/index.html"' sh "$smoke_private_post_slug"
fi
node --input-type=module - "$smoke_base_url" "$smoke_artifacts" "$smoke_private_chapter" "$smoke_private_adjacent_chapter" <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
const [base, directory, privateChapter, adjacentChapter] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
assert.equal(manifest.version, 1);
const privateBooks = new Set(manifest.privateBooks);
const postManifest = JSON.parse(await readFile(`${directory}/post-manifest.json`, 'utf8'));
assert.deepEqual(Object.keys(postManifest).sort(), ['privateAssets', 'privatePosts', 'version']);
assert.equal(postManifest.version, 1);
const privatePosts = new Set(postManifest.privatePosts);
const isPrivate = (path) => {
  const [, section, slug] = path.split('/');
  return path.split('/').includes('_owner') ||
    (section === 'books' && privateBooks.has(slug)) ||
    (section === 'posts' && privatePosts.has(slug));
};
const get = async (path) => {
  const response = await fetch(new URL(path, base));
  assert.equal(response.status, 200, path);
  return response.text();
};
const shelf = load(await get('/books/'));
assert.ok(shelf('a[href="/books/guns-germs-steel/"]').length);
shelf('a[href]').each((_, node) => {
  const path = new URL(shelf(node).attr('href'), base).pathname;
  assert.ok(!isPrivate(path), `Private shelf link: ${path}`);
});
const index = load(await get('/sitemap-index.xml'), { xml: true });
const chunks = index('sitemap > loc').map((_, node) => new URL(index(node).text()).pathname).get();
assert.ok(chunks.length);
const publicPaths = new Set();
for (const chunk of chunks) {
  const xml = load(await get(chunk), { xml: true });
  xml('url > loc').each((_, node) => {
    const path = new URL(xml(node).text()).pathname;
    assert.ok(!isPrivate(path), `Private sitemap entry: ${path}`);
    assert.ok(!path.startsWith('/_internal/'));
    publicPaths.add(path);
  });
}
assert.ok(publicPaths.has('/books/'));
assert.ok(publicPaths.has('/books/guns-germs-steel/chapter-01/'));
const internal = load(await readFile(`${directory}/catalog.xml`, 'utf8'), { xml: true });
const internalPaths = new Set(internal('url > loc').map((_, node) => new URL(internal(node).text()).pathname).get());
for (const slug of privateBooks) {
  assert.ok(internalPaths.has(`/books/${slug}/`), `Missing internal book: ${slug}`);
}
for (const slug of privatePosts) {
  assert.ok(internalPaths.has(`/posts/${slug}/`), `Missing internal post: ${slug}`);
  for (const path of [`/posts/${slug}/`, `/posts/${slug}/index.html`, `/_content/posts/${slug}/`, `/_internal/posts/${slug}/`]) {
    assert.equal((await fetch(new URL(path, base))).status, 404, path);
  }
}
for (const [path, owners] of Object.entries(postManifest.privateAssets)) {
  assert.ok(owners.length && owners.every((slug) => privatePosts.has(slug)), path);
  assert.equal((await fetch(new URL(path, base))).status, 404, path);
  assert.equal((await fetch(new URL(`/_content/assets${path}`, base))).status, 404, path);
}
for (const listing of ['/', '/archive/', '/tags/']) {
  const html = load(await get(listing));
  html('a[href]').each((_, node) => {
    const path = new URL(html(node).attr('href'), base).pathname;
    assert.ok(!isPrivate(path), `Private public listing link: ${path}`);
  });
}
for (const path of [...publicPaths, privateChapter, adjacentChapter]) {
  assert.ok(internalPaths.has(path), `Missing internal content: ${path}`);
}
NODE

owner_token="$(node -e '
  const { createHmac, pbkdf2Sync } = require("node:crypto");
  const key = pbkdf2Sync(process.argv[1], "turblog-book-access-v2", 600000, 32, "sha256");
  process.stdout.write(createHmac("sha256", key).update("turblog-book-owner-v1").digest("base64url"));
' "$smoke_book_password")"
curl \
  --fail \
  --silent \
  --show-error \
  --output /dev/null \
  --cookie-jar "$smoke_cookie_jar" \
  -X POST "${smoke_base_url}/api/v1/books/access" \
  -H 'Content-Type: application/json' \
  --data "{\"path\":\"/books/\",\"owner_token\":\"${owner_token}\"}"
node --input-type=module - "$smoke_base_url" "$smoke_artifacts" "$owner_token" <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [base, directory, ownerToken] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(`${directory}/post-manifest.json`, 'utf8'));
const owner = `turblog_book_owner=${ownerToken}`;
const request = (path, cookie = owner, init = {}) => fetch(new URL(path, base), { ...init, headers: { Cookie: cookie, ...init.headers } });
for (const path of ['/', '/index.html', '/archive/', '/tags/']) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-store', path);
}
for (const path of ['/_owner/', '/books/_owner/', '/_content/content-catalog.xml', '/post-access-manifest.json']) {
  assert.equal((await request(path)).status, 404, path);
}
for (const slug of manifest.privatePosts) {
  const path = `/posts/${slug}/`;
  const detail = await request(path);
  assert.equal(detail.status, 200, path);
  assert.match(detail.headers.get('cache-control'), /private|no-store/);
  const share = await request('/books/_access/share', owner, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
  assert.equal(share.status, 200);
  const { token } = await share.json();
  const login = await request('/api/v1/books/access', '', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, token }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  assert.equal((await request(path, cookie)).status, 200);
  for (const [asset, owners] of Object.entries(manifest.privateAssets)) {
    assert.equal((await request(asset)).status, 200, asset);
    assert.equal((await request(asset, cookie)).status, owners.includes(slug) ? 200 : 404, asset);
  }
}
NODE

owner_shelf="$(curl --fail --silent --show-error --cookie "$smoke_cookie_jar" "${smoke_base_url}/books/")"
printf '%s' "$owner_shelf" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    if (!input.includes("/books/daode-yu-fazhi-7-shang/")) process.exit(1);
  });
'
curl --fail --silent --show-error --output /dev/null --cookie "$smoke_cookie_jar" "${smoke_base_url}${smoke_private_image}"
curl \
  --fail \
  --silent \
  --show-error \
  --output /dev/null \
  --cookie "$smoke_cookie_jar" \
  "${smoke_base_url}${smoke_private_adjacent_chapter}"

share_payload="$(curl \
  --fail \
  --silent \
  --show-error \
  --cookie "$smoke_cookie_jar" \
  -X POST "${smoke_base_url}/books/_access/share" \
  -H 'Content-Type: application/json' \
  --data "{\"path\":\"${smoke_private_adjacent_chapter}\"}")"
share_token="$(printf '%s' "$share_payload" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    const token = JSON.parse(input).token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) process.exit(1);
    process.stdout.write(token);
  });
')"
curl \
  --fail \
  --silent \
  --show-error \
  --output /dev/null \
  --cookie-jar "$smoke_shared_cookie_jar" \
  -X POST "${smoke_base_url}/api/v1/books/access" \
  -H 'Content-Type: application/json' \
  --data "{\"path\":\"${smoke_private_adjacent_chapter}\",\"token\":\"${share_token}\"}"
curl \
  --fail \
  --silent \
  --show-error \
  --output /dev/null \
  --cookie "$smoke_shared_cookie_jar" \
  "${smoke_base_url}${smoke_private_adjacent_chapter}"

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
for path in / /index.html /archive/ /tags/ /_access/ /books/ "$smoke_private_chapter" "$smoke_private_image" "$smoke_public_image"; do
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${smoke_base_url}${path}")"
  test "$status" = "502"
  assert_no_store "$path"
done
if [ -n "$smoke_private_post_slug" ]; then
  for path in "$smoke_private_post" "${smoke_private_post}index.html" /_content/posts/"$smoke_private_post_slug"/; do
    status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${smoke_base_url}${path}")"
    test "$status" = "404"
  done
fi
for path in /_astro/missing.webp /images/missing.png; do
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${smoke_base_url}${path}")"
  test "$status" = "502"
done
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

echo "Compose analytics, book privacy, and post privacy smoke test passed"
