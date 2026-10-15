// listen.mjs, the live-events monitor, against a fake server on 127.0.0.1 (port 0). Each test spawns the script as Claude Code would.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { BODY, ROOT, childEnv, tmpDir } from "../test-support/helpers.mjs";
import { dedupe, formatEvent, sessionId, sseParser } from "../skills/sprintree/scripts/listen.mjs";

const SCRIPT = path.join(ROOT, "skills", "sprintree", "scripts", "listen.mjs");
const TOKEN = `itns_${BODY}`;
const posix = process.platform !== "win32";

/** A fake server: `handler(req, res, n)` for the n-th request. Returns { url, requests, close }. */
async function fake(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res, requests.length);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

const sse = (res, ...frames) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const f of frames) res.write(f);
};
const frame = (event, data, id) => `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const HELLO = { session: "s-1", label: "main", project: "SPD" };

/** Spawns listen.mjs; `lines` fills as stdout arrives; `until(n)` waits for n lines; `exited` resolves with the exit code. */
function start(url, extra = {}, { writeTokenFile = false } = {}) {
  const home = tmpDir("sa-listen-");
  const env = childEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "cfg"),
    SPRINTREE_URL: url,
    SPRINTREE_PROJECT: "SPD",
    SPRINTREE_LISTEN_TEST_BACKOFF_MS: "5",
    SPRINTREE_STREAM_TOKEN: writeTokenFile ? "" : TOKEN,
    CLAUDE_CODE_SESSION_ID: "",
    ...extra,
  });
  const child = spawn(process.execPath, [SCRIPT], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const lines = [];
  const waiters = [];
  child.stdout.on("data", (d) => {
    out += d;
    const parts = out.split("\n");
    out = parts.pop();
    lines.push(...parts);
    waiters.splice(0).forEach((w) => w());
  });
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  const until = async (n, ms = 8000) => {
    const stop = Date.now() + ms;
    while (lines.length < n) {
      if (Date.now() > stop) throw new Error(`timed out waiting for ${n} lines, got ${JSON.stringify(lines)}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  const quit = async () => {
    child.kill("SIGTERM");
    await exited;
  };
  return { child, lines, until, exited, quit, home, env, err: () => err };
}

