#!/usr/bin/env bash
# Package, stage, activate and inspect omp.wolfie.gg releases of the docs/
# landing page on the shared edge host, and prepare the edge Caddyfile swap.
# See deploy/README.md.
#
#   deploy/release.sh build [REV]                   export docs/ at REV (default HEAD) with `git archive`
#   deploy/release.sh stage REV                     copy a built release to the host and verify its checksums
#   deploy/release.sh activate REV                  point the served `ompdocs` symlink at a staged release
#   deploy/release.sh status                        show the active and staged releases and the live edge block
#   deploy/release.sh edge-candidate IN OUT         write IN with deploy/ompdocs.caddy as the omp.wolfie.gg block
#   deploy/release.sh edge-rollback IN OUT SOURCE   write IN with the wolfie-platform-lab:omp block from SOURCE
#
# REV for stage/activate is the 12-hex release id printed by `build`. SOURCE is
# any file holding the marked wolfie-platform-lab:omp block, normally the edge
# Caddyfile backup taken before cutover. After edge-rollback, also revert the
# wolfie-platform-lab fix commit (see deploy/README.md, Rollback): its guard
# refuses to deploy while no ompdocs block exists. The edge commands only
# transform local files; validating, installing and reloading the result is a
# separate, reviewed step.
#
# Environment (names only):
#   OMPDOCS_DEPLOY_HOST     ssh destination of the edge host (alias or user@host)
#   OMPDOCS_STATIC_ROOT     absolute host directory mounted into the edge Caddy
#                           container as /srv/static
#   OMPDOCS_EDGE_CADDYFILE  absolute host path of the edge Caddyfile (status only, optional)
#   OMPDOCS_RELEASE_DIR     local release artifacts (default ~/.cache/ompdocs/releases)
#
# The site has no build step. A release is exactly the published docs/ files of
# one commit, exported with `git archive`, so working-tree edits and untracked
# files never reach the host.
set -euo pipefail

SITE=ompdocs
# The complete published file set, in C-locale order. Adding a file to docs/
# fails the build until it is listed here and in deploy/manifest.json.
FILES='THIRD_PARTY_NOTICES.md
favicon.svg
index.html
og-image-card.html
og-image.png'

deploy_dir=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$deploy_dir/.." rev-parse --show-toplevel)
release_root=${OMPDOCS_RELEASE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ompdocs/releases}

