import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, resolveConfig } from "../skills/sprintree/scripts/st.mjs";

const TOKEN = "spt_secret_value_123456";

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const r = handler(body);
    const text = r.sse ? `event: message\ndata: ${JSON.stringify(r.json)}\n\n` : r.text ?? JSON.stringify(r.json ?? {});
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status ?? 200,
      headers: new Map([["mcp-session-id", "sess-1"]]),
      text: async () => text,
    };
  };
  fn.calls = calls;
  return fn;
}

const server = (extra = () => null) => (body) => {
  if (body.method === "initialize") return { json: { jsonrpc: "2.0", id: body.id, result: {} } };
  if (body.method === "notifications/initialized") return { text: "" };
  return (
    extra(body) ?? { json: { jsonrpc: "2.0", id: body.id, error: { message: "unexpected " + body.method } } }
  );
};

function harness(handler, env = { SPRINTREE_TOKEN: TOKEN }, cwd = process.cwd()) {
  const lines = [];
  const errs = [];
  const fetch = mockFetch(server(handler));
  return {
    lines,
    errs,
    fetch,
    go: (argv) => run(argv, { fetch, env, cwd, out: (s) => lines.push(s), err: (s) => errs.push(s) }),
  };
}

test("tools lists names and argument names, sends Bearer + session id", async () => {
  const h = harness((b) =>
    b.method === "tools/list"
      ? {
          sse: true,
          json: {
            jsonrpc: "2.0",
            id: b.id,
            result: { tools: [{ name: "search_issues", inputSchema: { properties: { project: {}, query: {} } } }] },
          },
        }
      : null
  );
  assert.equal(await h.go(["tools"]), 0);
  assert.deepEqual(h.lines, ["search_issues(project, query)"]);
  const last = h.fetch.calls.at(-1);
  assert.equal(last.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(last.headers["Mcp-Session-Id"], "sess-1");
});

test("token that already starts with Bearer is not doubled", async () => {
  const h = harness(() => ({ json: { jsonrpc: "2.0", id: 2, result: { tools: [] } } }), {
    SPRINTREE_TOKEN: `Bearer ${TOKEN}`,
  });
  await h.go(["tools"]);
  assert.equal(h.fetch.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test("schema prints description and JSON schema, unknown tool exits 1", async () => {
  const tools = [{ name: "add_comment", description: "Comment on an issue", inputSchema: { type: "object" } }];
  const handler = (b) => (b.method === "tools/list" ? { json: { jsonrpc: "2.0", id: b.id, result: { tools } } } : null);
  const ok = harness(handler);
  assert.equal(await ok.go(["schema", "add_comment"]), 0);
  assert.equal(ok.lines[0], "Comment on an issue");
  const bad = harness(handler);
  assert.equal(await bad.go(["schema", "nope"]), 1);
  assert.match(bad.errs[0], /no such tool/);
});

test("call passes parsed arguments and prints text", async () => {
  const h = harness((b) =>
    b.method === "tools/call"
      ? { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: "ok SPD-1" }] } } }
      : null
  );
  assert.equal(await h.go(["call", "get_issue_details", '{"key":"SPD-1"}']), 0);
  assert.deepEqual(h.lines, ["ok SPD-1"]);
  const call = h.fetch.calls.at(-1).body;
  assert.deepEqual(call.params, { name: "get_issue_details", arguments: { key: "SPD-1" } });
});

test('call exits 1 when the answer starts with "Error:" or isError', async () => {
  const mk = (result) =>
    harness((b) => (b.method === "tools/call" ? { json: { jsonrpc: "2.0", id: b.id, result } } : null));
  const a = mk({ content: [{ text: "Error: A task can only be placed under a story" }] });
  assert.equal(await a.go(["call", "create_issue", "{}"]), 1);
  const b = mk({ isError: true, content: [{ text: "boom" }] });
  assert.equal(await b.go(["call", "create_issue", "{}"]), 1);
});

