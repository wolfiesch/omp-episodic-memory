#!/usr/bin/env bash
# HTTP smoke test for the omp-episodic-memory landing page.
#
#   deploy/smoke.sh [--base-url URL] [--release REV]   the edge site (default https://omp.wolfie.gg)
#   deploy/smoke.sh --fallback [--base-url URL]         the GitHub Pages rollback copy
#                                                       (default https://wolfiesch.github.io/omp-episodic-memory)
#
#   --release REV  compare every served file byte-for-byte with the local release
#                  $OMPDOCS_RELEASE_DIR/REV (see deploy/release.sh)
#   --fallback     check the GitHub Pages copy instead: the published files are
#                  served, unknown paths are 404, and the page loads no shared
#                  analytics route there
#
# Runs every probe, then exits non-zero if any failed. Never prints response bodies.
set -euo pipefail

base_url=
fallback=
release=

while [[ $# -gt 0 ]]; do
  case $1 in
    --base-url) base_url=${2:?}; shift 2 ;;
    --release) release=${2:?}; shift 2 ;;
    --fallback) fallback=1; shift ;;
    *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  esac
done
if [[ -z $base_url ]]; then
  if [[ -n $fallback ]]; then
    base_url=https://wolfiesch.github.io/omp-episodic-memory
  else
    base_url=https://omp.wolfie.gg
  fi
fi
base_url=${base_url%/}
[[ -z $fallback || -z $release ]] || { echo "--release applies to the edge site only" >&2; exit 2; }

curl_args=(-sS --max-time 30 --proto =https,http)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0

fail() {
  printf 'FAIL %s\n' "$*"
  failures=$((failures + 1))
}

# fetch PATH -> sets status, ctype; body in $tmp/body, headers in $tmp/headers
fetch() {
  local out
  out=$(curl "${curl_args[@]}" -o "$tmp/body" -D "$tmp/headers" \
    -w '%{http_code} %{content_type}' "$base_url$1") || { status=000; ctype=; return 0; }
  status=${out%% *}
  ctype=${out#* }
}

header() {
  grep -i "^$1:" "$tmp/headers" | head -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'
}

expect() {
  local path=$1 want_status=$2 want_type=${3:-}
  fetch "$path"
  if [[ $status != "$want_status" ]]; then
    fail "$path: status $status, expected $want_status"
    return 1
  fi
  if [[ -n $want_type && ! $ctype =~ $want_type ]]; then
    fail "$path: content-type '$ctype', expected /$want_type/"
    return 1
  fi
  printf 'ok   %s %s %s\n' "$path" "$status" "$ctype"
}

count() {
  grep -o -F -- "$1" "$tmp/body" | wc -l | tr -d ' '
}

content_type_for() {
  case $1 in
    *.html) echo '^text/html' ;;
    *.md) echo '^text/markdown' ;;
    *.svg) echo '^image/svg\+xml' ;;
    *.png) echo '^image/png' ;;
    *) echo '' ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# The published files, as listed in deploy/release.sh and deploy/manifest.json.
files=(index.html favicon.svg og-image.png og-image-card.html THIRD_PARTY_NOTICES.md)

# 1. Document. Any copy of the page may carry the hostname-gated loader, but no
#    static tag may load a shared analytics route, which on github.io would
#    resolve against the user site instead of this project.
if expect / 200 '^text/html'; then
  [[ $(header cache-control) == "max-age=600" ]] || fail "/: unexpected Cache-Control '$(header cache-control)'"
  [[ $(header access-control-allow-origin) == '*' ]] || fail "/: missing Access-Control-Allow-Origin *"
  grep -q -F '<meta property="og:url" content="https://omp.wolfie.gg/">' "$tmp/body" || fail "/: canonical og:url missing"
  [[ $(grep -c -E '<(script|link)[^>]*/_analytics/' "$tmp/body") == 0 ]] || fail "/: static tag loads an /_analytics/ route"
  if [[ -z $fallback ]]; then
    [[ $(header server) == Caddy ]] || fail "/: server '$(header server)', expected Caddy (still the K3s redirect?)"
    [[ $(header strict-transport-security) == max-age=31556952 ]] || fail "/: missing Strict-Transport-Security max-age=31556952"
    [[ $(count "if (location.hostname === 'omp.wolfie.gg') {") == 1 ]] || fail "/: hostname-gated analytics hook not present exactly once"
    [[ $(count "loader.src = '/_analytics/fleet.js';") == 1 ]] || fail "/: analytics loader not present exactly once"
    [[ $(count data-fleet-analytics-settings) == 1 ]] || fail "/: analytics settings control not present exactly once"
  elif grep -q -F /_analytics/fleet.js "$tmp/body"; then
    [[ $(count "if (location.hostname === 'omp.wolfie.gg') {") == 1 ]] || fail "/: analytics loader is not gated on omp.wolfie.gg"
  fi
fi

# 2. Published files. With --release, each is compared byte-for-byte.
sums=
if [[ -n $release ]]; then
  sums=${OMPDOCS_RELEASE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ompdocs/releases}/$release/SHA256SUMS
  [[ -f $sums ]] || { echo "no $sums; build the release first" >&2; exit 2; }
fi
for rel in "${files[@]}"; do
  if expect "/$rel" 200 "$(content_type_for "$rel")" && [[ -n $sums ]]; then
    want=$(awk -v f="$rel" '$2 == f { print $1 }' "$sums")
    [[ -n $want && $(sha256_of "$tmp/body") == "$want" ]] || fail "/$rel: served bytes differ from release $release"
  fi
done

# 3. Paths GitHub Pages answers with 404: there is no SPA fallback, and nothing
#    from the repository, the CLI/MCP package or the deploy tooling is published.
for path in /some/deep/link /docs/ /docs/index.html /README.md /CHANGELOG.md /package.json \
  /bun.lock /src/cli.ts /dist/cli.js /deploy/release.sh /deploy/ompdocs.caddy /.git/HEAD \
  /.git/config /.env /CNAME /.nojekyll /robots.txt /sitemap.xml /llms.txt /index.htm; do
  expect "$path" 404 || true
done

# 4. Shared analytics routes, from the edge only. The config body holds the
#    public project token, so only this host's registration is reported.
if [[ -z $fallback ]]; then
  expect /_analytics/fleet.js 200 'javascript' || true
  expect /_analytics/fleet.css 200 '^text/css' || true
  expect /_analytics/privacy.html 200 '^text/html' || true
  expect /_analytics/not-a-route 404 || true
  if expect /_analytics/config.json 200 '^application/json'; then
    if grep -q '"omp.wolfie.gg"' "$tmp/body"; then
      echo "info /_analytics/config.json lists omp.wolfie.gg (browser analytics can start after consent)"
    else
      echo "info /_analytics/config.json does not list omp.wolfie.gg (loader stays off on this host)"
    fi
  fi
fi

if [[ $failures -gt 0 ]]; then
  printf '%d probe(s) failed\n' "$failures"
  exit 1
fi
echo "all probes passed"
