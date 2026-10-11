import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  run, resolveConfig, isMainModule, VERSION, ancestors, checkMcpUrl, MIN_NODE, KNOWN_CONFIG_KEYS, listTools, stripControls, findDocKey,
} from "../skills/sprintree/scripts/st.mjs";
import { tmpDir, reply, mockFetch, childEnv } from "../test-support/helpers.mjs";

const TOKEN = "spt_secret_value_123456";
const ST = fileURLToPath(new URL("../skills/sprintree/scripts/st.mjs", import.meta.url));
const PAT_PLACE = "Settings -> API & MCP -> Personal access tokens";
const win = process.platform === "win32";
// Control characters and invisible format characters that must never reach a terminal (ZWJ, ZWNJ, LRM and RLM are real text and stay).
const RAW_BAD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/u;

// ---- helpers ---------------------------------------------------------------------------------

/** Temp dir with a `.git` folder (so the config walk stops there) and the given files {relPath: string|Buffer}. */
function tmpRepo(files = {}) {
  const root = tmpDir("st-");
  mkdirSync(path.join(root, ".git"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const server = (extra = () => null, initResult = {}) => (body) => {
  if (body.method === "initialize") return reply(body, initResult);
  if (body.method === "notifications/initialized") return { text: "" };
  return extra(body) ?? { json: { jsonrpc: "2.0", id: body.id, error: { message: "unexpected " + body.method } } };
};

function harness(handler, { env = { SPRINTREE_TOKEN: TOKEN }, cwd = process.cwd(), session, init } = {}) {
  const lines = [];
  const errs = [];
  const fetch = mockFetch(server(handler, init), { session });
  return {
    lines,
    errs,
    fetch,
    go: (argv) => run(argv, { fetch, env, cwd, out: (s) => lines.push(s), err: (s) => errs.push(s) }),
  };
}

const toolsList = (tools) => (b) => (b.method === "tools/list" ? reply(b, { tools }) : null);
const callResult = (result) => (b) => (b.method === "tools/call" ? reply(b, result) : null);
const okCall = callResult({ content: [{ text: "done" }] });

// ---- basics ----------------------------------------------------------------------------------

test("tools lists names and argument names and sends Bearer", async () => {
  const h = harness(
    (b) =>
      b.method === "tools/list"
        ? { sse: true, ...reply(b, { tools: [{ name: "search_issues", inputSchema: { properties: { project: {}, query: {} } } }] }) }
        : null
  );
  assert.equal(await h.go(["tools"]), 0);
  assert.deepEqual(h.lines, ["search_issues(project, query)"]);
  assert.equal(h.fetch.calls.at(-1).headers.Authorization, `Bearer ${TOKEN}`);
});

test("the handshake is initialize, then notifications/initialized, then the request", async () => {
  const h = harness(toolsList([]));
  assert.equal(await h.go(["tools"]), 0);
  assert.deepEqual(
    h.fetch.calls.map((c) => c.body.method),
    ["initialize", "notifications/initialized", "tools/list"]
  );
  assert.equal(h.fetch.calls[1].body.id, undefined, "a notification carries no id");
});

test("the live server is stateless: no session header is sent unless the server issued one", async () => {
  const h = harness(toolsList([]));
  await h.go(["tools"]);
  assert.ok(h.fetch.calls.every((c) => !("Mcp-Session-Id" in c.headers)));
});

test("a session id issued by the server is echoed on later requests", async () => {
  const h = harness(toolsList([]), { session: true });
  await h.go(["tools"]);
  assert.ok(!("Mcp-Session-Id" in h.fetch.calls[0].headers));
  assert.equal(h.fetch.calls.at(-1).headers["Mcp-Session-Id"], "sess-1");
});

test("MCP-Protocol-Version: the negotiated version is sent on every request after initialize", async () => {
  const h = harness(toolsList([]), { init: { protocolVersion: "2025-03-26" } });
  await h.go(["tools"]);
  const [init, ...rest] = h.fetch.calls;
  assert.ok(!("MCP-Protocol-Version" in init.headers), "not on initialize itself");
  assert.equal(rest.length, 2);
  for (const c of rest) assert.equal(c.headers["MCP-Protocol-Version"], "2025-03-26");
});

test("MCP-Protocol-Version falls back to the version we asked for", async () => {
  const h = harness(toolsList([]));
  await h.go(["tools"]);
  assert.equal(h.fetch.calls.at(-1).headers["MCP-Protocol-Version"], h.fetch.calls[0].body.params.protocolVersion);
});

test("token that already starts with Bearer is not doubled", async () => {
  const h = harness(toolsList([]), { env: { SPRINTREE_TOKEN: `Bearer ${TOKEN}` } });
  await h.go(["tools"]);
  assert.equal(h.fetch.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test("schema prints description and JSON schema, unknown tool exits 1", async () => {
  const handler = toolsList([{ name: "add_comment", description: "Comment on an issue", inputSchema: { type: "object" } }]);
  const ok = harness(handler);
  assert.equal(await ok.go(["schema", "add_comment"]), 0);
  assert.equal(ok.lines[0], "Comment on an issue");
  const bad = harness(handler);
  assert.equal(await bad.go(["schema", "nope"]), 1);
  assert.match(bad.errs[0], /no such tool/);
});

test("a tools answer whose `tools` is not an array exits 1", async () => {
  for (const result of [{ tools: "nope" }, {}, { tools: { a: 1 } }]) {
    const h = harness((b) => (b.method === "tools/list" ? reply(b, result) : null));
    assert.equal(await h.go(["tools"]), 1, JSON.stringify(result));
    assert.match(h.errs[0], /tools/);
  }
});

test("call passes parsed arguments and prints text", async () => {
  const h = harness(callResult({ content: [{ type: "text", text: "ok SPD-1" }] }));
  assert.equal(await h.go(["call", "get_issue_details", '{"key":"SPD-1"}']), 0);
  assert.deepEqual(h.lines, ["ok SPD-1"]);
  assert.deepEqual(h.fetch.calls.at(-1).body.params, { name: "get_issue_details", arguments: { key: "SPD-1" } });
});

test('call exits 1 when ANY content item starts with "Error:" or isError is set', async () => {
  const cases = [
    { content: [{ text: "Error: A task can only be placed under a story" }] },
    { content: [{ text: "fine so far" }, { text: "Error: the second part failed" }] },
    { content: [{ text: "a" }, { text: "b" }, { text: "  Error: third" }] },
    { isError: true, content: [{ text: "boom" }] },
  ];
  for (const result of cases) {
    const h = harness(callResult(result));
    assert.equal(await h.go(["call", "create_issue", "{}"]), 1, JSON.stringify(result));
  }
  const fine = harness(callResult({ content: [{ text: "ok" }, { text: "an Error: in the middle of a line is fine" }] }));
  assert.equal(await fine.go(["call", "x", "{}"]), 0);
});

test("call reads arguments from @file relative to cwd", async () => {
  const dir = tmpRepo({ "args.json": '{"key":"SPD-2","body":"# long\\nmarkdown"}' });
  const h = harness(okCall, { cwd: dir });
  assert.equal(await h.go(["call", "add_comment", "@args.json"]), 0);
  assert.equal(h.fetch.calls.at(-1).body.params.arguments.body, "# long\nmarkdown");
});

test("`-` is not a stdin mode: only inline JSON and @file are arguments", async () => {
  const h = harness(okCall);
  assert.equal(await h.go(["call", "add_comment", "-"]), 1);
  assert.match(h.errs[0], /not valid JSON/);
  assert.equal(h.fetch.calls.length, 0);
});

test("call reads arguments from @<absolute path> too", async () => {
  const dir = tmpRepo({ "args.json": '{"key":"SPD-3","body":"çox \\"quoted\\""}' });
  const h = harness(okCall);
  assert.equal(await h.go(["call", "add_comment", `@${path.join(dir, "args.json")}`]), 0);
  assert.deepEqual(h.fetch.calls.at(-1).body.params.arguments, { key: "SPD-3", body: 'çox "quoted"' });
});

test("invalid JSON arguments exit 1", async () => {
  const h = harness(() => null);
  assert.equal(await h.go(["call", "x", "{nope"]), 1);
  assert.match(h.errs[0], /not valid JSON/);
});

test("unknown command exits 1 with usage", async () => {
  const h = harness(() => null);
  assert.equal(await h.go(["bogus"]), 1);
  assert.match(h.errs[0], /usage/);
});

test("version prints VERSION, which is also sent as clientInfo", async () => {
  const h = harness(toolsList([]));
  await h.go(["tools"]);
  assert.equal(h.fetch.calls[0].body.params.clientInfo.version, VERSION);
  const v = harness(() => null, { env: {} });
  assert.equal(await v.go(["version"]), 0);
  assert.deepEqual(v.lines, [VERSION]);
});

// ---- encodings: BOM and UTF-16 ---------------------------------------------------------------

const BOM8 = Buffer.from([0xef, 0xbb, 0xbf]);
const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const utf16be = (s) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, "utf16le").swap16()]);

test("@file: UTF-8 BOM is stripped, UTF-16LE is decoded, UTF-16BE is a clear error", async () => {
  const json = '{"key":"SPD-9","body":"çay ə"}';
  const dir = tmpRepo({
    "bom.json": Buffer.concat([BOM8, Buffer.from(json)]),
    "le.json": utf16le(json),
    "be.json": utf16be(json),
  });
  for (const f of ["bom.json", "le.json"]) {
    const h = harness(okCall, { cwd: dir });
    assert.equal(await h.go(["call", "add_comment", `@${f}`]), 0, f);
    assert.deepEqual(h.fetch.calls.at(-1).body.params.arguments, { key: "SPD-9", body: "çay ə" }, f);
  }
  const be = harness(okCall, { cwd: dir });
  assert.equal(await be.go(["call", "add_comment", "@be.json"]), 1);
  assert.match(be.errs[0], /UTF-16BE/);
  assert.equal(be.fetch.calls.length, 0);
});

test(".sprintree.json: UTF-8 BOM is stripped, UTF-16LE is decoded, UTF-16BE is a clear error", async () => {
  const json = JSON.stringify({ project: "SPD", language: "Azərbaycan" });
  const bom = tmpRepo({ ".sprintree.json": Buffer.concat([BOM8, Buffer.from(json)]) });
  assert.equal(resolveConfig(bom).project, "SPD");
  const le = tmpRepo({ ".sprintree.json": utf16le(json) });
  assert.equal(resolveConfig(le).language, "Azərbaycan");
  const be = tmpRepo({ ".sprintree.json": utf16be(json) });
  assert.throws(() => resolveConfig(be), /UTF-16BE/);
});

// ---- config: key, config, validation, secrets ------------------------------------------------

test("key: AGENTS.md link, walk up from a subdirectory, lower-case normalised", async () => {
  const root = tmpRepo({ "AGENTS.md": "Board: https://sprintree.com/p/spd/board\n", "a/b/.keep": "" });
  const h = harness(() => null, { env: {}, cwd: path.join(root, "a", "b") });
  assert.equal(await h.go(["key"]), 0);
  assert.deepEqual(h.lines, ["SPD"]);
});

test("key: .claude/CLAUDE.md is read too", async () => {
  const root = tmpRepo({ ".claude/CLAUDE.md": "https://sprintree.com/p/ABC" });
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["key"]), 0);
  assert.deepEqual(h.lines, ["ABC"]);
});

test(".sprintree.json wins and carries language/status mapping", () => {
  const root = tmpRepo({
    "AGENTS.md": "sprintree.com/p/OLD",
    ".sprintree.json": JSON.stringify({ project: "NEW", language: "de", statuses: { review: "in_review" } }),
  });
  const cfg = resolveConfig(root);
  assert.equal(cfg.project, "NEW");
  assert.equal(cfg.language, "de");
  assert.equal(cfg.statuses.review, "in_review");
});

test("key without any link exits 1", async () => {
  const root = tmpRepo();
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["key"]), 1);
  assert.match(h.errs[0], /No project key/);
});