test("call reads arguments from @file (relative to cwd)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "st-"));
  try {
    writeFileSync(path.join(dir, "args.json"), '{"key":"SPD-2","body":"# long\\nmarkdown"}');
    const h = harness(
      (b) => (b.method === "tools/call" ? { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ text: "done" }] } } } : null),
      { SPRINTREE_TOKEN: TOKEN },
      dir
    );
    assert.equal(await h.go(["call", "add_comment", "@args.json"]), 0);
    assert.equal(h.fetch.calls.at(-1).body.params.arguments.body, "# long\nmarkdown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP error exits 1 and never prints the token", async () => {
  const h = harness(() => ({ status: 401, text: `bad token ${TOKEN}` }));
  // initialize itself answers 200 via server(); force failure on tools/list
  const h2 = harness((b) => (b.method === "tools/list" ? { status: 401, text: `bad token ${TOKEN}` } : null));
  assert.equal(await h2.go(["tools"]), 1);
  const all = [...h2.errs, ...h2.lines].join("\n");
  assert.match(all, /HTTP 401/);
  assert.ok(!all.includes(TOKEN), "token leaked");
  void h;
});

test("missing token exits 1 with a hint and does not call the network", async () => {
  const h = harness(() => null, {});
  assert.equal(await h.go(["tools"]), 1);
  assert.match(h.errs[0], /SPRINTREE_TOKEN/);
  assert.equal(h.fetch.calls.length, 0);
});

test("invalid JSON arguments exit 1", async () => {
  const h = harness(() => null);
  assert.equal(await h.go(["call", "x", "{nope"]), 1);
  assert.match(h.errs[0], /not valid JSON/);
});

test("key: AGENTS.md link, walk up from a subdirectory, lower-case normalised", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "st-"));
  try {
    mkdirSync(path.join(root, ".git"));
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    writeFileSync(path.join(root, "AGENTS.md"), "Board: https://sprintree.com/p/SPD/board\n");
    const h = harness(() => null, {}, path.join(root, "a", "b"));
    assert.equal(await h.go(["key"]), 0);
    assert.deepEqual(h.lines, ["SPD"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(".sprintree.json wins and carries language/status mapping", () => {
  const root = mkdtempSync(path.join(tmpdir(), "st-"));
  try {
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, "AGENTS.md"), "sprintree.com/p/OLD");
    writeFileSync(
      path.join(root, ".sprintree.json"),
      JSON.stringify({ project: "NEW", language: "de", statuses: { review: "in_review" } })
    );
    const cfg = resolveConfig(root);
    assert.equal(cfg.project, "NEW");
    assert.equal(cfg.language, "de");
    assert.equal(cfg.statuses.review, "in_review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key without any link exits 1", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "st-"));
  try {
    mkdirSync(path.join(root, ".git"));
    const h = harness(() => null, {}, root);
    assert.equal(await h.go(["key"]), 1);
    assert.match(h.errs[0], /No project key/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown command exits 1 with usage", async () => {
  const h = harness(() => null);
  assert.equal(await h.go(["bogus"]), 1);
  assert.match(h.errs[0], /usage/);
});

// ---- SPD-1011 (A2): robustness ----------------------------------------------------------------
import { symlinkSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMainModule, VERSION, ancestors, checkMcpUrl } from "../skills/sprintree/scripts/st.mjs";

const ST = fileURLToPath(new URL("../skills/sprintree/scripts/st.mjs", import.meta.url));
const okCall = (b) =>
  b.method === "tools/call" ? { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ text: "done" }] } } } : null;