test("hello and every event type are printed as one line each, the claim suffix is added, unknown types and bad JSON are ignored", async () => {
  const srv = await fake((req, res) =>
    sse(
      res,
      ": keep-alive\n\n",
      frame("hello", HELLO, 1),
      frame("sprintree", { type: "status", issue: "SPD-1029", from: "in_progress", to: "review", actor: "samir", ev: "e1" }, 2),
      frame("sprintree", { type: "status", issue: "SPD-1", from: "todo", to: "in_progress", actor: "ali", ev: "e2", claim: true }, 3),
      frame("sprintree", { type: "notification", kind: "mention", issue: "SPD-12", actor: "ali", ev: "e3" }, 4),
      frame("sprintree", { type: "command", issue: "SPD-12", comment: "c9", ev: "e4", claim: true }, 5),
      frame("sprintree", { type: "batch", count: 40, to: "done", actor: "samir" }, 6),
      frame("sprintree", { type: "summary", mentions: 2, status: 5, commands: 1 }, 7),
      frame("sprintree", { type: "summary", mentions: 1, status: 0, commands: 0 }, 8),
      frame("sprintree", { type: "summary", mentions: 0, status: 0, commands: 0 }, 9),
      frame("sprintree", { type: "future-thing", issue: "SPD-1" }, 10),
      frame("sprintree", "{not json", 11),
      "event: other\ndata: {}\n\n",
      frame("sprintree", { type: "batch", count: 1, to: "done", actor: "x" }, 12)
    )
  );
  const p = start(srv.url);
  try {
    await p.until(9);
    assert.deepEqual(p.lines, [
      "sprintree-events connected · session=s-1 · name=main · project=SPD",
      "SPD-1029 · status in_progress→review · @samir · ev=e1",
      "SPD-1 · status todo→in_progress · @ali · ev=e2 · claim first",
      "SPD-12 · mention · @ali · ev=e3",
      "SPD-12 · /claude command · comment=c9 · ev=e4 · claim first",
      "40 cards → done · @samir",
      "while you were away: 2 notifications (mentions, replies, assignments, reviews), 5 status changes, 1 /claude command",
      "while you were away: 1 notification (mentions, replies, assignments, reviews)",
      "1 card → done · @x",
    ]);
    const h = srv.requests[0].headers;
    assert.equal(srv.requests[0].url, "/api/stream?project=SPD");
    assert.equal(h.authorization, `Bearer ${TOKEN}`);
    assert.equal(h.accept, "text/event-stream");
    assert.equal(h["x-stream-label"], "main");
    assert.match(h["x-stream-session"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(h["last-event-id"], undefined);
  } finally {
    await p.quit();
    await srv.close();
  }
  assert.ok(!p.lines.join("\n").includes(TOKEN) && !p.err().includes(TOKEN));
});

test("hostile fields: an escape sequence, a newline, a wrong character or an overlong value drops the line; nothing with a control character is printed", async () => {
  const bad = [
    { type: "status", issue: "SPD-1\u001b]52;c;aGk=\u0007", from: "a", to: "b", actor: "x", ev: "e" },
    { type: "status", issue: "SPD-1\nSPD-2 · mention", from: "a", to: "b", actor: "x", ev: "e" },
    { type: "status", issue: "SPD-1", from: "a b", to: "b", actor: "x", ev: "e" },
    { type: "status", issue: "S".repeat(65), from: "a", to: "b", actor: "x", ev: "e" },
    { type: "status", issue: "SPD-1", from: "a", to: "b", actor: "@x", ev: "e" },
    { type: "status", issue: "SPD-1", from: "a", to: "b", actor: "x" },
    { type: "notification", kind: "mention‮", issue: "SPD-1", actor: "x", ev: "e" },
    { type: "batch", count: -1, to: "done", actor: "x" },
    { type: "batch", count: 1.5, to: "done", actor: "x" },
    { type: "batch", count: "40", to: "done", actor: "x" },
    { type: "summary", mentions: "2", status: 0, commands: 0 },
    { type: "command", issue: "SPD-1", comment: ["c"], ev: "e" },
    { type: ["status"], issue: "SPD-1" },
  ];
  const srv = await fake((req, res) =>
    sse(res, frame("hello", HELLO), ...bad.map((b) => frame("sprintree", b)), frame("sprintree", { type: "batch", count: 2, to: "done", actor: "ok" }), frame("sprintree", { type: "status", issue: "A".repeat(64), from: "a", to: "b", actor: "x", ev: "e", claim: "yes" }))
  );
  const p = start(srv.url);
  try {
    await p.until(3);
    assert.equal(p.lines[1], "2 cards → done · @ok");
    assert.equal(p.lines[2], `${"A".repeat(64)} · status a→b · @x · ev=e`, "a 64-character value is allowed, claim must be exactly true");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(p.lines.length, 3);
    for (const l of p.lines) assert.ok(!/[\u0000-\u001f\u007f-\u009f‮]/.test(l) && l.length <= 300, JSON.stringify(l));
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("a token inside a field is hidden, and the token is never printed or logged", async () => {
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO), frame("sprintree", { type: "notification", kind: "mention", issue: TOKEN, actor: "x", ev: "e" })));
  const p = start(srv.url);
  try {
    await p.until(2);
    assert.ok(p.lines[1].includes("[token]"), p.lines[1]);
    assert.ok(!p.lines.join("\n").includes(BODY));
  } finally {
    await p.quit();
    await srv.close();
  }
  assert.ok(!p.err().includes(BODY));
});

test("a reconnect sends the same session and Last-Event-ID, prints no second hello, and goes on with the new frames", async () => {
  const srv = await fake((req, res, n) => {
    if (n === 1) {
      sse(res, frame("hello", HELLO, "a1"), frame("sprintree", { type: "batch", count: 1, to: "done", actor: "x" }, "a2"));
      setTimeout(() => res.end(), 30);
    } else if (n === 2) {
      res.writeHead(503, { "Retry-After": "0" }).end("busy");
    } else {
      sse(res, frame("hello", HELLO), frame("sprintree", { type: "batch", count: 2, to: "done", actor: "y" }, "a3"));
    }
  });
  const p = start(srv.url, { CLAUDE_CODE_SESSION_ID: "raw-session-id" });
  try {
    await p.until(3);
    assert.deepEqual(p.lines, ["sprintree-events connected · session=s-1 · name=main · project=SPD", "1 card → done · @x", "2 cards → done · @y"]);
    assert.equal(srv.requests.length, 3);
    assert.equal(srv.requests[1].headers["last-event-id"], "a2");
    assert.equal(srv.requests[2].headers["last-event-id"], "a2");
    const sess = srv.requests.map((r) => r.headers["x-stream-session"]);
    assert.equal(new Set(sess).size, 1);
    assert.equal(sess[0], sessionId({ CLAUDE_CODE_SESSION_ID: "raw-session-id" }));
    assert.ok(!sess[0].includes("raw-session-id"));
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("a changed label on reconnect prints the hello again; a long outage prints lost once and reconnected once", async () => {
  const srv = await fake((req, res, n) => {
    if (n === 1) return sse(res, frame("hello", HELLO, "1")), setTimeout(() => res.end(), 20);
    if (n <= 8) return res.writeHead(500).end();
    sse(res, frame("hello", { ...HELLO, label: "other" }, "2"));
  });
  // 60 "seconds" are 60 * 5 ms = 300 ms here; backoff 5, 10, 20, 40, 80 ... passes 300 ms after a few failures
  const p = start(srv.url);
  try {
    await p.until(4, 15000);
    assert.deepEqual(p.lines, [
      "sprintree-events connected · session=s-1 · name=main · project=SPD",
      "sprintree-events: connection lost, retrying",
      "sprintree-events: reconnected",
      "sprintree-events connected · session=s-1 · name=other · project=SPD",
    ]);
  } finally {
    await p.quit();
    await srv.close();
  }
});

for (const [name, status, body, line] of [
  ["401", 401, "{}", "sprintree-events: the live-events token was rejected; run /sprintree:connect"],
  ["404", 404, "{}", "sprintree-events: project SPD not found or not shared with you"],
  ["429 connection_limit", 429, '{"error":{"kind":"rate_limited","code":"connection_limit","message":"10 live"}}', "sprintree-events: 10 live connections already open; not connecting"],
  ["429 connection_limit, flat fallback", 429, '{"code":"connection_limit"}', "sprintree-events: 10 live connections already open; not connecting"],
  ["409 session_detached", 409, '{"error":{"kind":"conflict","code":"session_detached","message":"detached"}}', "sprintree-events: this session was detached in Settings; restart Claude Code after 10 minutes to reconnect"],
  ["another 409", 409, "{}", "sprintree-events: the server answered 409; not connecting"],
  ["another 4xx", 403, "{}", "sprintree-events: the server answered 403; not connecting"],
]) {
  test(`${name}: one line, no retry, exit 0, no token in the output`, async () => {
    const srv = await fake((req, res) => res.writeHead(status, { "Content-Type": "application/json" }).end(body));
    const p = start(srv.url);
    try {
      assert.equal(await p.exited, 0);
      assert.deepEqual(p.lines, [line]);
      assert.equal(srv.requests.length, 1);
      assert.ok(!p.err().includes(BODY));
    } finally {
      await srv.close();
    }
  });
}

test("a 429 without the connection_limit code is retried, honoring Retry-After", async () => {
  const srv = await fake((req, res, n) => (n === 1 ? res.writeHead(429, { "Retry-After": "1", "Content-Type": "application/json" }).end('{"error":{"kind":"rate_limited","code":"slow","message":"x"}}') : sse(res, frame("hello", HELLO))));
  const p = start(srv.url);
  try {
    await p.until(1);
    assert.equal(srv.requests.length, 2);
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("without a token or without a project nothing is printed and the exit code is 0", async () => {
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO)));
  try {
    for (const extra of [{ SPRINTREE_STREAM_TOKEN: "" }, { SPRINTREE_STREAM_TOKEN: "itn_" + BODY }, { SPRINTREE_PROJECT: "" }, { SPRINTREE_PROJECT: "not a key" }]) {
      const p = start(srv.url, extra, { writeTokenFile: "SPRINTREE_STREAM_TOKEN" in extra });
      assert.equal(await p.exited, 0);
      assert.deepEqual(p.lines, [], JSON.stringify(extra));
      assert.equal(p.err(), "");
    }
    assert.equal(srv.requests.length, 0);
  } finally {
    await srv.close();
  }
});

test("SPRINTREE_PROJECT is upper-cased: spd works as SPD", async () => {
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO)));
  const p = start(srv.url, { SPRINTREE_PROJECT: " spd " });
  try {
    await p.until(1);
    assert.equal(srv.requests[0].url, "/api/stream?project=SPD");
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("an empty actor leaves the actor part out of a status or notification line; issue and ev stay required", () => {
  assert.equal(formatEvent({ type: "status", issue: "SPD-1", from: "a", to: "b", actor: "", ev: "e1" }), "SPD-1 · status a→b · ev=e1");
  assert.equal(formatEvent({ type: "notification", kind: "mention", issue: "SPD-1", ev: "e2" }), "SPD-1 · mention · ev=e2");
  assert.equal(formatEvent({ type: "notification", kind: "mention", issue: "SPD-1", actor: "ali", ev: "e2" }), "SPD-1 · mention · @ali · ev=e2");
  assert.equal(formatEvent({ type: "notification", kind: "mention", issue: "", actor: "", ev: "e2" }), null);
  assert.equal(formatEvent({ type: "status", issue: "SPD-1", from: "a", to: "b", actor: "", ev: "" }), null);
});

test("the token file and the .sprintree.json project are used; the project of the file wins over SPRINTREE_PROJECT", async () => {
  const srv = await fake((req, res) => sse(res, frame("hello", { ...HELLO, project: "ABC" })));
  const home = tmpDir("sa-listen-");
  const dir = path.join(home, "cfg", "sprintree");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "stream-token"), `${TOKEN}\nsecond line ignored\n`, { mode: 0o600 });
  mkdirSync(path.join(home, ".git"));
  writeFileSync(path.join(home, ".sprintree.json"), JSON.stringify({ project: "abc" }));
  const env = childEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "cfg"), SPRINTREE_URL: srv.url, SPRINTREE_PROJECT: "ZZZ", SPRINTREE_STREAM_TOKEN: "" });
  const q = spawn(process.execPath, [SCRIPT], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((r) => q.on("exit", r));
  let out = "";
  q.stdout.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 100 && !srv.requests.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(srv.requests[0].url, "/api/stream?project=ABC");
    assert.equal(srv.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  } finally {
    q.kill("SIGTERM");
    await exited;
    await srv.close();
  }
  assert.ok(!out.includes(BODY));
});

test("a token file readable by group or others is refused with a chmod hint, and nothing is sent", { skip: !posix }, async () => {
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO)));
  const home = tmpDir("sa-listen-");
  const dir = path.join(home, "cfg", "sprintree");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "stream-token");
  writeFileSync(file, `${TOKEN}\n`);
  chmodSync(file, 0o644);
  const env = childEnv({ HOME: home, XDG_CONFIG_HOME: path.join(home, "cfg"), SPRINTREE_URL: srv.url, SPRINTREE_PROJECT: "SPD", SPRINTREE_STREAM_TOKEN: "" });
  const child = spawn(process.execPath, [SCRIPT], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("exit", r));
  await srv.close();
  assert.equal(code, 0);
  assert.equal(out, `sprintree-events: the token file is readable by others; run chmod 600 ${file}\n`);
  assert.ok(!(out + err).includes(BODY));
  assert.equal(srv.requests.length, 0);
});

