# Releasing

Checklist for cutting a release of `omp-episodic-memory`. Versions follow
[Semantic Versioning](https://semver.org/).

## Pre-flight (clean tree)

1. `bun run check` — type-check passes.
2. `bun run test` — full suite green.
3. `bun run eval -- --questions test/fixtures/eval/questions.jsonl --sessions test/fixtures/sessions --mode text`
   — recall baseline holds (Recall@5 100%, abstention 100%, FP 0% on fixtures).
4. `git status` — working tree clean; everything intended is committed.

## Version + changelog

5. Bump `version` in `package.json`.
6. Add a dated section to `CHANGELOG.md` under the new version, plus its
   `[x.y.z]: https://github.com/wolfiesch/omp-episodic-memory/releases/tag/vx.y.z`
   link reference at the bottom.
7. Commit: `git commit -m "release: vX.Y.Z — <summary>"`.

## Package verification (catches publish-time surprises)

8. `bun run build` — `dist/` compiles.
9. Confirm both bin shebangs: `head -1 dist/cli.js dist/mcp-server.js`
   (each must start with `#!/usr/bin/env node`).
10. `npm pack --dry-run` — inspect the tarball. It must contain `dist/`,
    `README.md`, `FORMAT.md`, `LICENSE`, `package.json` and nothing stray
    (no `src/`, `test/`, `.db`, `node_modules`).
11. `npm publish --dry-run --access public` — **must emit no `bin` warnings.**
    npm's bin-path validator rejects a leading `./`; bin paths must be bare
    (`dist/cli.js`, not `./dist/cli.js`). If it auto-corrects/removes bins,
    fix `package.json` and re-run before publishing.

## Tag + GitHub release

12. `git tag -a vX.Y.Z -m "vX.Y.Z — <summary>"`.
13. `git push origin main && git push origin vX.Y.Z`.
14. `gh release create vX.Y.Z --title "vX.Y.Z — <title>" --notes-file <notes.md>`
    (notes derived from the CHANGELOG section).

## npm publish

15. `npm whoami` — if `ENEEDAUTH`, run `npm login` (interactive, browser OTP).
16. `npm publish --access public` — publishes the **current** `package.json`
    version. If a security/bin fix changed the tree after tagging, re-tag a new
    patch rather than publishing a tree that diverges from the released tag.

## Post-publish smoke test

17. `npx -y -p omp-episodic-memory omp-episodic --help` — CLI bin resolves.
18. `npx -y -p omp-episodic-memory omp-episodic-mcp` — MCP server boots and
    prints its stdio banner to stderr (Ctrl-C to stop).
19. Confirm `npm view omp-episodic-memory version` matches the tag.

## Notes

- `dist/` is gitignored and never committed; it is built fresh by `prepack`
  on publish and by step 8 locally.
- The first vector search downloads the embedding model; `--mode text` avoids
  the network path and is what CI and the eval baseline use.
- Dependabot: after pushing, check
  `gh api repos/wolfiesch/omp-episodic-memory/dependabot/alerts --jq '[.[]|select(.state=="open")]|length'`
  is `0`.

## Automated release (provenance)

Pushing a version tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
which runs `bun run check` + `bun run test` then publishes with
`npm publish --provenance --access public` using the `NPM_TOKEN` repo secret
(Settings → Secrets and variables → Actions). The workflow's OIDC `id-token`
produces a verified provenance attestation on npm.

Steps:

1. Bump `version` in `package.json`.
2. Update `CHANGELOG.md`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Actions publishes the package with a verified provenance attestation.

One-time setup: add a publish-capable npm token as the `NPM_TOKEN` repo secret.
The account enforces 2FA on publish, so the token MUST be one that bypasses the
interactive OTP — use **either**:
- a **Classic Automation token** (npmjs.com → Access Tokens → Generate New Token
  → Classic → *Automation*), which bypasses 2FA and can create new packages; or
- a **Granular Access token** with **Read and write** packages permission. Scope
  it to all packages for a *first-ever* publish (a package-scoped granular token
  cannot create a name that does not yet exist on npm), then narrow it to
  `omp-episodic-memory` for subsequent releases.

Do NOT use a Classic *Read-only* or *Publish*-with-2FA-required token — both fail
the publish with `403 ... requires two-factor authentication`.