test("isMainModule: realpath on both sides (drive-letter case, shims)", () => {
  const real = (p) => p.replace(/^[a-z]:/, (m) => m.toUpperCase()).replace(/\/shim\//, "/real/");
  assert.equal(isMainModule("c:\\x\\st.mjs", "file:///C:/x/st.mjs", { realpath: real, toPath: () => "C:\\x\\st.mjs" }), true);
  assert.equal(isMainModule("/n/shim/st.mjs", "file:///n/real/st.mjs", { realpath: real, toPath: () => "/n/real/st.mjs" }), true);
  assert.equal(isMainModule("/other.mjs", "file:///n/real/st.mjs", { realpath: real, toPath: () => "/n/real/st.mjs" }), false);
  assert.equal(isMainModule(undefined, "file:///a", {}), false);
  const boom = () => {
    throw new Error("ENOENT");
  };
  assert.equal(isMainModule("/x", "file:///x", { realpath: boom, toPath: () => "/x" }), false);
});

test("running through a symlink still executes main", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "st-"));
  try {
    const link = path.join(dir, "st-link.mjs");
    symlinkSync(ST, link);
    const r = spawnSync(process.execPath, [link, "tools"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SPRINTREE_TOKEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("call <tool> - reads JSON arguments from stdin", async () => {
  const lines = [];
  const fetch = mockFetch(server(okCall));
  const code = await run(["call", "add_comment", "-"], {
    fetch,
    env: { SPRINTREE_TOKEN: TOKEN },
    cwd: process.cwd(),
    stdin: async () => '{"key":"SPD-3","body":"çox \\"quoted\\""}',
    out: (s) => lines.push(s),
    err: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(fetch.calls.at(-1).body.params.arguments, { key: "SPD-3", body: 'çox "quoted"' });
});

test("call <tool> - with empty or bad stdin exits 1", async () => {
  const errs = [];
  const base = { fetch: mockFetch(server(okCall)), env: { SPRINTREE_TOKEN: TOKEN }, cwd: process.cwd(), out: () => {}, err: (s) => errs.push(s) };
  assert.equal(await run(["call", "x", "-"], { ...base, stdin: async () => "  " }), 1);
  assert.match(errs[0], /stdin/);
  assert.equal(await run(["call", "x", "-"], { ...base, stdin: async () => "{nope" }), 1);
  assert.match(errs[1], /not valid JSON/);
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
  const code = await run(["tools"], {
    fetch,
    env: { SPRINTREE_TOKEN: TOKEN, SPRINTREE_TIMEOUT_MS: "80" },
    cwd: process.cwd(),
    out: () => {},
    err: (s) => errs.push(s),
  });
  assert.equal(code, 1);
  assert.ok(Date.now() - t0 < 5000);
  assert.match(errs[0], /timed out after 80 ms/);
  assert.match(errs[0], /SPRINTREE_TIMEOUT_MS/);
});

test("request timeout: default is 30 s and a signal is always passed", async () => {
  const seen = [];
  const fetch = mockFetch(server((b) => (b.method === "tools/list" ? { json: { jsonrpc: "2.0", id: b.id, result: { tools: [] } } } : null)));
  const wrapped = async (u, init) => (seen.push(init.signal), fetch(u, init));
  await run(["tools"], { fetch: wrapped, env: { SPRINTREE_TOKEN: TOKEN }, cwd: process.cwd(), out: () => {}, err: () => {} });
  assert.ok(seen.length >= 2 && seen.every((s) => s instanceof AbortSignal));
});

test("401 explains an invalid, expired or revoked token, never prints it", async () => {
  const h = harness((b) => (b.method === "tools/list" ? { status: 401, text: `nope ${TOKEN}` } : null));
  assert.equal(await h.go(["tools"]), 1);
  const all = h.errs.join("\n");
  assert.match(all, /invalid, expired or revoked token/);
  assert.ok(!all.includes(TOKEN));
});

test("403 explains the token cannot do this (read-only token on a write tool?)", async () => {
  const h = harness((b) => (b.method === "tools/call" ? { status: 403, text: `forbidden ${TOKEN}` } : null));
  assert.equal(await h.go(["call", "add_comment", "{}"]), 1);
  const all = h.errs.join("\n");
  assert.match(all, /the token cannot do this \(read-only token on a write tool\?\)/);
  assert.ok(!all.includes(TOKEN));
});

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
    const text = "event: message\r\n" + pretty.split("\n").map((l) => `data: ${l}`).join("\r\n") + "\r\n\r\n";
    return { text };
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

test("non-https SPRINTREE_MCP_URL is refused unless localhost, before any request", async () => {
  for (const url of ["http://sprintree.example/mcp", "ftp://x/mcp", "not a url"]) {
    const h = harness(() => null, { SPRINTREE_TOKEN: TOKEN, SPRINTREE_MCP_URL: url });
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
  const base = { env: { SPRINTREE_TOKEN: TOKEN }, cwd: process.cwd(), out: () => {}, err: (s) => errs.push(s) };
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

test(".sprintree.json with a token-like key or itn_ value warns on stderr without echoing the value", () => {
  const root = mkdtempSync(path.join(tmpdir(), "st-"));
  try {
    mkdirSync(path.join(root, ".git"));
    writeFileSync(
      path.join(root, ".sprintree.json"),
      JSON.stringify({ project: "SPD", token: "abc123secretvalue", nested: { pat: "x" }, note: "itn_deadbeefcafe0000", path: "/ok" })
    );
    const warns = [];
    const cfg = resolveConfig(root, { warn: (s) => warns.push(s) });
    assert.equal(cfg.project, "SPD");
    const all = warns.join("\n");
    assert.match(all, /token/);
    assert.match(all, /nested\.pat/);
    assert.match(all, /note/);
    assert.ok(!/path/.test(all.replace(/\.sprintree\.json/g, "")), "plain `path` key must not warn");
    assert.ok(!all.includes("abc123secretvalue") && !all.includes("itn_deadbeef"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`key` command surfaces the token warning on stderr", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "st-"));
  try {
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, ".sprintree.json"), JSON.stringify({ project: "SPD", secret: "s3" }));
    const h = harness(() => null, {}, root);
    assert.equal(await h.go(["key"]), 0);
    assert.deepEqual(h.lines, ["SPD"]);
    assert.match(h.errs.join("\n"), /Warning:.*secret/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single version source: VERSION constant, sent as clientInfo, equals package.json", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
  const h = harness((b) => (b.method === "tools/list" ? { json: { jsonrpc: "2.0", id: b.id, result: { tools: [] } } } : null));
  await h.go(["tools"]);
  assert.equal(h.fetch.calls[0].body.params.clientInfo.version, VERSION);
  const v = harness(() => null, {});
  assert.equal(await v.go(["version"]), 0);
  assert.deepEqual(v.lines, [VERSION]);
});

// path.win32: parent-directory walk and key lookup on Windows-style paths, runnable on any OS
function fakeFs(files) {
  const norm = (p) => p.toLowerCase();
  const set = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    existsSync: (p) => set.has(norm(p)),
    statSync: (p) => ({ isFile: () => typeof set.get(norm(p)) === "string" }),
    readFileSync: (p) => set.get(norm(p)),
  };
}

test("win32: ancestors walk up to the drive root and stop at .git", () => {
  const w = path.win32;
  const fs = fakeFs({ "C:\\repo\\.git": null });
  assert.deepEqual([...ancestors("C:\\repo\\a\\b", { path: w, fs })], ["C:\\repo\\a\\b", "C:\\repo\\a", "C:\\repo"]);
  const none = fakeFs({});
  assert.deepEqual([...ancestors("D:\\x\\y", { path: w, fs: none })], ["D:\\x\\y", "D:\\x", "D:\\"]);
});

test("win32: key lookup from a nested dir finds AGENTS.md and .sprintree.json", () => {
  const w = path.win32;
  const fs = fakeFs({
    "C:\\repo\\.git": null,
    "C:\\repo\\AGENTS.md": "Board https://sprintree.com/p/spd/board",
  });
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
