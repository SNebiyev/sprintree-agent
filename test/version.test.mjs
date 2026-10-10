import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, check } from "../scripts/check-version.mjs";

test("all version sources agree", () => {
  assert.deepEqual(check(collect({})), []);
});

test("a mismatching source is reported", () => {
  assert.equal(check({ "package.json": "1.0.0", "CHANGELOG.md": "0.9.0" }).length, 1);
  assert.equal(check({ "package.json": "1.0.0", "CHANGELOG.md": undefined }).length, 1);
});

test("a tag build must match the tag without v", () => {
  assert.deepEqual(check(collect({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${collect({})["package.json"]}` })), []);
  assert.equal(check(collect({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" })).length, 1);
});
