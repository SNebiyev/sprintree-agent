import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAll, checkText, buildSnapshot, refresh, SNAPSHOT, DOCS, ALLOW } from "../scripts/check-tools.mjs";
import { ROOT, tmpDir, reply, mockFetch, childEnv } from "../test-support/helpers.mjs";

const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const CHECK_TOOLS = fileURLToPath(new URL("../scripts/check-tools.mjs", import.meta.url));

test("every doc that names tools or arguments is checked against the live snapshot", () => {
  assert.deepEqual(checkAll(snap), []);
  for (const f of ["skills/sprintree/SKILL.md", "README.md", "GEMINI.md"]) assert.ok(DOCS.includes(f), `${f} is not scanned`);
  assert.ok(DOCS.some((f) => /AGENTS\.md$/.test(f)), "the AGENTS.md template is not scanned");
});

test("the allow list only holds words a doc really uses in backticks and the live server does not know", () => {
  const docs = DOCS.map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  const known = new Set(Object.keys(snap.tools));
  for (const t of Object.values(snap.tools)) {
    for (const [p, d] of Object.entries(t.properties)) {
      known.add(p);
      (d.enum ?? []).forEach((v) => known.add(String(v)));
    }
  }
  for (const w of ALLOW) {
    assert.ok(docs.includes("`" + w + "`"), `${w} is allow-listed but no doc has it in backticks`);
    assert.ok(!known.has(w), `${w} is in the snapshot, so it does not need to be allow-listed`);
  }
});

test("snapshot carries the tools the skill depends on", () => {
  for (const t of ["search_issues", "update_issue_status", "move_issue", "check_criteria", "get_work_context"]) {
    assert.ok(snap.tools[t], `${t} missing from snapshot`);
  }
  assert.ok(snap.tools.update_issue_status.properties.expect, "expect argument");
  assert.ok(snap.tools.update_issue_status.properties.confirm_open_criteria, "confirm_open_criteria argument");
  assert.ok(snap.tools.search_issues.properties.category.enum.includes("todo"));
});

