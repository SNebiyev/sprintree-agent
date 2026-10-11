import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAll, checkText, buildSnapshot, refresh, SNAPSHOT, DOCS, ALLOW } from "../scripts/check-tools.mjs";

const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const CHECK_TOOLS = fileURLToPath(new URL("../scripts/check-tools.mjs", import.meta.url));
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("every doc that names tools or arguments is checked against the live snapshot", () => {
  assert.deepEqual(checkAll(snap), []);
  for (const f of ["skills/sprintree/SKILL.md", "README.md", "GEMINI.md"]) assert.ok(DOCS.includes(f), `${f} is not scanned`);
  assert.ok(DOCS.some((f) => /AGENTS\.md$/.test(f)), "the AGENTS.md template is not scanned");
});

test("the allow list only holds words the docs really need", () => {
  assert.ok([...ALLOW].every((w) => ["section_titles", "bearer_token_env_var"].includes(w)), [...ALLOW].join(","));
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

test("negative probe: a misspelled single-word argument in a JSON example fails", () => {
  const quoted = `call update_issue_status '{"key":"K-1","status":"done","expectt":{"status":"review"}}'`;
  const backticked = 'Use `update_issue_status` with `{"key":"K-1","expectt":{"status":"review"}}`.';
  const bare = 'update_issue_status {"key":"K-1","expectt":{"status":"review"}}';
  for (const line of [quoted, backticked, bare]) {
    const p = checkText(line, snap);
    assert.equal(p.length, 1, line);
    assert.match(p[0], /expectt/);
  }
  assert.deepEqual(checkText(`call update_issue_status '{"key":"K-1","status":"done","expect":{"status":"review"}}'`, snap), []);
});

test("negative probe: an argument of ANOTHER tool is reported, not accepted because some tool has it", () => {
  const a = checkText('Page with `search_issues` and `children_cursor:"abc"`.', snap);
  assert.equal(a.length, 1);
  assert.match(a[0], /search_issues has no argument "children_cursor"/);
  const b = checkText(`call search_issues '{"project":"K","children_cursor":"abc"}'`, snap);
  assert.equal(b.length, 1);
  assert.match(b[0], /children_cursor/);
  const c = checkText('Use `get_project_topology` with `sort:"priority"`.', snap);
  assert.equal(c.length, 1);
  assert.match(c[0], /get_project_topology has no argument "sort"/);
  const d = checkText(`call get_project_topology '{"project":"K","sort":"priority"}'`, snap);
  assert.equal(d.length, 1);
  assert.match(d[0], /sort/);
});

test("enum values are checked against the named tool's own enum", () => {
  // `status_category` of bulk_update_issues has todo/in_progress/review/done, `type` of search_issues does not have `done`
  assert.equal(checkText(`call search_issues '{"type":"done"}'`, snap).length, 1);
  assert.equal(checkText('`search_issues` with `format:"yaml"`', snap).length, 1);
  assert.deepEqual(checkText('`search_issues` with `format:"json"`', snap), []);
  // a later tool on the line owns the arguments after it
  assert.deepEqual(checkText('`search_issues` with `category:"todo"`, then `get_project_topology` with `depth:"all"`', snap), []);
  assert.equal(checkText('`get_project_topology` with `depth:"all"`, then `search_issues` with `depth:"all"`', snap).length, 1);
});

test("buildSnapshot keeps argument names and nested enums", () => {
  const s = buildSnapshot([
    { name: "b", inputSchema: { properties: { x: { anyOf: [{ enum: ["1"] }, { items: { enum: ["2"] } }] } }, required: ["x"] } },
    { name: "a", inputSchema: {} },
  ]);
  assert.deepEqual(Object.keys(s.tools), ["a", "b"]);
  assert.deepEqual(s.tools.b.properties.x.enum, ["1", "2"]);
});

test("refresh reads the live list through the shared client (initialize, initialized, tools/list) and writes the snapshot", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-"));
  scratch.push(dir);
  const file = path.join(dir, "snap.json");
  const methods = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    methods.push(b.method);
    const result = b.method === "tools/list" ? { tools: [{ name: "zeta_tool", inputSchema: { properties: { a: { enum: ["x"] } } } }] } : {};
    const text = b.method === "tools/list" ? `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: b.id, result })}\n\n` : JSON.stringify({ jsonrpc: "2.0", id: b.id, result });
    return { ok: true, status: 200, headers: new Map(), text: async () => text };
  };
  const n = await refresh({ fetchImpl, env: { SPRINTREE_TOKEN: "spt_fake_token_0000" }, file });
  assert.equal(n, 1);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tools.zeta_tool.properties.a.enum, ["x"]);
});

test("the checker runs when started through a symlink (it used to skip silently)", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-"));
  scratch.push(dir);
  const link = path.join(dir, "link-check-tools.mjs");
  symlinkSync(CHECK_TOOLS, link);
  const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tools consistent/);
});

test("the checker prints and exits 0 when run directly", () => {
  const r = spawnSync(process.execPath, [CHECK_TOOLS], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tools consistent/);
});
