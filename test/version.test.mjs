import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect, check } from "../scripts/check-version.mjs";

const CHECK_VERSION = fileURLToPath(new URL("../scripts/check-version.mjs", import.meta.url));
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

// This is the one place the version check runs (npm test no longer calls the script a second time).
// On a tag build GITHUB_REF_TYPE/GITHUB_REF_NAME are in process.env, so the tag is checked as well.
test("all version sources agree (and the tag, on a tag build)", () => {
  assert.deepEqual(check(collect(process.env)), []);
});

test("a mismatching source is reported", () => {
  assert.equal(check({ "package.json": "1.0.0", "CHANGELOG.md": "0.9.0" }).length, 1);
  assert.equal(check({ "package.json": "1.0.0", "CHANGELOG.md": undefined }).length, 1);
});

test("a tag build must match the tag without v", () => {
  const v = collect({})["package.json"];
  assert.deepEqual(check(collect({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${v}` })), []);
  assert.equal(check(collect({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" })).length, 1);
});

test("engines.node is the oldest Node the client is tested on, and the README says so", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.engines.node, ">=18.14");
  assert.match(read("README.md"), /18\.14/);
});

test("the script runs when started through a symlink (it used to skip silently)", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cv-"));
  scratch.push(dir);
  const link = path.join(dir, "link-check-version.mjs");
  symlinkSync(CHECK_VERSION, link);
  const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok\s+package\.json = /);
});

test("the script prints every source when run directly", () => {
  const r = spawnSync(process.execPath, [CHECK_VERSION], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /st\.mjs VERSION/);
});