test("SPRINTREE_URL must be https (or localhost): a plain http host is refused before any request", async () => {
  const p = start("http://example.com");
  assert.equal(await p.exited, 0);
  assert.deepEqual(p.lines, ["sprintree-events: SPRINTREE_URL must be https (plain http only for localhost and 127.0.0.1)"]);
});

test("sseParser: CRLF, CR, multi-line data, comments, a frame split over chunks, an id with a NUL", () => {
  const got = [];
  const p = sseParser((f) => got.push(f));
  p.push("id: 7\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n: c\n");
  p.push("data: sp");
  p.push("lit\n\n");
  p.push("id: 8\0\ndata: z\r");
  p.push("\n\r");
  p.push("\n");
  assert.deepEqual(got, [
    { id: "7", event: "x", data: "a\nb" },
    { id: "7", event: "message", data: "split" },
    { id: "7", event: "message", data: "z" },
  ]);
});

test("formatEvent and sessionId", () => {
  assert.equal(formatEvent({ type: "summary", mentions: 0, status: 0, commands: 0 }), null);
  assert.equal(formatEvent(null), null);
  assert.equal(formatEvent([]), null);
  assert.equal(sessionId({ CLAUDE_CODE_SESSION_ID: "a" }), sessionId({ CLAUDE_CODE_SESSION_ID: "a" }));
  assert.notEqual(sessionId({ CLAUDE_CODE_SESSION_ID: "a" }), sessionId({ CLAUDE_CODE_SESSION_ID: "b" }));
  assert.match(sessionId({}), /^[0-9a-f-]{36}$/);
});