die() {
  printf 'release.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

require_rev() {
  [[ ${1:-} =~ ^[0-9a-f]{12}$ ]] || die "release id must be 12 lowercase hex characters, got '${1:-}'"
}

require_remote() {
  local host=${OMPDOCS_DEPLOY_HOST:-}
  local root=${OMPDOCS_STATIC_ROOT:-}
  [[ $host =~ ^[A-Za-z0-9_][A-Za-z0-9._@:-]*$ ]] || die "set OMPDOCS_DEPLOY_HOST to an ssh destination"
  [[ $root =~ ^/[A-Za-z0-9._/-]+$ && $root != *..* && $root != / ]] ||
    die "set OMPDOCS_STATIC_ROOT to an absolute directory path"
}

# Run a script on the edge host with positional arguments. Every argument is
# validated to a shell-safe alphabet before it reaches the remote command line.
remote() {
  local script=$1
  shift
  ssh -o BatchMode=yes "$OMPDOCS_DEPLOY_HOST" sh -s -- "$@" <<<"$script"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

count() {
  grep -o -F -- "$1" "$2" | wc -l | tr -d ' '
}

# Fail unless the exported site is exactly the published file set, with the
# hostname-gated analytics hook and footer controls exactly once in index.html,
# no static tag that would load a shared analytics route on any other host, and
# no analytics reference in the other files.
verify_site() {
  local site=$1 index=$1/index.html

  [[ -z $(find "$site" -mindepth 1 ! -type f -print -quit) ]] || die "docs/ contains a directory or symlink"
  [[ $(cd "$site" && find . -type f | sed 's|^\./||' | LC_ALL=C sort) == "$FILES" ]] ||
    die "docs/ must contain exactly: $(tr '\n' ' ' <<<"$FILES")"

  [[ $(count "if (location.hostname === 'omp.wolfie.gg') {" "$index") == 1 ]] ||
    die "index.html must gate analytics on the omp.wolfie.gg hostname exactly once"
  [[ $(count "loader.src = '/_analytics/fleet.js';" "$index") == 1 && $(count /_analytics/fleet.js "$index") == 1 ]] ||
    die "index.html must reference /_analytics/fleet.js once, from the hostname-gated loader only"
  [[ $(grep -c -E '<p id="analytics-controls" [^>]* hidden>' "$index") == 1 ]] ||
    die "index.html must ship the analytics footer controls hidden"
  [[ $(count 'href="/_analytics/privacy.html"' "$index") == 1 ]] ||
    die "index.html must link the privacy notice exactly once"
  [[ $(grep -c -E '<(script|link)[^>]*/_analytics/' "$index") == 0 ]] ||
    die "index.html must not load /_analytics/ from a static tag; the GitHub Pages copy would request it"
  [[ $(count data-fleet-analytics-settings "$index") == 1 ]] ||
    die "index.html must carry exactly one analytics settings control"
  [[ $(count '<meta property="og:url" content="https://omp.wolfie.gg/">' "$index") == 1 ]] ||
    die "index.html must keep the canonical og:url https://omp.wolfie.gg/"

  local rel
  while IFS= read -r rel; do
    [[ $rel == index.html ]] && continue
    ! grep -q -F /_analytics/ "$site/$rel" || die "$rel must not reference /_analytics/"
  done <<<"$FILES"
}

cmd_build() {
  local sha rev tree work
  sha=$(git -C "$repo" rev-parse --verify "${1:-HEAD}^{commit}") || die "unknown revision '${1:-HEAD}'"
  tree=$(git -C "$repo" rev-parse --verify "$sha:docs") || die "commit $sha has no docs/"
  rev=${sha:0:12}
  work=$release_root/$rev
  [[ ! -e $work ]] || die "$work already exists; remove it to rebuild $rev"

  export_dir=$(mktemp -d "${TMPDIR:-/tmp}/ompdocs-build.XXXXXX")
  trap 'rm -rf "$export_dir"' EXIT
  git -C "$repo" archive --format=tar "$sha" docs | tar -x -C "$export_dir"
  verify_site "$export_dir/docs"

  mkdir -p "$work"
  cp -R "$export_dir/docs" "$work/site"
  (
    cd "$work/site"
    while IFS= read -r rel; do
      sha256_file "$rel"
    done <<<"$FILES"
  ) >"$work/SHA256SUMS"
  printf 'commit %s\ndocs_tree %s\n' "$sha" "$tree" >"$work/REVISION"

  printf 'built release %s (commit %s, docs tree %s), %s files in %s\n' \
    "$rev" "$sha" "$tree" "$(wc -l <"$work/SHA256SUMS" | tr -d ' ')" "$work"
}

cmd_stage() {
  local rev=${1:-}
  require_rev "$rev"
  require_remote
  local work=$release_root/$rev
  [[ -f $work/SHA256SUMS && -d $work/site ]] || die "release $rev is not built; run: deploy/release.sh build"
  local releases=$OMPDOCS_STATIC_ROOT/$SITE-releases

  local state
  state=$(remote '
    set -eu
    root=$1 site=$2 rev=$3
    test -d "$root" || { echo "static root $root does not exist" >&2; exit 1; }
    mkdir -p "$root/$site-releases"
    if [ -e "$root/$site-releases/$rev" ]; then echo present; else echo absent; fi
  ' "$OMPDOCS_STATIC_ROOT" "$SITE" "$rev")

  if [[ $state == absent ]]; then
    rsync -rt --delete "$work/site/" "$OMPDOCS_DEPLOY_HOST:$releases/.incoming-$rev/"
    rsync -t "$work/SHA256SUMS" "$OMPDOCS_DEPLOY_HOST:$releases/$rev.sha256"
  else
    remote 'cat "$1/$2.sha256"' "$releases" "$rev" | cmp -s - "$work/SHA256SUMS" ||
      die "release $rev is already staged with different checksums; investigate before reusing it"
  fi

  # A staged release is renamed into place only after every checksum matches
  # and no extra file is present; an existing one is re-verified unchanged.
  remote '
    set -eu
    releases=$1 rev=$2
    cd "$releases"
    dir=$rev
    [ -d "$rev" ] || { dir=.incoming-$rev; chmod -R u=rwX,go=rX "$dir" "$rev.sha256"; }
    ( cd "$dir" && sha256sum -c --quiet "../$rev.sha256" )
    expected=$(wc -l <"$rev.sha256")
    actual=$(find "$dir" -mindepth 1 | wc -l)
    [ "$expected" -eq "$actual" ] || { echo "$dir has $actual entries, expected $expected files" >&2; exit 1; }
    [ "$dir" = "$rev" ] || mv -T "$dir" "$rev"
    echo "staged $releases/$rev ($actual files verified)"
  ' "$releases" "$rev"
}

cmd_activate() {
  local rev=${1:-}
  require_rev "$rev"
  require_remote
  remote '
    set -eu
    root=$1 site=$2 rev=$3
    cd "$root"
    [ -d "$site-releases/$rev" ] || { echo "release $rev is not staged" >&2; exit 1; }
    ( cd "$site-releases/$rev" && sha256sum -c --quiet "../$rev.sha256" )
    previous=none
    if [ -L "$site" ]; then
      previous=$(readlink "$site")
    elif [ -e "$site" ]; then
      echo "$root/$site exists and is not a symlink; refusing to replace it" >&2
      exit 1
    fi
    ln -sfn "$site-releases/$rev" "$site-releases/.activate-$rev"
    mv -T "$site-releases/.activate-$rev" "$site"
    echo "previous: $previous"
    echo "current:  $(readlink "$site")"
  ' "$OMPDOCS_STATIC_ROOT" "$SITE" "$rev"
}

cmd_status() {
  require_remote
  remote '
    set -eu
    root=$1 site=$2
    cd "$root"
    if [ -L "$site" ]; then echo "current: $(readlink "$site")"; else echo "current: none"; fi
    echo "staged:"
    if [ -d "$site-releases" ]; then
      ls -1t "$site-releases" | grep -E "^[0-9a-f]{12}$" || true
    fi
  ' "$OMPDOCS_STATIC_ROOT" "$SITE"

  local caddyfile=${OMPDOCS_EDGE_CADDYFILE:-}
  [[ -n $caddyfile ]] || return 0
  [[ $caddyfile =~ ^/[A-Za-z0-9._/-]+$ && $caddyfile != *..* ]] ||
    die "OMPDOCS_EDGE_CADDYFILE must be an absolute file path"
  # Read-only. Reports which owner serves omp.wolfie.gg; a wolfie-platform-lab
  # Caddy deploy that still ships ops/caddy/omp.Caddyfile reinstates the redirect.
  remote '
    set -eu
    file=$1
    for marker in ompdocs wolfie-platform-lab:omp; do
      if grep -qxF "# BEGIN $marker" "$file"; then echo "edge block: $marker"; fi
    done
    echo "omp.wolfie.gg site blocks: $(grep -cE "^(https?://)?omp[.]wolfie[.]gg([[:space:]]|[{,:]|\$)" "$file" || true)"
  ' "$caddyfile"
}

# The lines from `# BEGIN <marker>` to `# END <marker>` of a fragment file.
marked_block() {
  local file=$1 marker=$2 block
  block=$(awk -v begin="# BEGIN $marker" -v end="# END $marker" '
    $0 == begin { inside = 1 }
    inside { print }
    $0 == end { inside = 0 }
  ' "$file")
  [[ $(grep -c -x -F "# BEGIN $marker" <<<"$block") == 1 && $(tail -n 1 <<<"$block") == "# END $marker" ]] ||
    die "$file must contain one complete '$marker' block"
  printf '%s\n' "$block"
}

# Write IN to OUT with whichever omp.wolfie.gg block it holds (ompdocs or
# wolfie-platform-lab:omp) replaced by the WANT block from FRAGMENT. Running it
# twice gives the same output; every other line is copied unchanged.
swap_edge_block() {
  local in=$1 out=$2 fragment=$3 want=$4
  [[ -f $in && -n $out && -f $fragment ]] ||
    die "usage: deploy/release.sh edge-candidate IN OUT | edge-rollback IN OUT SOURCE"
  [[ ! -e $out ]] || die "$out already exists"

  local marker found=()
  for marker in ompdocs wolfie-platform-lab:omp; do
    if grep -q -x -F "# BEGIN $marker" "$in"; then found+=("$marker"); fi
  done
  [[ ${#found[@]} == 1 ]] ||
    die "$in must hold exactly one of the ompdocs and wolfie-platform-lab:omp blocks (found ${#found[@]})"
  marker=${found[0]}
  [[ $(grep -c -x -F "# BEGIN $marker" "$in") == 1 && $(grep -c -x -F "# END $marker" "$in") == 1 ]] ||
    die "$in has an unbalanced '$marker' block"
  marked_block "$in" "$marker" >/dev/null

  local block
  block=$(marked_block "$fragment" "$want")
  # ENVIRON, not -v: awk would interpret backslash escapes in a -v value.
  OMPDOCS_BLOCK=$block awk -v begin="# BEGIN $marker" -v end="# END $marker" '
    $0 == begin { print ENVIRON["OMPDOCS_BLOCK"]; skip = 1; next }
    skip && $0 == end { skip = 0; next }
    !skip { print }
  ' "$in" >"$out"

  local sites
  sites=$(grep -c -E '^(https?://)?omp[.]wolfie[.]gg([[:space:]]|[{,:]|$)' "$out" || true)
  [[ $sites == 1 ]] || {
    rm -f "$out"
    die "the result defines omp.wolfie.gg in $sites site blocks, expected 1"
  }
  printf 'replaced %s block with %s block (sha256 %s): %s\n' "$marker" "$want" \
    "$(printf '%s\n' "$block" | sha256_file /dev/stdin | cut -d' ' -f1)" "$out"
  diff -u "$in" "$out" || true
}

case ${1:-} in
  build) cmd_build "${2:-}" ;;
  stage) cmd_stage "${2:-}" ;;
  activate) cmd_activate "${2:-}" ;;
  status) cmd_status ;;
  edge-candidate) swap_edge_block "${2:-}" "${3:-}" "$deploy_dir/ompdocs.caddy" ompdocs ;;
  edge-rollback) swap_edge_block "${2:-}" "${3:-}" "${4:-}" wolfie-platform-lab:omp ;;
  *) usage ;;
esac
