import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, resolveConfig, isMainModule, VERSION, ancestors, checkMcpUrl } from "../skills/sprintree/scripts/st.mjs";

const TOKEN = "spt_secret_value_123456";
const ST = fileURLToPath(new URL("../skills/sprintree/scripts/st.mjs", import.meta.url));
const PAT_PLACE = "Settings -> API & MCP -> Personal access tokens";

// ---- helpers ---------------------------------------------------------------------------------

const cleanups = [];
after(() => cleanups.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Temp dir with a `.git` folder (so the config walk stops there) and the given files {relPath: string|Buffer}. */
function tmpRepo(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "st-"));
  cleanups.push(root);
  mkdirSync(path.join(root, ".git"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** A JSON-RPC success answer to request `b`. */
const reply = (b, result) => ({ json: { jsonrpc: "2.0", id: b.id, result } });

function mockFetch(handler, { session = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, headers: init.headers, body });
    const r = handler(body);
    const text = r.sse ? `event: message\ndata: ${JSON.stringify(r.json)}\n\n` : r.text ?? JSON.stringify(r.json ?? {});
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status ?? 200,
      headers: new Map(session ? [["mcp-session-id", "sess-1"]] : []),
      text: async () => text,
    };
  };
  fn.calls = calls;
  return fn;
}

const server = (extra = () => null, initResult = {}) => (body) => {
  if (body.method === "initialize") return reply(body, initResult);
  if (body.method === "notifications/initialized") return { text: "" };
  return extra(body) ?? { json: { jsonrpc: "2.0", id: body.id, error: { message: "unexpected " + body.method } } };
};