test("a frame whose ev was already printed is dropped, also after a reconnect; batch and summary are never deduped", async () => {
  const note = { type: "notification", kind: "mention", issue: "SPD-1", actor: "ann", ev: "n1" };
  const status = { type: "status", issue: "SPD-1", from: "todo", to: "done", actor: "ann", ev: "n1" };
  const batch = { type: "batch", count: 2, to: "done", actor: "x" };
  const srv = await fake((req, res, n) => {
    if (n === 1) {
      sse(res, frame("hello", HELLO), frame("sprintree", note, "a1"), frame("sprintree", note, "a2"), frame("sprintree", batch, "a3"), frame("sprintree", batch, "a4"));
      setTimeout(() => res.end(), 30);
    } else {
      sse(res, frame("hello", HELLO), frame("sprintree", note, "a5"), frame("sprintree", status, "a6"), frame("sprintree", { ...note, ev: "n2" }, "a7"));
    }
  });
  const p = start(srv.url);
  try {
    await p.until(5);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(p.lines, [
      "sprintree-events connected · session=s-1 · name=main · project=SPD",
      "SPD-1 · mention · @ann · ev=n1",
      "2 cards → done · @x",
      "2 cards → done · @x",
      "SPD-1 · status todo→done · @ann · ev=n1",
      "SPD-1 · mention · @ann · ev=n2",
    ]);
    assert.ok(srv.requests.length >= 2);
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("dedupe: a repeat is reported, the oldest key is evicted past the cap", () => {
  const seen = dedupe(2);
  assert.equal(seen("a"), false);
  assert.equal(seen("a"), true);
  assert.equal(seen("b"), false);
  assert.equal(seen("c"), false); // evicts a
  assert.equal(seen("b"), true);
  assert.equal(seen("a"), false); // a was evicted, so it is new again
});
