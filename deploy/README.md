# omp.wolfie.gg hosting

The landing page in `docs/` is published two ways:

- **GitHub Pages**, from `main:/docs`, at `https://wolfiesch.github.io/omp-episodic-memory/`. This
  copy stays live and is the rollback origin.
- **The shared edge Caddy (2.8.4) on the VPS**, at `https://omp.wolfie.gg/`, using the tooling in
  this directory. Until cutover, the edge sends `omp.wolfie.gg` through the
  `wolfie-platform-lab:omp` block to the K3s Caddy, which answers every path with a 302 to the
  GitHub Pages copy.

On the edge no container or port is added. The edge container mounts the host's static root at
`/srv/static`. `/srv/static/ompdocs` is a relative symlink to a versioned release directory, so
activation and release rollback are a single atomic symlink swap.

```
<static root>/ompdocs -> ompdocs-releases/<rev>
<static root>/ompdocs-releases/<rev>/         # the published docs/ files
<static root>/ompdocs-releases/<rev>.sha256   # checksums, outside the docroot
```

| File | Purpose |
|---|---|
| `deploy/release.sh` | `build`, `stage`, `activate`, `status`, `edge-candidate`, `edge-rollback` |
| `deploy/ompdocs.caddy` | The `omp.wolfie.gg` site block, between `# BEGIN ompdocs` / `# END ompdocs` |
| `deploy/smoke.sh` | HTTP probes for the edge site and for the GitHub Pages fallback |
| `deploy/manifest.json` | Routes, headers, provenance, env variable names, analytics paths, registry proposal, owner hazards |

## Response contract

The edge serves the same five files GitHub Pages does, at the site root, so every relative link
in `index.html` keeps working and the existing `og:url`/`og:image` URLs on `omp.wolfie.gg`
resolve directly instead of through a redirect:

| Path | Status | Content-Type |
|---|---|---|
| `/`, `/index.html` | 200 | `text/html` |
| `/favicon.svg` | 200 | `image/svg+xml` |
| `/og-image.png` | 200 | `image/png` |
| `/og-image-card.html` | 200 | `text/html` |
| `/THIRD_PARTY_NOTICES.md` | 200 | `text/markdown; charset=utf-8` |
| anything else, including `/robots.txt`, `/sitemap.xml`, `/llms.txt` | 404 | |

There is no SPA fallback and no directory listing. Responses carry the GitHub Pages values
`Cache-Control: max-age=600`, `Access-Control-Allow-Origin: *` and
`Strict-Transport-Security: max-age=31556952`. As on GitHub Pages, there is no
Content-Security-Policy: the page depends on the Tailwind Play CDN, inline configuration and
inline scripts. The page needs no runtime environment variables or secrets. GitHub Pages serves
an HTML 404 page; the edge returns the status without that page.

## Analytics and privacy

`docs/index.html` holds one hostname-gated hook after the footer. On `omp.wolfie.gg` it:

- reveals the footer's **Privacy** link to `/_analytics/privacy.html`;
- inserts `/_analytics/fleet.js` once;
- reveals the footer's **Analytics settings** button (`data-fleet-analytics-settings`) once the
  loader has published `window.fleetAnalytics`.

The loader, its stylesheet, its config and its ingest endpoint are same-origin routes served by
the edge's `wolfsuite_fleet_routes`. The block imports them before its file server.

Every other host of the same file loads nothing and keeps both controls hidden. That includes
the GitHub Pages copy, which has no `/_analytics/` routes, and where a root-relative
`/_analytics/fleet.js` would resolve against `wolfiesch.github.io` rather than this project.
`deploy/release.sh build` refuses a page that loads an `/_analytics/` route from a static tag.

No project token is committed. The edge serves it in `/_analytics/config.json` at deployment.

Nothing is sent before the visitor accepts. Do Not Track and Global Privacy Control keep
analytics off, and Reject or a later withdrawal stops collection. After acceptance, only
anonymous, session-scoped page views of `/` (or `/index.html`) are counted, with no custom
events. The `#section` fragments the table of contents writes are never reported. The page has
no forms or inputs, and copied install or MCP config text is never collected.