function harness(handler, { env = { SPRINTREE_TOKEN: TOKEN }, cwd = process.cwd(), stdin, session, init } = {}) {
  const lines = [];
  const errs = [];
  const fetch = mockFetch(server(handler, init), { session });
  return {
    lines,
    errs,
    fetch,
    go: (argv) => run(argv, { fetch, env, cwd, stdin, out: (s) => lines.push(s), err: (s) => errs.push(s) }),
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

test("call reads arguments from @file (relative to cwd)", async () => {
  const dir = tmpRepo({ "args.json": '{"key":"SPD-2","body":"# long\\nmarkdown"}' });
  const h = harness(okCall, { cwd: dir });
  assert.equal(await h.go(["call", "add_comment", "@args.json"]), 0);
  assert.equal(h.fetch.calls.at(-1).body.params.arguments.body, "# long\nmarkdown");
});

test("call <tool> - reads JSON arguments from stdin", async () => {
  const h = harness(okCall, { stdin: async () => '{"key":"SPD-3","body":"çox \\"quoted\\""}' });
  assert.equal(await h.go(["call", "add_comment", "-"]), 0);
  assert.deepEqual(h.fetch.calls.at(-1).body.params.arguments, { key: "SPD-3", body: 'çox "quoted"' });
});

test("call <tool> - with empty or bad stdin exits 1", async () => {
  const empty = harness(okCall, { stdin: async () => "  " });
  assert.equal(await empty.go(["call", "x", "-"]), 1);
  assert.match(empty.errs[0], /stdin/);
  const bad = harness(okCall, { stdin: async () => "{nope" });
  assert.equal(await bad.go(["call", "x", "-"]), 1);
  assert.match(bad.errs[0], /not valid JSON/);
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

test(".sprintree.json that is a symlink is refused, also a dangling one", { skip: process.platform === "win32" }, async () => {
  const outside = tmpRepo({ "secret.json": '{"project":"EVIL"}' });
  const root = tmpRepo();
  symlinkSync(path.join(outside, "secret.json"), path.join(root, ".sprintree.json"));
  const h = harness(() => null, { env: {}, cwd: root });
  assert.equal(await h.go(["key"]), 1);
  assert.match(h.errs[0], /symlink/);
  assert.ok(!h.lines.join("").includes("EVIL"));
  const dangling = tmpRepo();
  symlinkSync(path.join(outside, "nope.json"), path.join(dangling, ".sprintree.json"));
  const d = harness(() => null, { env: {}, cwd: dangling });
  assert.equal(await d.go(["config"]), 1);
  assert.match(d.errs[0], /symlink/);
});

test(".sprintree.json whose realpath is outside the directory it was found in is refused", () => {
  const fs = fakeFs({ "/repo/.git": null, "/repo/.sprintree.json": '{"project":"SPD"}' }, { real: { "/repo/.sprintree.json": "/etc/other.json" } });
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
  assert.deepEqual(Object.keys(printed).sort(), ["language", "project", "section_titles", "statuses", "typography"]);
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
  assert.equal(h.lines[0], "abcdxefgh\tI\nJ");
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(h.lines[0]), "control characters left");
});

test("control sequences are removed from tool names, schemas and error messages too", async () => {
  const tools = [{ name: "evil\u001b]52;c;AAAA\u0007_tool", description: "d\u001b[2Jesc", inputSchema: { properties: { "p\u001b[H": {} } } }];
  const l = harness(toolsList(tools));
  await l.go(["tools"]);
  const s = harness(toolsList(tools));
  await s.go(["schema", "evil_tool"]);
  const e = harness((b) => (b.method === "tools/call" ? { status: 500, text: "boom\u001b]52;c;AAAA\u0007!" } : null));
  await e.go(["call", "x", "{}"]);
  for (const out of [...l.lines, ...s.lines, ...e.errs]) assert.ok(!/[\u001b\u0007]/.test(out), JSON.stringify(out));
  assert.deepEqual(l.lines, ["evil_tool(p)"]);
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
    assert.match(errs[0], /server redirected/);
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
  assert.equal(errs[0], "Error: fetch failed: ECONNREFUSED example.test:8443");
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

test("Node < 18 or missing global fetch gives a clear error", async () => {
  const errs = [];
  const base = { env: { SPRINTREE_TOKEN: TOKEN }, out: () => {}, err: (s) => errs.push(s) };
  assert.equal(await run(["tools"], { ...base, fetch: mockFetch(server()), nodeVersion: "16.20.2" }), 1);
  assert.match(errs[0], /Node\.js 18 or newer/);
  assert.match(errs[0], /16\.20\.2/);
  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    assert.equal(await run(["tools"], { ...base }), 1);
    assert.match(errs[1], /fetch/);
  } finally {
    globalThis.fetch = saved;
  }
});

// ---- running as a script ---------------------------------------------------------------------

test("isMainModule: false without argv[1] and for a path that does not exist", () => {
  assert.equal(isMainModule(undefined, import.meta.url), false);
  assert.equal(isMainModule(path.join(tmpdir(), "does-not-exist-st.mjs"), import.meta.url), false);
  assert.equal(isMainModule(fileURLToPath(import.meta.url), import.meta.url), true);
});

test("running the script directly executes main (all platforms)", () => {
  const r = spawnSync(process.execPath, [ST, "version"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), VERSION);
});

test("running through a symlink still executes main", { skip: process.platform === "win32" }, () => {
  const dir = tmpRepo();
  const link = path.join(dir, "st-link.mjs");
  symlinkSync(ST, link);
  const r = spawnSync(process.execPath, [link, "tools"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SPRINTREE_TOKEN/);
});

// ---- path.win32: parent-directory walk and key lookup on Windows-style paths, runnable on any OS

function fakeFs(files, { real = {} } = {}) {
  const norm = (p) => p.toLowerCase();
  const set = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    existsSync: (p) => set.has(norm(p)),
    statSync: (p) => ({ isFile: () => typeof set.get(norm(p)) === "string" }),
    lstatSync: (p) => {
      if (!set.has(norm(p))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isFile: () => typeof set.get(norm(p)) === "string", isSymbolicLink: () => false };
    },
    realpathSync: (p) => real[p] ?? p,
    readFileSync: (p) => set.get(norm(p)),
  };
}

test("win32: ancestors walk up to the drive root and stop at .git", () => {
  const w = path.win32;
  const fs = fakeFs({ "C:\\repo\\.git": null });
  assert.deepEqual([...ancestors("C:\\repo\\a\\b", { path: w, fs })], ["C:\\repo\\a\\b", "C:\\repo\\a", "C:\\repo"]);
  assert.deepEqual([...ancestors("D:\\x\\y", { path: w, fs: fakeFs({}) })], ["D:\\x\\y", "D:\\x", "D:\\"]);
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
