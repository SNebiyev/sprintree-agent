// Parses every JSON file of the repo (root, .claude-plugin, test). Paths are resolved from the repo root, so it works from any cwd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../test-support/helpers.mjs";

// Manifests that must exist; any other *.json found is parsed too, without being listed here.
const REQUIRED = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".mcp.json",
  "gemini-extension.json",
  ".sprintree.example.json",
  "test/tools.snapshot.json",
];

const found = [".", ".claude-plugin", "test"].flatMap((d) =>
  readdirSync(path.join(ROOT, d))
    .filter((n) => n.endsWith(".json"))
    .map((n) => path.posix.join(d === "." ? "" : d, n))
);

for (const f of REQUIRED) {
  test(`${f} exists`, () => assert.ok(existsSync(path.join(ROOT, f)), `${f} is missing`));
}

for (const f of new Set([...REQUIRED, ...found])) {
  test(`${f} is valid JSON`, () => {
    assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(ROOT, f), "utf8")));
  });
}