test("key and config work without a global fetch and on an old Node", async () => {
  const root = tmpRepo({ ".sprintree.json": '{"project":"SPD"}' });
  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    for (const cmd of ["key", "config"]) {
      const lines = [];
      const errs = [];
      const code = await run([cmd], { env: {}, cwd: root, nodeVersion: "16.20.2", out: (s) => lines.push(s), err: (s) => errs.push(s) });
      assert.equal(code, 0, `${cmd}: ${errs.join("|")}`);
      assert.match(lines.join("\n"), /SPD/);
    }
  } finally {
    globalThis.fetch = saved;
  }
});

test("project key from .sprintree.json must match the server key rule", async () => {
  for (const bad of ["../../x", "TOO-LONG", "ABCDEFGHIJK", "1AB", "A B", "", "SPD\n", 5]) {
    const root = tmpRepo({ ".sprintree.json": JSON.stringify({ project: bad }) });
    const h = harness(() => null, { env: {}, cwd: root });
    assert.equal(await h.go(["key"]), 1, JSON.stringify(bad));
    assert.match(h.errs[0], /project key/, JSON.stringify(bad));
  }
  const ok = tmpRepo({ ".sprintree.json": '{"project":"Spd9"}' });
  const h = harness(() => null, { env: {}, cwd: ok });
  assert.equal(await h.go(["key"]), 0);
});

test("the placeholder KEY (from the template link or .sprintree.json) is rejected with a hint to replace it", async () => {
  const fromJson = tmpRepo({ ".sprintree.json": '{"project":"KEY"}' });
  const fromLink = tmpRepo({ "AGENTS.md": "Project board: https://sprintree.com/p/KEY   <!-- replace -->" });
  for (const cwd of [fromJson, fromLink]) {
    const h = harness(() => null, { env: {}, cwd });
    assert.equal(await h.go(["key"]), 1);
    assert.match(h.errs[0], /placeholder/);
    assert.match(h.errs[0], /replace/i);
    assert.deepEqual(h.lines, []);
  }
});

test(".sprintree.json that is a symlink to a regular file inside the repo is accepted", { skip: win }, async () => {
  const root = tmpRepo({ "conf/real.json": '{"project":"INSIDE"}' });
  symlinkSync(path.join(root, "conf", "real.json"), path.join(root, ".sprintree.json"));
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["key"]), 0);
  assert.deepEqual(h.lines, ["INSIDE"]);
});

test(".sprintree.json that leads outside the repo or to a non-regular file is refused, a dangling link counts as missing", { skip: win }, async () => {
  const outside = tmpRepo({ "secret.json": '{"project":"EVIL"}' });
  const root = tmpRepo();
  symlinkSync(path.join(outside, "secret.json"), path.join(root, ".sprintree.json"));
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["key"]), 1);
  assert.match(h.errs[0], /outside the repo/);
  assert.ok(!/replace|put a regular file/i.test(h.errs[0]), "the message never tells the agent to replace the link");
  assert.ok(!h.lines.join("").includes("EVIL"));
  const dir = tmpRepo({ "sub/x": "" });
  symlinkSync(path.join(dir, "sub"), path.join(dir, ".sprintree.json"));
  const d = harness(() => null, { env: {}, cwd: dir });
  assert.equal(await d.go(["config"]), 1);
  assert.match(d.errs[0], /not a regular file/);
  const dangling = tmpRepo();
  symlinkSync(path.join(outside, "nope.json"), path.join(dangling, ".sprintree.json"));
  const g = harness(() => null, { env: {}, cwd: dangling });
  assert.equal(await g.go(["key"]), 1);
  assert.match(g.errs[0], /No project key/);
});

