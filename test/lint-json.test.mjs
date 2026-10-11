// Parses every JSON manifest of the repo. Paths are resolved from the repo root, so it works from any cwd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".mcp.json",
  "gemini-extension.json",
  ".sprintree.example.json",
  "test/tools.snapshot.json",
];

for (const f of FILES) {
  test(`${f} is valid JSON`, () => {
    assert.ok(existsSync(path.join(ROOT, f)), `${f} is missing`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(ROOT, f), "utf8")));
  });
}

test("the example config shows all five keys", () => {
  const ex = JSON.parse(readFileSync(path.join(ROOT, ".sprintree.example.json"), "utf8"));
  assert.deepEqual(Object.keys(ex).sort(), ["language", "project", "section_titles", "statuses", "typography"]);
});

test("no other JSON manifest was added without being listed here", () => {
  const found = [".", ".claude-plugin"].flatMap((d) => readdirSync(path.join(ROOT, d)).filter((n) => n.endsWith(".json")).map((n) => path.posix.join(d === "." ? "" : d, n)));
  const unlisted = found.filter((f) => !FILES.includes(f));
  assert.deepEqual(unlisted, []);
});

// The child run sets LINT_JSON_CHILD so this test does not spawn itself again (endless recursion).
test("works from any working directory", { skip: process.env.LINT_JSON_CHILD === "1" }, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "lj-"));
  try {
    const r = spawnSync(process.execPath, ["--test", path.join(ROOT, "test", "lint-json.test.mjs")], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, LINT_JSON_CHILD: "1" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
