import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkAll, checkText, buildSnapshot, SNAPSHOT } from "../scripts/check-tools.mjs";

const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

test("SKILL.md and AGENTS.md only name tools, arguments and enum values the live server has", () => {
  assert.deepEqual(checkAll(snap), []);
});

test("snapshot carries the tools the skill depends on", () => {
  for (const t of ["search_issues", "update_issue_status", "move_issue", "check_criteria", "get_work_context"]) {
    assert.ok(snap.tools[t], `${t} missing from snapshot`);
  }
  assert.ok(snap.tools.update_issue_status.properties.expect, "expect argument");
  assert.ok(snap.tools.update_issue_status.properties.confirm_open_criteria, "confirm_open_criteria argument");
  assert.ok(snap.tools.search_issues.properties.category.enum.includes("todo"));
});

test("negative control: an unknown tool, argument or enum value is reported", () => {
  assert.equal(checkText("call `search_issuez` now", snap).length, 1);
  assert.equal(checkText(`call search_issues '{"project":"K","nope":1}'`, snap).length, 1);
  assert.equal(checkText(`call search_issues '{"category":"doing"}'`, snap).length, 1);
  assert.equal(checkText('use `category:"doing"` here', snap).length, 1);
  assert.deepEqual(checkText(`call search_issues '{"category":["todo"],"blocked":false}'`, snap), []);
});

test("buildSnapshot keeps argument names and nested enums", () => {
  const s = buildSnapshot([
    { name: "b", inputSchema: { properties: { x: { anyOf: [{ enum: ["1"] }, { items: { enum: ["2"] } }] } }, required: ["x"] } },
    { name: "a", inputSchema: {} },
  ]);
  assert.deepEqual(Object.keys(s.tools), ["a", "b"]);
  assert.deepEqual(s.tools.b.properties.x.enum, ["1", "2"]);
});