test(".sprintree.json whose real path is outside the directory it was found in is refused", () => {
  const fs = fakeFs({ "/repo/.git": null, "/repo/.sprintree.json": '{"project":"SPD"}', "/etc/other.json": '{"project":"EVIL"}' }, { real: { "/repo/.sprintree.json": "/etc/other.json" } });
  assert.throws(() => resolveConfig("/repo", { fs }), /outside/);
  const inside = fakeFs({ "/repo/.git": null, "/repo/.sprintree.json": '{"project":"SPD"}' });
  assert.equal(resolveConfig("/repo", { fs: inside }).project, "SPD");
});

test("config prints only the known keys; unknown keys are named on stderr, never their values", async () => {
  const root = tmpRepo({
    ".sprintree.json": JSON.stringify({
      project: "SPD",
      language: "English",
      typography: "plain",
      statuses: { done: "shipped" },
      section_titles: { context: "Context" },
      apiKey: "VALUE-ONE-SECRET",
      nested: { deep: "VALUE-TWO-SECRET" },
    }),
  });
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["config"]), 0);
  const printed = JSON.parse(h.lines.join("\n"));
  assert.deepEqual(Object.keys(printed).sort(), [...KNOWN_CONFIG_KEYS].sort());
  const all = [...h.lines, ...h.errs].join("\n");
  assert.ok(!all.includes("VALUE-ONE-SECRET") && !all.includes("VALUE-TWO-SECRET"), "value leaked");
  assert.match(h.errs.join("\n"), /ignored.*apiKey.*nested|ignored.*nested.*apiKey/s);
});

test("a .sprintree.json that is not JSON fails without echoing its content", async () => {
  const root = tmpRepo({ ".sprintree.json": "ROOT_PASSWORD=hunter2-topsecret\nnot json" });
  for (const cmd of ["key", "config"]) {
    const h = harness(() => null, { env: {}, cwd: root });
    assert.equal(await h.go([cmd]), 1);
    const all = [...h.lines, ...h.errs].join("\n");
    assert.match(all, /not valid JSON/);
    assert.ok(!all.includes("hunter2") && !all.includes("ROOT_PASSWORD"), "content echoed");
  }
  const arr = tmpRepo({ ".sprintree.json": '["a"]' });
  const h = harness(() => null, { env: {}, cwd: arr });
  assert.equal(await h.go(["key"]), 1);
  assert.match(h.errs[0], /JSON object/);
});

test(".sprintree.json with a token-like key or itn_ value warns on stderr without echoing the value", () => {
  const root = tmpRepo({
    ".sprintree.json": JSON.stringify({ project: "SPD", token: "abc123secretvalue", nested: { pat: "x" }, note: "itn_deadbeefcafe0000", path: "/ok" }),
  });
  const warns = [];
  const cfg = resolveConfig(root, { warn: (s) => warns.push(s) });
  assert.equal(cfg.project, "SPD");
  const all = warns.join("\n");
  assert.match(all, /token/);
  assert.match(all, /nested\.pat/);
  assert.match(all, /note/);
  assert.ok(!all.includes("abc123secretvalue") && !all.includes("itn_deadbeef"));
});

test("`key` command surfaces the token warning on stderr", async () => {
  const root = tmpRepo({ ".sprintree.json": JSON.stringify({ project: "SPD", secret: "s3" }) });
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["key"]), 0);
  assert.deepEqual(h.lines, ["SPD"]);
  assert.match(h.errs.join("\n"), /Warning:.*secret/);
});

// ---- tokens, errors, redaction ---------------------------------------------------------------

test("missing token exits 1 with a hint and does not call the network", async () => {
  const h = harness(() => null, { env: {} });
  assert.equal(await h.go(["tools"]), 1);
  assert.match(h.errs[0], /SPRINTREE_TOKEN/);
  assert.equal(h.fetch.calls.length, 0);
});

test("401 and 403 print the server's own message (token scrubbed, capped) plus the hint", async () => {
  const on = (method, status, text) => harness((b) => (b.method === method ? { status, text } : null));
  const a = on("tools/list", 401, `Token revoked by admin ${TOKEN}`);
  assert.equal(await a.go(["tools"]), 1);
  const e401 = a.errs.join("\n");
  assert.match(e401, /HTTP 401/);
  assert.match(e401, /invalid, expired or revoked token/);
  assert.match(e401, /Token revoked by admin \[token\]/);
  assert.ok(!e401.includes(TOKEN));
  const b = on("tools/call", 403, `Scope read-only; write needed ${TOKEN}`);
  assert.equal(await b.go(["call", "add_comment", "{}"]), 1);
  const e403 = b.errs.join("\n");
  assert.match(e403, /the token cannot do this \(read-only token on a write tool\?\)/);
  assert.match(e403, /Scope read-only; write needed \[token\]/);
  assert.ok(!e403.includes(TOKEN));
  const big = on("tools/list", 401, "x".repeat(5000));
  await big.go(["tools"]);
  assert.ok(big.errs.join("\n").length < 800, "server text is capped");
});

test("one PAT hint is used by the no-token, 401 and 403 messages", async () => {
  const none = harness(() => null, { env: {} });
  await none.go(["tools"]);
  const a = harness((b) => (b.method === "tools/list" ? { status: 401, text: "x" } : null));
  await a.go(["tools"]);
  const c = harness((b) => (b.method === "tools/call" ? { status: 403, text: "x" } : null));
  await c.go(["call", "x", "{}"]);
  for (const h of [none, a, c]) assert.ok(h.errs.join("\n").includes(PAT_PLACE), h.errs.join("\n"));
});

test("redaction: the token never reaches the output, whichever way the server echoes it", async () => {
  const cases = {
    "HTTP 500 body": (b) => (b.method === "tools/call" ? { status: 500, text: `internal error for ${TOKEN}` } : null),
    "JSON-RPC error": (b) => (b.method === "tools/call" ? { json: { jsonrpc: "2.0", id: b.id, error: { code: -32000, message: `bad ${TOKEN}` } } } : null),
    "tool text": callResult({ content: [{ text: `echo ${TOKEN}` }] }),
    "tool text split by an escape sequence": callResult({ content: [{ text: `echo ${TOKEN.slice(0, 8)}\u001b[0m${TOKEN.slice(8)}` }] }),
    "bare token in env": callResult({ content: [{ text: `Bearer ${TOKEN}` }] }),
  };
  for (const [name, handler] of Object.entries(cases)) {
    const h = harness(handler);
    await h.go(["call", "x", "{}"]);
    const all = [...h.errs, ...h.lines].join("\n");
    assert.ok(!all.includes(TOKEN), `${name}: token leaked: ${all}`);
    assert.ok(all.length > 0, name);
  }
});

test("terminal control sequences in server text are removed (OSC 52 clipboard, CSI clear screen, C1, C0)", async () => {
  const evil = "a\u001b]52;c;SGVsbG8=\u0007b\u001b[2J\u001b[Hc\u001b]0;title\u001b\\d\u009bxe\u0000f\rg\u0008h\tI\nJ";
  const h = harness(callResult({ content: [{ text: evil }] }));
  assert.equal(await h.go(["call", "x", "{}"]), 0);
  assert.ok(!RAW_BAD.test(h.lines[0]), "control characters left");
  assert.ok(!h.lines[0].includes("\u001b"));
  assert.ok(h.lines[0].endsWith("\tI\nJ"));
});

test("an unterminated OSC/DCS/APC/PM/SOS keeps the text after it visible, in the same item and in the next ones, and the refusal still exits 1", async () => {
  for (const intro of ["]", "P", "X", "^", "_"]) {
    const h = harness(callResult({ content: [{ text: `ITR-1 attacker \u001b${intro}` }, { text: "ITR-2 legit card" }, { text: "ITR-3 DO NOT MERGE" }, { text: "Error: the write was refused" }] }));
    assert.equal(await h.go(["call", "x", "{}"]), 1, intro);
    assert.ok(!h.lines[0].includes("\u001b"), intro);
    for (const word of ["ITR-1 attacker", "ITR-2 legit card", "ITR-3 DO NOT MERGE", "Error: the write was refused"]) assert.ok(h.lines[0].includes(word), `${intro}: ${word} hidden in ${JSON.stringify(h.lines[0])}`);
  }
  const same = harness(callResult({ content: [{ text: "ITR-1 x \u001b]0;t ITR-2 legit \u001bP ITR-3 legit" }] }));
  await same.go(["call", "x", "{}"]);
  assert.ok(same.lines[0].includes("ITR-2 legit") && same.lines[0].includes("ITR-3 legit"), same.lines[0]);
  const c1 = harness(callResult({ content: [{ text: "ITR-1 x \u009d0;t\u009c ITR-2 legit" }] }));
  await c1.go(["call", "x", "{}"]);
  assert.ok(c1.lines[0].includes("ITR-2 legit"), c1.lines[0]);
});

