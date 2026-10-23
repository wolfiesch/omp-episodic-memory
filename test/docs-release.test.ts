import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const legacy = "# BEGIN wolfie-platform-lab:omp\nomp.wolfie.gg {\n respond \"legacy\" 200\n}\n# END wolfie-platform-lab:omp\n";
const before = "before.example {\n respond \"before\" 200\n}\n";
const after = "after.example {\n respond \"after\" 200\n}\n";

function runRelease(...args: string[]) {
  return spawnSync("bash", ["deploy/release.sh", ...args], { encoding: "utf8" });
}

for (const [command, marker] of [
  ["edge-candidate", "wolfie-platform-lab:omp"],
  ["edge-rollback", "ompdocs"],
]) {
  test(`${command} refuses reversed markers without writing a candidate`, () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-release-"));
    try {
      const input = join(dir, "input.Caddyfile");
      const output = join(dir, "output.Caddyfile");
      const source = join(dir, "backup.Caddyfile");
      const original = `${before}# END ${marker}\n# BEGIN ${marker}\n${after}`;
      writeFileSync(input, original);
      writeFileSync(source, legacy);
      const result = runRelease(command, input, output, source);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(output), false);
      assert.equal(readFileSync(input, "utf8"), original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("cutover and rollback preserve unrelated routes and are idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-release-"));
  try {
    const input = join(dir, "input.Caddyfile");
    const candidate = join(dir, "candidate.Caddyfile");
    const repeated = join(dir, "repeated.Caddyfile");
    const rollback = join(dir, "rollback.Caddyfile");
    const original = before + legacy + after;
    writeFileSync(input, original);
    const cutover = runRelease("edge-candidate", input, candidate);
    assert.equal(cutover.status, 0, cutover.stderr);
    const cutoverText = readFileSync(candidate, "utf8");
    assert.ok(cutoverText.startsWith(before));
    assert.ok(cutoverText.endsWith(after));
    const repeat = runRelease("edge-candidate", candidate, repeated);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(readFileSync(repeated, "utf8"), cutoverText);
    const restore = runRelease("edge-rollback", candidate, rollback, input);
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(readFileSync(rollback, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
