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