test("control sequences are removed from tool names, schemas and error messages too", async () => {
  const tools = [{ name: "evil\u001b]52;c;AAAA\u0007_tool", description: "d\u001b[2Jesc", inputSchema: { properties: { "p\u001b[H": {} } } }];
  const l = harness(toolsList(tools));
  await l.go(["tools"]);
  const s = harness(toolsList(tools));
  await s.go(["schema", "evil52;c;AAAA_tool"]);
  const e = harness((b) => (b.method === "tools/call" ? { status: 500, text: "boom\u001b]52;c;AAAA\u0007!" } : null));
  await e.go(["call", "x", "{}"]);
  for (const out of [...l.lines, ...s.lines, ...e.errs]) assert.ok(!/[\u001b\u0007]/.test(out), JSON.stringify(out));
  assert.deepEqual(l.lines, ["evil52;c;AAAA_tool(p)"]);
  assert.equal(s.errs.length, 0);
});

// ---- network: redirects, errors, timeouts ----------------------------------------------------

test("requests are sent with redirect: error", async () => {
  const h = harness(toolsList([]));
  await h.go(["tools"]);
  assert.ok(h.fetch.calls.every((c) => c.init.redirect === "error"));
});

test("a redirect is a clear error that points at SPRINTREE_MCP_URL", async () => {
  const fetch = async () => {
    throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
  };
  const errs = [];
  const code = await run(["tools"], { fetch, env: { SPRINTREE_TOKEN: TOKEN }, out: () => {}, err: (s) => errs.push(s) });
  assert.equal(code, 1);
  assert.match(errs[0], /server redirected; set SPRINTREE_MCP_URL to the final URL/);
});

test("real fetch against a local server that redirects: clear error, the redirect target is never followed", async () => {
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    res.writeHead(302, { Location: "http://127.0.0.1:9/elsewhere" });
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const errs = [];
    const code = await run(["tools"], {
      env: { SPRINTREE_TOKEN: TOKEN, SPRINTREE_MCP_URL: `http://127.0.0.1:${srv.address().port}/mcp` },
      out: () => {},
      err: (s) => errs.push(s),
    });
    assert.equal(code, 1);
    assert.match(errs.at(-1), /server redirected/);
    assert.equal(hits, 1);
  } finally {
    srv.close();
  }
});