// [what is checked, text, how many problems, what the first one says]
const CASES = [
  ["unknown tool in backticks", "call `search_issuez` now", 1, /search_issuez/],
  ["unknown argument in a quoted JSON example", `call search_issues '{"project":"K","nope":1}'`, 1, /nope/],
  ["value outside the enum in a JSON example", `call search_issues '{"category":"doing"}'`, 1, /doing/],
  ["value outside the enum, backticked key:value", 'use `category:"doing"` here', 1, /doing/],
  ["valid example is clean", `call search_issues '{"category":["todo"],"blocked":false}'`, 0],
  ["misspelled argument, quoted JSON", `call update_issue_status '{"key":"K-1","status":"done","expectt":{"status":"review"}}'`, 1, /expectt/],
  ["misspelled argument, backticked JSON", 'Use `update_issue_status` with `{"key":"K-1","expectt":{"status":"review"}}`.', 1, /expectt/],
  ["misspelled argument, bare JSON", 'update_issue_status {"key":"K-1","expectt":{"status":"review"}}', 1, /expectt/],
  ["correct nested argument", `call update_issue_status '{"key":"K-1","status":"done","expect":{"status":"review"}}'`, 0],
  ["argument of ANOTHER tool, backticked", 'Page with `search_issues` and `children_cursor:"abc"`.', 1, /search_issues has no argument "children_cursor"/],
  ["argument of ANOTHER tool, JSON", `call search_issues '{"project":"K","children_cursor":"abc"}'`, 1, /children_cursor/],
  ["another tool's argument, topology", 'Use `get_project_topology` with `sort:"priority"`.', 1, /get_project_topology has no argument "sort"/],
  ["enum of the named tool: type has no done", `call search_issues '{"type":"done"}'`, 1, /type/],
  ["enum of the named tool: format yaml", '`search_issues` with `format:"yaml"`', 1, /yaml/],
  ["enum of the named tool: format json", '`search_issues` with `format:"json"`', 0],
  ["a later tool on the line owns the arguments after it", '`search_issues` with `category:"todo"`, then `get_project_topology` with `depth:"all"`', 0],
  ["the same argument on the wrong tool", '`get_project_topology` with `depth:"all"`, then `search_issues` with `depth:"all"`', 1, /search_issues has no argument "depth"/],
  ["unknown argument of a known tool, backticked key:value", 'Pull `search_issues` with `catgory:"todo"`.', 1, /search_issues has no argument "catgory"/],
  ["a valid backticked key:value", 'Pull `search_issues` with `category:"todo"`.', 0],
  ["prose key:value is not parsed", 'If `create_issue` fails, the message: "AC list is turned off" appears', 0],
  ["no tool on the line: key:value of a non-tool word is not checked", 'the `.sprintree.json` has `statuses:"x"` in prose', 0],
  ["st.mjs call names no tool", "node <skill-dir>/scripts/st.mjs call search_issuez '{}'", 1, /search_issuez/],
  ["st.mjs call with a quoted tool name", 'node st.mjs call "search_issuez" @a.json', 1, /search_issuez/],
  ["st.mjs call with a Windows path", "node $d\\scripts\\st.mjs call search_issuez @a.json", 1, /search_issuez/],
  ["st.mjs schema names no tool", "node <skill-dir>/scripts/st.mjs schema create_issuee", 1, /create_issuee/],
  ["st.mjs with a real tool or a placeholder", "node st.mjs schema create_issue\nnode st.mjs call <tool> '<json>'", 0],
  ["PowerShell-escaped JSON with a misspelled argument", String.raw`node st.mjs call search_issues '{\"project\":\"K\",\"catgory\":\"todo\"}'`, 1, /catgory/],
  ["PowerShell-escaped JSON that is right", String.raw`node st.mjs call search_issues '{\"project\":\"K\",\"category\":\"todo\"}'`, 0],
  ["a json fence with config keys only is a config example", '```json\n{ "project": "KEY", "statuses": { "done": "shipped" } }\n```', 0],
  ["a json fence with tool arguments is checked against the tool before it", 'Run `st.mjs call search_issues @args.json` with args.json:\n```json\n{"project":"K","catgory":"todo"}\n```', 1, /search_issues has no argument "catgory"/],
  ["a multi-line json fence with tool arguments", '```json\n{\n  "project": "K",\n  "catgory": "todo"\n}\n```', 1, /catgory/],
  ["a ~~~json config example is a fence too", '~~~json\n{"project":"KEY","statuses":{"done":"shipped"}}\n~~~', 0],
  ["a multi-line ~~~json fence is a fence too", '~~~json\n{\n  "project": "K",\n  "catgory": "todo"\n}\n~~~', 1, /catgory/],
  ["a ~~~ fence is not closed by backticks", '~~~json\n{"project":"K"}\n```\n{"catgory":"todo"}\n~~~', 1, /does not parse/],
  ["a longer fence is not closed by a shorter one, an inner json example is not a fence", 'Call search_issues:\n````markdown\n```json\n{"project":"K","query":"x"}\n```\nmore text\n````\nAfter.', 0],
  ["a fence closes with at least as many characters as it opened with", '````json\n{"project":"K"}\n`````\nThen call search_issues \'{"catgory":"todo"}\'', 1, /catgory/],
  ["a closing fence may be longer", '```json\n{"project":"KEY","language":"x"}\n`````\nDone.', 0],
  ["JSON on the line after its tool uses that tool", 'Query `search_issues` with\n`{"project":"K","nope":1}`', 1, /search_issues has no argument "nope"/],
  ["JSON on the line after its tool, right", 'Query `search_issues` with\n`{"project":"K","category":["todo"]}`', 0],
  ["a blank line ends the paragraph: any tool will do", 'Query `search_issues`.\n\n`{"project":"K","catgory":"todo"}`', 1, /no tool has no argument "catgory"/],
  ["a blank line ends the paragraph: the argument of another tool is fine", 'Query `search_issues`.\n\n`{"project":"K","category":["todo"],"depth":"all"}`', 0],
  ["no tool at all: the enum of some tool applies", '`{"category":"doing"}`', 1, /doing/],
  ["an unclosed json fence is an error", '```json\n{"project":"K"}\n\nLater: call search_issues \'{"catgory":"todo"}\'', 1, /never closed/],
  ["a json fence that does not parse", '```json\n{"project":\n```', 1, /does not parse/],
];

test("negative control table: each wrong tool, argument, enum value or fence is reported, each right one is not", () => {
  for (const [name, text, count, message] of CASES) {
    const problems = checkText(text, snap);
    assert.equal(problems.length, count, `${name}: ${JSON.stringify(problems)}`);
    if (count) assert.match(problems.join("\n"), message, name);
  }
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
  const file = path.join(tmpDir("ct-"), "snap.json");
  const fetchImpl = mockFetch((b) =>
    b.method === "tools/list"
      ? { sse: true, ...reply(b, { tools: [{ name: "zeta_tool", inputSchema: { properties: { a: { enum: ["x"] } } } }] }) }
      : b.method === "initialize" ? reply(b, {}) : { text: "" }
  );
  const n = await refresh({ fetchImpl, env: { SPRINTREE_TOKEN: "spt_fake_token_0000" }, file });
  assert.equal(n, 1);
  assert.deepEqual(fetchImpl.calls.map((c) => c.body.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tools.zeta_tool.properties.a.enum, ["x"]);
  await assert.rejects(refresh({ fetchImpl, env: {}, file }), /SPRINTREE_TOKEN/);
});

test("the checker prints and exits 0 when run directly", () => {
  const r = spawnSync(process.execPath, [CHECK_TOOLS], { encoding: "utf8", env: childEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tools consistent/);
});