## Preflight

All checks are read-only.

1. **Edge snippets.** The shared edge's analytics configuration defines
   `wolfsuite_fleet_log` and `wolfsuite_fleet_routes`. Stage `/_analytics/fleet.js`,
   `fleet.css`, `privacy.html` and `config.json` in its static root.
   Without these dependencies, the candidate does not validate.
2. **wolfie-platform-lab.** Before the fix, that repository's
   `scripts/deploy-caddy-k8s-health.sh` removes every `# BEGIN wolfie-platform-lab:` block and
   every top-level `omp.wolfie.gg {` block. Run after cutover, it reduces the `ompdocs` block to
   its bare marker lines, then re-appends `ops/caddy/omp.Caddyfile`, which reinstates the
   redirect. Merge the [routing-owner fix](https://github.com/wolfiesch/wolfie-platform-lab/pull/3)
   before cutover. It does three things:
   - deletes `ops/caddy/omp.Caddyfile`;
   - narrows the legacy site pattern to `^(k8s-health|freakoff)[.]wolfie[.]gg` and drops the
     omp comment strip;
   - adds a guard: the deploy exits 1 before writing unless the result holds exactly one
     `# BEGIN ompdocs` and one `# END ompdocs`.

   Merge it before cutover. Its K3s Caddy configuration, including the omp redirect, stays
   untouched for rollback. Running the deploy script from any checkout without the fix still
   destroys this block after cutover; deploy only from the fixed `main`.
3. **Analytics registration.** Keep request-only coverage until cutover, then enable browser
   mode together with the new docs block. Apply the changes described in
   `manifest.json` (`registry_proposal.at_cutover`) in the same operation so future edge
   updates preserve the browser analytics routes.
4. **Edge state.** `deploy/release.sh status` with `OMPDOCS_EDGE_CADDYFILE` set prints
   `edge block: wolfie-platform-lab:omp` and `omp.wolfie.gg site blocks: 1`.
5. **DNS.** `omp.wolfie.gg` already resolves to the edge host, and the edge already holds its
   certificate. No DNS change is needed in either direction.
6. **Fallback baseline.** `deploy/smoke.sh --fallback` passes.

## Build

```bash
deploy/release.sh build            # or: deploy/release.sh build <commit>
```

The commit's `docs/` is exported with `git archive` into a temporary directory, so working-tree
edits and untracked files never reach a release. The build fails unless `docs/` holds exactly the
five published files, with no directory or symlink. It also fails unless `index.html` has:

- the hostname-gated loader exactly once;
- the hidden footer controls;
- one privacy link and one settings control;
- no static tag loading an `/_analytics/` route;
- the canonical `og:url`.

The result is kept in `$OMPDOCS_RELEASE_DIR/<rev>/` (default `~/.cache/ompdocs/releases`):

- `site/`, the files;
- `SHA256SUMS`;
- `REVISION`, the full commit and the `docs/` tree id.

The printed `<rev>` is the first 12 hex characters of the commit.

## Stage and activate

```bash
export OMPDOCS_DEPLOY_HOST=<ssh destination of the edge host>
export OMPDOCS_STATIC_ROOT=<host directory mounted at /srv/static in the edge Caddy container>
export OMPDOCS_EDGE_CADDYFILE=<host path of the edge Caddyfile>   # optional, for status

deploy/release.sh stage <rev>      # rsync to ompdocs-releases/.incoming-<rev>, verify, rename
deploy/release.sh activate <rev>   # atomic symlink swap; prints the previous and current target
deploy/release.sh status
```

`stage` renames a release into place only after every checksum matches and no extra file is
present. `activate` re-verifies the checksums and refuses to replace an `ompdocs` entry that is
not a symlink. The script never deletes a release.

Activating before cutover is safe: nothing serves `/srv/static/ompdocs` until the edge block is
swapped.

## Cutover

The edge container bind-mounts the Caddyfile as a single file. Write the new content into the
existing file, keeping its inode, rather than replacing the file. Keep the backup: it is the
rollback source.

```bash
cp "$EDGE_CADDYFILE" "$EDGE_CADDYFILE.bak-ompdocs-$(date -u +%Y%m%dT%H%M%SZ)"
deploy/release.sh edge-candidate "$EDGE_CADDYFILE" candidate.Caddyfile   # prints the diff
docker cp candidate.Caddyfile "$EDGE_CADDY_CONTAINER":/tmp/candidate.Caddyfile
docker exec "$EDGE_CADDY_CONTAINER" caddy validate --config /tmp/candidate.Caddyfile --adapter caddyfile
cat candidate.Caddyfile > "$EDGE_CADDYFILE"
docker exec "$EDGE_CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

`edge-candidate` copies every other line unchanged. It refuses unless the input holds exactly
one of the `wolfie-platform-lab:omp` and `ompdocs` blocks, and unless the result defines
`omp.wolfie.gg` exactly once. Running it on an already-cut-over file reproduces that file. The
diff it prints must show only the block swap.

Order:

1. Preflight, then build, stage and activate the release.
2. Land the wolfie-platform-lab fix from preflight step 2. From here until step 3, its deploy
   script fails closed and changes nothing, because no `ompdocs` block exists yet.
3. Validate the candidate, install it and reload.
4. Land the registry change and redeploy `/_analytics/config.json` from it. Until then the
   loader finds `omp.wolfie.gg` request-only and stays off.
5. Run the readiness checks.

## Readiness

```bash
deploy/smoke.sh --release <rev>
deploy/smoke.sh --fallback
```

The edge smoke test checks these responses:

- `/` is served by Caddy, not by the K3s redirect, with the headers above, the canonical
  `og:url`, the hostname-gated hook once and the settings control once. No static tag loads an
  analytics route.
- Each published file matches the release byte for byte, with the content type above.
- These paths return 404: unknown paths, `/docs/…`, repository and package files, deploy
  tooling, `/robots.txt`, `/sitemap.xml` and `/llms.txt`.
- The shared `/_analytics/` routes are served, and `/_analytics/config.json` reports whether it
  lists `omp.wolfie.gg`.

The fallback smoke test checks that the GitHub Pages copy still serves the five files and 404s
unknown paths. It also checks that the copy loads no analytics route, other than through the
`omp.wolfie.gg` gate. Neither test prints response bodies.

Browser checks after cutover:

1. `https://omp.wolfie.gg/` renders the styled page, with no redirect. The favicon, the footer
   badges, and the `notices` link to `/THIRD_PARTY_NOTICES.md` all work.
2. The table-of-contents links scroll and update the `#fragment`. The copy buttons work.
3. The footer shows **Privacy** and **Analytics settings**. On a first visit the consent panel
   appears, and Reject, Accept and settings behave as the fleet contract requires.
4. `https://wolfiesch.github.io/omp-episodic-memory/` renders unchanged, with no footer
   analytics controls and no `/_analytics/` request in the network panel.

## Rollback

- **Previous release:** `deploy/release.sh activate <previous rev>`, using `status` or the
  `previous:` line printed at activation. It takes effect immediately and needs no Caddy reload.
- **Previous origin:** restore the K3s redirect block from the pre-cutover backup, then validate,
  install and reload as in [Cutover](#cutover):

  ```bash
  deploy/release.sh edge-rollback "$EDGE_CADDYFILE" candidate.Caddyfile "$EDGE_CADDYFILE.bak-ompdocs-<utc>"
  ```

  It prints the restored block's sha256, which should equal `replaces_edge_block.block_sha256`
  in `manifest.json` unless wolfie-platform-lab changed the block since. Then revert the whole
  wolfie-platform-lab fix commit, not only `ops/caddy/omp.Caddyfile`: its guard refuses every
  deploy while no `ompdocs` block exists, and the reverted commit restores the redirect
  fragment, which is also available as `git show 9b5af5e:ops/caddy/omp.Caddyfile`. Also revert
  the registry change. The K3s Caddy configuration and GitHub Pages were never changed, so the
  redirect works as soon as Caddy reloads.

Retiring GitHub Pages is a separate decision. Until then, every merge to `main` keeps
republishing `docs/` there, and the hostname gate keeps that copy free of analytics.