test("network errors print the cause code and host only, no path, query, userinfo or token", async () => {
  const fetch = async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ECONNREFUSED 10.0.0.1:8443 ${TOKEN}`), { code: "ECONNREFUSED" }) });
  };
  const errs = [];
  const code = await run(["tools"], {
    fetch,
    env: { SPRINTREE_TOKEN: TOKEN, SPRINTREE_MCP_URL: "https://example.test:8443/mcp/private?x=1" },
    out: () => {},
    err: (s) => errs.push(s),
  });
  assert.equal(code, 1);
  assert.equal(errs.at(-1), "Error: fetch failed: ECONNREFUSED example.test:8443");
});

test("a thrown non-Error is reported through the one catch, scrubbed", async () => {
  const errs = [];
  const code = await run(["tools"], { fetch: async () => { throw `weird ${TOKEN}`; }, env: { SPRINTREE_TOKEN: TOKEN }, out: () => {}, err: (s) => errs.push(s) });
  assert.equal(code, 1);
  assert.ok(errs[0].startsWith("Error: ") && !errs[0].includes(TOKEN));
});

test("request timeout: SPRINTREE_TIMEOUT_MS aborts a hung request with a clear message", async () => {
  // AbortSignal.timeout timers are unref'd on Node < 24; a real socket keeps the loop alive, so the mock does too.
  const fetch = (url, init) =>
    new Promise((_, reject) => {
      const keep = setInterval(() => {}, 1000);
      init.signal.addEventListener("abort", () => {
        clearInterval(keep);
        reject(init.signal.reason);
      });
    });
  const errs = [];
  const t0 = Date.now();
  const code = await run(["tools"], { fetch, env: { SPRINTREE_TOKEN: TOKEN, SPRINTREE_TIMEOUT_MS: "80" }, out: () => {}, err: (s) => errs.push(s) });
  assert.equal(code, 1);
  assert.ok(Date.now() - t0 < 5000);
  assert.match(errs[0], /timed out after 80 ms/);
  assert.match(errs[0], /SPRINTREE_TIMEOUT_MS/);
});

/** Runs `tools` while recording every AbortSignal.timeout(ms) the client asks for. */
async function timeoutsAsked(envExtra) {
  const asked = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => (asked.push(ms), real.call(AbortSignal, ms));
  const h = harness(toolsList([]), { env: { SPRINTREE_TOKEN: TOKEN, ...envExtra } });
  try {
    const code = await h.go(["tools"]);
    return { code, asked, h };
  } finally {
    AbortSignal.timeout = real;
  }
}

test("SPRINTREE_TIMEOUT_MS: default is 30000 ms, applied to every request", async () => {
  const { code, asked } = await timeoutsAsked({});
  assert.equal(code, 0);
  assert.deepEqual(asked, [30000, 30000, 30000]);
});

test("SPRINTREE_TIMEOUT_MS: an integer 1..600000 is used as is", async () => {
  for (const v of ["1", "5000", "600000"]) {
    const { code, asked } = await timeoutsAsked({ SPRINTREE_TIMEOUT_MS: v });
    assert.equal(code, 0, v);
    assert.deepEqual(asked, [Number(v), Number(v), Number(v)], v);
  }
});

test("SPRINTREE_TIMEOUT_MS: anything else exits 1 before any request", async () => {
  for (const v of ["0.5", "0", "-1", "3000000000", "600001", "abc", "1e3", " 80", ""]) {
    const { code, h, asked } = await timeoutsAsked({ SPRINTREE_TIMEOUT_MS: v });
    assert.equal(code, 1, JSON.stringify(v));
    assert.match(h.errs[0], /SPRINTREE_TIMEOUT_MS/, JSON.stringify(v));
    assert.equal(h.fetch.calls.length, 0, JSON.stringify(v));
    assert.deepEqual(asked, [], JSON.stringify(v));
  }
});

// ---- SSE -------------------------------------------------------------------------------------

test("SSE: picks the message whose id matches, skipping notifications and other ids", async () => {
  const h = harness((b) => {
    if (b.method !== "tools/call") return null;
    const frames = [
      { jsonrpc: "2.0", method: "notifications/progress", params: { n: 1 } },
      { jsonrpc: "2.0", id: 9999, result: { content: [{ text: "WRONG" }] } },
      { jsonrpc: "2.0", id: b.id, result: { content: [{ text: "RIGHT" }] } },
      { jsonrpc: "2.0", method: "notifications/message", params: {} },
    ];
    return { text: frames.map((f) => `event: message\ndata: ${JSON.stringify(f)}\n\n`).join("") };
  });
  assert.equal(await h.go(["call", "x", "{}"]), 0);
  assert.deepEqual(h.lines, ["RIGHT"]);
});

test("SSE: multi-line data frames are joined with newlines before parsing", async () => {
  const h = harness((b) => {
    if (b.method !== "tools/call") return null;
    const pretty = JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { content: [{ text: "multi" }] } }, null, 2);
    return { text: "event: message\r\n" + pretty.split("\n").map((l) => `data: ${l}`).join("\r\n") + "\r\n\r\n" };
  });
  assert.equal(await h.go(["call", "x", "{}"]), 0);
  assert.deepEqual(h.lines, ["multi"]);
});

test("SSE: no message with the request id is a clear error", async () => {
  const h = harness((b) =>
    b.method === "tools/call" ? { text: `data: ${JSON.stringify({ jsonrpc: "2.0", id: 12345, result: {} })}\n\n` } : null
  );
  assert.equal(await h.go(["call", "x", "{}"]), 1);
  assert.match(h.errs[0], /no answer with id/);
});

// ---- endpoint and runtime guards -------------------------------------------------------------

test("non-https SPRINTREE_MCP_URL is refused unless localhost, before any request", async () => {
  for (const url of ["http://sprintree.example/mcp", "ftp://x/mcp", "not a url"]) {
    const h = harness(() => null, { env: { SPRINTREE_TOKEN: TOKEN, SPRINTREE_MCP_URL: url } });
    assert.equal(await h.go(["tools"]), 1, url);
    assert.equal(h.fetch.calls.length, 0, url);
    assert.match(h.errs[0], /SPRINTREE_MCP_URL/);
    assert.ok(!h.errs.join("").includes(TOKEN));
  }
  for (const url of ["http://localhost:3000/mcp", "http://127.0.0.1/mcp", "http://[::1]:8080/mcp", "https://sprintree.com/mcp"]) {
    assert.doesNotThrow(() => checkMcpUrl(url), url);
  }
});

// ---- running as a script ---------------------------------------------------------------------

test("isMainModule: false without argv[1] and for a path that does not exist", () => {
  assert.equal(isMainModule(undefined, import.meta.url), false);
  assert.equal(isMainModule(path.join(tmpdir(), "does-not-exist-st.mjs"), import.meta.url), false);
  assert.equal(isMainModule(fileURLToPath(import.meta.url), import.meta.url), true);
});

test("running the script directly executes main (all platforms)", () => {
  const r = spawnSync(process.execPath, [ST, "version"], { env: childEnv(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), VERSION);
});

test("isMainModule: a symlink to the script counts as the script (unit test, no process spawned)", { skip: process.platform === "win32" }, () => {
  const link = path.join(tmpRepo(), "st-link.mjs");
  symlinkSync(ST, link);
  assert.equal(isMainModule(link, pathToFileURL(ST).href), true);
  assert.equal(isMainModule(link, import.meta.url), false);
});

// ---- path.win32: parent-directory walk and key lookup on Windows-style paths, runnable on any OS

/**
 * A stand-in file system: files is {path: string | null (a directory)}. `real` maps a path to the real path it resolves to,
 * (a list: one entry per resolution), `uid` is the owner of every file, `ino` overrides the inode a path reports through statSync (not through fstatSync),
 * `calls` collects the flags of every openSync.
 */
function fakeFs(files, { real = {}, uid = process.getuid?.(), ino = {}, notFileOnFstat = false, calls = [] } = {}) {
  const seen = new Map();
  const norm = (p) => p.toLowerCase();
  const set = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const keys = [...set.keys()];
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const stat = (p, viaFd) => {
    if (!set.has(norm(p))) throw missing();
    const v = set.get(norm(p));
    const file = typeof v === "string" && !(viaFd && notFileOnFstat);
    return { isFile: () => file, size: typeof v === "string" ? Buffer.byteLength(v) : 0, nlink: 1, uid, dev: 1, ino: (!viaFd && ino[p]) || keys.indexOf(norm(p)) + 1 };
  };
  const fds = [];
  return {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x800 },
    existsSync: (p) => set.has(norm(p)),
    realpathSync: (p) => {
      // `real[p]` may be a list: the first resolution gives the first entry, the next one the second (a directory swapped in between)
      const n = seen.get(p) ?? 0;
      seen.set(p, n + 1);
      if (real[p]) return [].concat(real[p])[Math.min(n, [].concat(real[p]).length - 1)];
      if (set.has(norm(p)) || keys.some((k) => k.startsWith(norm(p)))) return p;
      throw missing();
    },
    statSync: (p) => stat(p, false),
    openSync: (p, flags) => (calls.push(flags), stat(p), fds.push(p) - 1),
    fstatSync: (fd) => stat(fds[fd], true),
    readFileSync: (fd) => Buffer.from(set.get(norm(fds[fd]))),
    closeSync: () => {},
  };
}

test("win32: ancestors walk up to the repo root and stop there", () => {
  const w = path.win32;
  const fs = fakeFs({ "C:\\repo\\.git": null });
  assert.deepEqual([...ancestors("C:\\repo\\a\\b", { path: w, fs })], ["C:\\repo\\a\\b", "C:\\repo\\a", "C:\\repo"]);
});

test("without a .git above the directory, only that directory is looked at (no climb to the drive or filesystem root)", () => {
  assert.deepEqual([...ancestors("D:\\x\\y", { path: path.win32, fs: fakeFs({}) })], ["D:\\x\\y"]);
  const shared = tmpRepo();
  writeFileSync(path.join(shared, ".sprintree.json"), '{"project":"PLANTED"}');
  const work = path.join(shared, "victim", "work");
  mkdirSync(work, { recursive: true });
  rmSyncGit(shared);
  assert.equal(resolveConfig(work).project, undefined);
  writeFileSync(path.join(work, ".sprintree.json"), '{"project":"OWN"}');
  assert.equal(resolveConfig(work).project, "OWN");
});

test("the search for .git stops at the home directory", () => {
  const w = path.win32;
  const fs = fakeFs({ "C:\\.git": null, "C:\\Users\\me\\proj\\AGENTS.md": "https://sprintree.com/p/NO" });
  assert.deepEqual([...ancestors("C:\\Users\\me\\proj", { path: w, fs, home: "C:\\Users\\me" })], ["C:\\Users\\me\\proj"]);
  const dotfiles = fakeFs({ "C:\\Users\\me\\.git": null });
  assert.deepEqual([...ancestors("C:\\Users\\me\\proj", { path: w, fs: dotfiles, home: "C:\\Users\\me" })], ["C:\\Users\\me\\proj", "C:\\Users\\me"]);
});

test("win32: key lookup from a nested dir finds AGENTS.md and .sprintree.json", () => {
  const w = path.win32;
  const fs = fakeFs({ "C:\\repo\\.git": null, "C:\\repo\\AGENTS.md": "Board https://sprintree.com/p/spd/board" });
  assert.equal(resolveConfig("C:\\repo\\src\\deep", { path: w, fs }).project, "SPD");
  const fs2 = fakeFs({
    "C:\\repo\\.git": null,
    "C:\\repo\\AGENTS.md": "sprintree.com/p/OLD",
    "C:\\repo\\src\\.sprintree.json": '{"project":"NEW"}',
  });
  const cfg = resolveConfig("C:\\repo\\src\\deep", { path: w, fs: fs2 });
  assert.equal(cfg.project, "NEW");
  assert.equal(cfg._source, "C:\\repo\\src\\.sprintree.json");
});

/** Deletes the `.git` folder of a tmpRepo, so the directory is no repo. */
function rmSyncGit(dir) {
  rmSync(path.join(dir, ".git"), { recursive: true, force: true });
}

// ---- the safe reader -------------------------------------------------------------------------

test("the reader opens the real path with O_NOFOLLOW and O_NONBLOCK and refuses a descriptor that is another file than the path", () => {
  const files = { "/repo/.git": null, "/repo/AGENTS.md": "https://sprintree.com/p/ABC" };
  const calls = [];
  assert.equal(findDocKey("/repo", { fs: fakeFs(files, { calls }) }).key, "ABC");
  assert.ok(calls.length > 0 && calls.every((f) => (f & 0x100) && (f & 0x800)), `open flags: ${calls}`);
  const warns = [];
  assert.equal(findDocKey("/repo", { fs: fakeFs(files, { ino: { "/repo/AGENTS.md": 999 } }), warn: (l) => warns.push(l) }), null);
  assert.match(warns.join("\n"), /AGENTS\.md: changed while it was being opened/);
  assert.throws(() => resolveConfig("/repo", { fs: fakeFs({ "/repo/.git": null, "/repo/.sprintree.json": '{"project":"SPD"}' }, { ino: { "/repo/.sprintree.json": 999 } }) }), /changed while/);
});

test("a parent directory swapped for a link between the check and the open is caught: the second resolution leaves the repo or leads to another file", () => {
  const files = { "/repo/.git": null, "/repo/.sprintree.json": '{"project":"SPD"}', "/etc/other.json": '{"project":"EVIL"}' };
  const out = fakeFs(files, { real: { "/repo/.sprintree.json": ["/repo/.sprintree.json", "/etc/other.json"] } });
  assert.throws(() => resolveConfig("/repo", { fs: out }), /outside the repo/);
  const back = fakeFs({ ...files, "/repo/other.json": '{"project":"EVIL"}' }, { real: { "/repo/.sprintree.json": ["/repo/.sprintree.json", "/repo/other.json"] } });
  assert.throws(() => resolveConfig("/repo", { fs: back }), /changed while/);
});

test("the reader refuses an opened descriptor that is not a regular file (a FIFO swapped in after the check)", () => {
  const fs = fakeFs({ "/repo/.git": null, "/repo/.sprintree.json": '{"project":"SPD"}' }, { notFileOnFstat: true });
  assert.throws(() => resolveConfig("/repo", { fs }), /not a regular file/);
});

test("on POSIX a config or doc file that another user owns is refused", { skip: typeof process.getuid !== "function" }, () => {
  const other = process.getuid() + 1;
  assert.throws(() => resolveConfig("/repo", { fs: fakeFs({ "/repo/.git": null, "/repo/.sprintree.json": '{"project":"SPD"}' }, { uid: other }) }), /not owned by the current user/);
  const warns = [];
  assert.equal(findDocKey("/repo", { fs: fakeFs({ "/repo/.git": null, "/repo/AGENTS.md": "https://sprintree.com/p/ABC" }, { uid: other }), warn: (l) => warns.push(l) }), null);
  assert.match(warns.join("\n"), /AGENTS\.md: not owned/);
});

test("doc files: a symlink to a regular file inside the repo is read, one that leads outside is skipped with a warning", { skip: win }, async () => {
  const outside = tmpRepo({ "secret.md": "https://sprintree.com/p/LEAK" });
  const root = tmpRepo({ "docs/real.md": "https://sprintree.com/p/INSIDE", "GEMINI.md": "https://sprintree.com/p/GEM" });
  symlinkSync(path.join(outside, "secret.md"), path.join(root, "AGENTS.md"));
  symlinkSync(path.join(root, "docs", "real.md"), path.join(root, "CLAUDE.md"));
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["key"]), 0);
  assert.deepEqual(h.lines, ["INSIDE"]);
  assert.match(h.errs.join("\n"), /AGENTS\.md: resolves outside the repo/);
  assert.ok(!h.errs.join("\n").includes("CLAUDE.md"), "the accepted link is not warned about");
  assert.ok(!/replace|put a regular file/i.test(h.errs.join("\n")));
});

test("doc files: a link to /dev/zero and a FIFO are skipped at once and never read", { skip: win, timeout: 20000 }, async () => {
  const root = tmpRepo({ "GEMINI.md": "https://sprintree.com/p/GEM" });
  symlinkSync("/dev/zero", path.join(root, "AGENTS.md"));
  execFileSync("mkfifo", [path.join(root, "CLAUDE.md")]);
  const h = harness(() => null, { env: {}, cwd: root });
  const t0 = Date.now();
  assert.equal(await h.go(["key"]), 0);
  assert.ok(Date.now() - t0 < 5000, "must not read the target");
  assert.deepEqual(h.lines, ["GEM"]);
  assert.match(h.errs.join("\n"), /AGENTS\.md: resolves outside the repo/);
  assert.match(h.errs.join("\n"), /CLAUDE\.md: not a regular file/);
});

test("a hard-linked .sprintree.json and an oversized .sprintree.json or doc file are refused (also on Windows)", async () => {
  const outside = tmpRepo({ "real.md": "https://sprintree.com/p/SHARED", "real.json": '{"project":"LEAK"}' });
  const root = tmpRepo({ "GEMINI.md": "https://sprintree.com/p/GEM" });
  writeFileSync(path.join(root, "CLAUDE.md"), "x".repeat(1024 * 1024 + 10) + " https://sprintree.com/p/BIG");
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["key"]), 0);
  assert.deepEqual(h.lines, ["GEM"]);
  assert.match(h.errs.join("\n"), /CLAUDE\.md: larger/);
  const hard = tmpRepo();
  linkSync(path.join(outside, "real.json"), path.join(hard, ".sprintree.json"));
  const a = harness(() => null, { env: {}, cwd: hard });
  assert.equal(await a.go(["key"]), 1);
  assert.match(a.errs[0], /hard link/);
  const bigJson = tmpRepo({ ".sprintree.json": JSON.stringify({ project: "SPD", pad: "y".repeat(1024 * 1024 + 10) }) });
  const b = harness(() => null, { env: {}, cwd: bigJson });
  assert.equal(await b.go(["key"]), 1);
  assert.match(b.errs[0], /larger/);
});

test("a hard-linked doc file is still read: it can only yield a project key", () => {
  const outside = tmpRepo({ "real.md": "https://sprintree.com/p/SHARED" });
  const root = tmpRepo();
  linkSync(path.join(outside, "real.md"), path.join(root, "AGENTS.md"));
  assert.equal(resolveConfig(root).project, "SHARED");
});

test("doc files are decoded like .sprintree.json (UTF-8 BOM, UTF-16LE)", () => {
  const link = "see https://sprintree.com/p/ABC";
  assert.equal(resolveConfig(tmpRepo({ "AGENTS.md": Buffer.concat([BOM8, Buffer.from(link)]) })).project, "ABC");
  assert.equal(resolveConfig(tmpRepo({ "AGENTS.md": utf16le(link) })).project, "ABC");
});

test("containment is checked against the repo root: a subdirectory symlinked outside is refused", { skip: win }, () => {
  const outside = tmpRepo({ "x/.sprintree.json": '{"project":"EVIL"}' });
  const root = tmpRepo();
  symlinkSync(path.join(outside, "x"), path.join(root, "sub"));
  assert.throws(() => resolveConfig(path.join(root, "sub")), /outside/);
  const ok = tmpRepo({ "sub/.sprintree.json": '{"project":"OKAY"}' });
  assert.equal(resolveConfig(path.join(ok, "sub")).project, "OKAY");
});

test("@file: a JSON error never echoes the file, a directory, a device or an oversized file is refused (also on Windows)", { timeout: 20000 }, async () => {
  const dir = tmpRepo({ "bad.json": "root:x:0:0:SECRETLINE:/root:/bin/bash\n", "big.json": '{"a":"' + "z".repeat(1024 * 1024 + 10) + '"}' });
  const bad = harness(okCall, { cwd: dir });
  assert.equal(await bad.go(["call", "x", "@bad.json"]), 1);
  assert.match(bad.errs[0], /not valid JSON/);
  assert.ok(!/SECRETLINE|root:x/.test(bad.errs.join("")), bad.errs.join(""));
  const inline = harness(okCall, { cwd: dir });
  assert.equal(await inline.go(["call", "x", "root:x:0:0:SECRETLINE"]), 1);
  assert.ok(!/SECRETLINE|root:x/.test(inline.errs.join("")), inline.errs.join(""));
  const big = harness(okCall, { cwd: dir });
  assert.equal(await big.go(["call", "x", "@big.json"]), 1);
  assert.match(big.errs[0], /larger/);
  const asDir = harness(okCall, { cwd: dir });
  assert.equal(await asDir.go(["call", "x", `@${dir}`]), 1);
  assert.match(asDir.errs[0], /not a regular file/);
  const missing = harness(okCall, { cwd: dir });
  assert.equal(await missing.go(["call", "x", "@nope.json"]), 1);
  assert.match(missing.errs[0], /not found/);
  if (!win) {
    const dev = harness(okCall, { cwd: dir });
    const t0 = Date.now();
    assert.equal(await dev.go(["call", "x", "@/dev/zero"]), 1);
    assert.ok(Date.now() - t0 < 5000);
    assert.match(dev.errs[0], /not a regular file/);
    assert.equal(dev.fetch.calls.length, 0);
  }
});

// ---- what is printed -------------------------------------------------------------------------

test("warnings: token-like key names and file paths are fully scrubbed (OSC 52 in a key, C1 in a key, ESC in a directory name)", { skip: win }, async () => {
  const cfg = JSON.stringify({ project: "SPD", ["token\u001b]52;c;aGFja2Vk\u0007"]: "x", ["pat\u009b31m"]: "y", ["odd\u009d52;c;QQ==\u0007"]: 1 });
  const root = tmpRepo({ ".sprintree.json": cfg });
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["key"]), 0);
  assert.ok(h.errs.length >= 2);
  for (const e of h.errs) assert.ok(!RAW_BAD.test(e), JSON.stringify(e));
  // a repo directory whose own name carries an OSC 0 title sequence
  const base = tmpRepo();
  const evil = path.join(base, "evil\u001b]0;PWNED\u0007dir");
  mkdirSync(path.join(evil, ".git"), { recursive: true });
  writeFileSync(path.join(evil, ".sprintree.json"), JSON.stringify({ project: "SPD", extra: 1, token: "t" }));
  const g = harness(() => null, { env: {}, cwd: evil });
  assert.equal(await g.go(["key"]), 0);
  assert.ok(g.errs.length >= 2);
  for (const e of g.errs) assert.ok(!RAW_BAD.test(e), JSON.stringify(e));
  writeFileSync(path.join(evil, ".sprintree.json"), "not json");
  const bad = harness(() => null, { env: {}, cwd: evil });
  assert.equal(await bad.go(["key"]), 1);
  for (const e of bad.errs) assert.ok(!RAW_BAD.test(e), JSON.stringify(e));
});

test("warning lines read as sentences: one key or several, one file or several", async () => {
  const one = harness(() => null, { env: {}, cwd: tmpRepo({ ".sprintree.json": JSON.stringify({ project: "SPD", token: "x" }) }) });
  await one.go(["key"]);
  assert.match(one.errs[0], /has a key that looks like a token \(token\)\./);
  const many = harness(() => null, { env: {}, cwd: tmpRepo({ ".sprintree.json": JSON.stringify({ project: "SPD", token: "x", secret: "y" }) }) });
  await many.go(["key"]);
  assert.match(many.errs[0], /has keys that look like tokens \(token, secret\)\./);
  const skipped = harness(() => null, { env: {}, cwd: tmpRepo({ "AGENTS.md": "x".repeat(1024 * 1024 + 10), "GEMINI.md": "https://sprintree.com/p/GEM" }) });
  await skipped.go(["key"]);
  assert.match(skipped.errs[0], /^Warning: skipped .*AGENTS\.md: larger than 1 MB$/);
});

test("config output: C1 and DEL are escaped as \\u00XX, invisible characters are removed, the value survives", async () => {
  const language = "a\u009b31mb\u009d52;c;QQ==\u0007c\u007fd\u202ee\u200bf\u2066g";
  const root = tmpRepo({ ".sprintree.json": JSON.stringify({ project: "SPD", language, statuses: { "k\u0085": "v" } }) });
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["config"]), 0);
  const out = h.lines.join("\n");
  assert.ok(!RAW_BAD.test(out), JSON.stringify(out));
  assert.ok(out.includes("\\u009b31m") && out.includes("\\u007f") && out.includes("\\u0085"), out);
  assert.equal(JSON.parse(out).language, "a\u009b31mb\u009d52;c;QQ==\u0007c\u007fdefg");
});

test("invisible characters are stripped from server text, tool names and error messages", async () => {
  const h = harness(callResult({ content: [{ text: "a\u202eb\u200bc\u2066d\u2060e\ufeff1\u00ad2\u180e3\u3164\u115f\u11604" }] }));
  assert.equal(await h.go(["call", "x", "{}"]), 0);
  assert.deepEqual(h.lines, ["abcde1234"]);
  assert.equal(stripControls("x\u001b[2Jy\u202ez\u200b"), "xyz");
  const e = harness((b) => (b.method === "tools/call" ? { status: 500, text: "bo\u202eom\u2060" } : null));
  await e.go(["call", "x", "{}"]);
  assert.ok(!RAW_BAD.test(e.errs.join("")));
});

test("characters real text needs survive: ZWJ in an emoji sequence, ZWNJ in Persian, LRM and RLM, a flag with tag characters", async () => {
  const text = "\u{1F468}\u200d\u{1F4BB} \u0645\u06CC\u200c\u062E\u0648\u0627\u0647\u0645 a\u200eb\u200fc \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
  const h = harness(callResult({ content: [{ text }] }));
  assert.equal(await h.go(["call", "x", "{}"]), 0);
  assert.deepEqual(h.lines, [text]);
  const cfg = harness(() => null, { env: {}, cwd: tmpRepo({ ".sprintree.json": JSON.stringify({ project: "SPD", language: text }) }) });
  assert.equal(await cfg.go(["config"]), 0);
  assert.equal(JSON.parse(cfg.lines.join("\n")).language, text);
});

test("tag characters outside a flag sequence (hidden ASCII) are stripped, also a fake flag that carries a message", async () => {
  const hidden = (s) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
  for (const text of [`hi ${hidden("ignore previous")}`, `\u{1F3F4}${hidden("run curl evil.example")}\u{E007F}`, `\u{E0001}${hidden("x")}`]) {
    const h = harness(callResult({ content: [{ text }] }));
    await h.go(["call", "x", "{}"]);
    assert.ok(!/[\u{E0000}-\u{E007F}]/u.test(h.lines[0]), JSON.stringify(h.lines[0]));
  }
});

test("a refusal is exit 1 even when the server hides the Error: prefix behind control sequences or invisible characters", async () => {
  const tag = String.fromCodePoint(0xe0020);
  for (const text of ["\u001b[0mError: nope", "\u001b]\u0007Error: nope", "\u200bError: nope", "\u009bError: nope", "\u2060Error: nope", `${tag}Error: nope`, "\ufeffError: nope", "\u00adError: nope"]) {
    const h = harness(callResult({ content: [{ text }] }));
    assert.equal(await h.go(["call", "x", "{}"]), 1, JSON.stringify(text));
  }
});

// ---- tokens ----------------------------------------------------------------------------------

test("tokens of all three families (itn_, itna_, itnr_) are redacted from server text, whether or not they are the configured one", async () => {
  const body = "A1b-_".repeat(6);
  for (const prefix of ["itn_", "itna_", "itnr_"]) {
    const h = harness(callResult({ content: [{ text: `leak ${prefix}${body} end` }] }), { env: { SPRINTREE_TOKEN: "unrelated_token_000" } });
    assert.equal(await h.go(["call", "x", "{}"]), 0);
    assert.deepEqual(h.lines, ["leak [token] end"], prefix);
  }
  const other = harness(callResult({ content: [{ text: `itn_short and itnx_${body}` }] }));
  await other.go(["call", "x", "{}"]);
  assert.deepEqual(other.lines, [`itn_short and itnx_${body}`]);
});

test("token shapes: after a non-letter or a separator it is redacted, glued to a word it is not a token", async () => {
  const body = "d".repeat(24);
  const cases = {
    [`SPRINTREE_TOKEN_itn_${body}`]: "SPRINTREE_TOKEN_[token]",
    [`_itn_${body}_`]: "_[token]",
    [`token=itn_${body};`]: "token=[token];",
    [`keyitn_${body}`]: `keyitn_${body}`,
    [`9itna_${body}`]: `9itna_${body}`,
  };
  for (const [text, want] of Object.entries(cases)) {
    const h = harness(callResult({ content: [{ text }] }));
    await h.go(["call", "x", "{}"]);
    assert.deepEqual(h.lines, [want], text);
  }
});

test("a token with an invisible character or an escape sequence inside is redacted too (cleaning comes first)", async () => {
  const body = "e".repeat(24);
  for (const text of [`itn_${"e".repeat(10)}\u200b${"e".repeat(14)}`, `x \u001b[0mitn_${body}`, `\u2060itn_${body}`, `itn_${"e".repeat(10)}${String.fromCodePoint(0xe0041)}${"e".repeat(14)}`]) {
    const h = harness(callResult({ content: [{ text }] }));
    await h.go(["call", "x", "{}"]);
    assert.ok(h.lines[0].includes("[token]") && !h.lines[0].includes("eeeeee"), JSON.stringify(h.lines[0]));
  }
});

// ---- endpoint --------------------------------------------------------------------------------

test("a host other than sprintree.com is named on stderr once, before the token goes there; the comparison ignores case", async () => {
  const other = harness(toolsList([]), { env: { SPRINTREE_TOKEN: TOKEN, SPRINTREE_MCP_URL: "https://mcp.example.test:8443/mcp" } });
  assert.equal(await other.go(["tools"]), 0);
  assert.equal(other.errs.length, 1);
  assert.match(other.errs[0], /mcp\.example\.test:8443/);
  assert.match(other.errs[0], /token/i);
  assert.ok(!other.errs[0].includes(TOKEN));
  for (const url of ["https://sprintree.com/mcp", "https://SPRINTREE.COM/mcp", "https://Sprintree.Com/mcp"]) {
    const dflt = harness(toolsList([]), { env: { SPRINTREE_TOKEN: TOKEN, SPRINTREE_MCP_URL: url } });
    assert.equal(await dflt.go(["tools"]), 0);
    assert.deepEqual(dflt.errs, [], url);
  }
});

test("an invalid SPRINTREE_MCP_URL is shown without user:password@, a wrong scheme only as scheme and host", async () => {
  for (const raw of ["https//user:hunter2@host.example/mcp", "https://user:hunter2@exa mple.test/mcp", "http://user:hunter2@evil.example/mcp"]) {
    const h = harness(() => null, { env: { SPRINTREE_TOKEN: TOKEN, SPRINTREE_MCP_URL: raw } });
    assert.equal(await h.go(["tools"]), 1, raw);
    assert.ok(!h.errs.join("").includes("hunter2") && !h.errs.join("").includes("user:"), `${raw}: ${h.errs.join("")}`);
    assert.match(h.errs[0], /SPRINTREE_MCP_URL/);
  }
  assert.throws(() => checkMcpUrl("https://u:p@exa mple.test/"), (e) => !/u:p/.test(e.message));
});

test("a network error without a cause code shows a short scrubbed cause message", async () => {
  const fetch = async () => {
    throw new TypeError("fetch failed", { cause: new Error(`getaddrinfo ENOTFOUND mcp.example.test \u001b]52;c;QQ==\u0007${TOKEN} ${"x".repeat(500)}`) });
  };
  const errs = [];
  const code = await run(["tools"], { fetch, env: { SPRINTREE_TOKEN: TOKEN }, out: () => {}, err: (s) => errs.push(s) });
  assert.equal(code, 1);
  assert.match(errs[0], /getaddrinfo ENOTFOUND/);
  assert.ok(!RAW_BAD.test(errs[0]) && !errs[0].includes(TOKEN));
  assert.ok(errs[0].length < 200, errs[0].length);
  const none = [];
  await run(["tools"], { fetch: async () => { throw new TypeError("fetch failed"); }, env: { SPRINTREE_TOKEN: TOKEN }, out: () => {}, err: (s) => none.push(s) });
  assert.match(none[0], /unknown error/);
});

// ---- project key and config details ----------------------------------------------------------

test("findDocKey takes the first real link of all links, skipping the template placeholder", () => {
  const root = tmpRepo({ "AGENTS.md": "Template: https://sprintree.com/p/KEY and then the board https://sprintree.com/p/abc/board" });
  assert.deepEqual(findDocKey(root), { key: "ABC", file: path.join(root, "AGENTS.md") });
  assert.equal(findDocKey(tmpRepo({ "AGENTS.md": "nothing here" })), null);
  assert.throws(() => findDocKey(tmpRepo({ "AGENTS.md": "https://sprintree.com/p/KEY" })), /placeholder/);
  // a placeholder in one file does not hide a real link in another
  const two = tmpRepo({ "AGENTS.md": "https://sprintree.com/p/KEY", "CLAUDE.md": "https://sprintree.com/p/REAL" });
  assert.equal(findDocKey(two).key, "REAL");
});

test("the project key from .sprintree.json is upper-cased like one from a link", async () => {
  const root = tmpRepo({ ".sprintree.json": '{"project":"spd9"}' });
  assert.equal(resolveConfig(root).project, "SPD9");
  const h = harness(() => null, { env: {}, cwd: root });
  await h.go(["key"]);
  assert.deepEqual(h.lines, ["SPD9"]);
});

test("config redacts token-looking VALUES of known keys, and a token-looking key name is warned about once", async () => {
  const tok = "itn_" + "Ab1-_".repeat(6);
  const root = tmpRepo({ ".sprintree.json": JSON.stringify({ project: "SPD", statuses: { done: tok }, [tok]: "x" }) });
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["config"]), 0);
  const all = [...h.lines, ...h.errs].join("\n");
  assert.ok(!all.includes(tok) && !all.includes("itn_Ab1"), all);
  assert.match(h.lines.join("\n"), /\[token\]/);
  const warned = h.errs.join("\n");
  assert.match(warned, /statuses\.done/);
  assert.equal(warned.split("[token]").length - 1, 1, warned); // the key name appears once (redacted), not in two lines
});

test("listTools returns the array and refuses a malformed answer", async () => {
  assert.deepEqual(await listTools({ rpc: async (m) => (m === "tools/list" ? { tools: [{ name: "a" }] } : null) }), [{ name: "a" }]);
  await assert.rejects(listTools({ rpc: async () => ({ tools: "nope" }) }), /tools/);
  await assert.rejects(listTools({ rpc: async () => ({}) }), /tools/);
});

test("MIN_NODE: the runtime check and its message are built from the one constant; a missing global fetch is a clear error", async () => {
  const p = MIN_NODE.split(".").map(Number);
  let below = "0.0.0";
  for (let i = 2; i >= 0; i--) if (p[i] > 0) { const q = [...p]; q[i]--; below = q.join("."); break; }
  const errs = [];
  const base = { env: { SPRINTREE_TOKEN: TOKEN }, out: () => {}, err: (s) => errs.push(s), fetch: mockFetch(server(toolsList([]))) };
  assert.equal(await run(["tools"], { ...base, nodeVersion: below }), 1);
  assert.ok(errs[0].includes(`Node.js ${MIN_NODE} or newer`) && errs[0].includes(below), errs[0]);
  assert.equal(await run(["tools"], { ...base, nodeVersion: MIN_NODE }), 0);
  assert.equal(await run(["tools"], { ...base, nodeVersion: "99.0.0" }), 0);
  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    assert.equal(await run(["tools"], { env: base.env, out: base.out, err: base.err }), 1);
    assert.match(errs.at(-1), /fetch/);
  } finally {
    globalThis.fetch = saved;
  }
});

test("the `key` hint names every doc file that is read and .sprintree.json", async () => {
  const h = harness(() => null, { env: {}, cwd: tmpRepo() });
  assert.equal(await h.go(["key"]), 1);
  assert.match(h.errs[0], /AGENTS\.md, CLAUDE\.md, GEMINI\.md or \.claude\/CLAUDE\.md/);
  assert.ok(h.errs[0].includes(".sprintree.json"));
});
