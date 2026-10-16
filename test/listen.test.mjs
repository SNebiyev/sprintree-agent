// listen.mjs, the live-events monitor, against a fake server on 127.0.0.1 (port 0). Each test spawns the script as Claude Code would.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { BODY, ROOT, childEnv, tmpDir } from "../test-support/helpers.mjs";
import { dedupe, formatEvent, projectOf, sseParser } from "../skills/sprintree/scripts/listen.mjs";
import { ackFile, commandsOn, defaultFile, sessionFile, sessionId } from "../skills/sprintree/scripts/stream-common.mjs";

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
    SPRINTREE_COMMANDS: "",
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
  const p = start(srv.url, { SPRINTREE_COMMANDS: "on" });
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
  const p = start(srv.url, { SPRINTREE_COMMANDS: "on" });
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
  const p = start(srv.url, { SPRINTREE_COMMANDS: "on" });
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
  const p = start(srv.url, { CLAUDE_CODE_SESSION_ID: "raw-session-id", SPRINTREE_COMMANDS: "on" });
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
  const p = start(srv.url, { SPRINTREE_COMMANDS: "on" });
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

test("a batch line keeps an unknown actor: an empty or missing actor leaves the actor part out, a bad one drops the frame", () => {
  assert.equal(formatEvent({ type: "batch", count: 3, to: "done", actor: "" }), "3 cards → done");
  assert.equal(formatEvent({ type: "batch", count: 1, to: "done" }), "1 card → done");
  assert.equal(formatEvent({ type: "batch", count: 3, to: "done", actor: "samir" }), "3 cards → done · @samir");
  assert.equal(formatEvent({ type: "batch", count: 3, to: "done", actor: "a\nb" }), null);
});

test("projectOf upper-cases and trims a .sprintree.json project; a bad one falls back to the environment", () => {
  const home = tmpDir("sa-listen-");
  mkdirSync(path.join(home, ".git"));
  writeFileSync(path.join(home, ".sprintree.json"), JSON.stringify({ project: "abc" }));
  assert.equal(projectOf(home, { SPRINTREE_PROJECT: "ZZZ" }), "ABC");
  writeFileSync(path.join(home, ".sprintree.json"), JSON.stringify({ project: "not a key" }));
  assert.equal(projectOf(home, { SPRINTREE_PROJECT: " zzz " }), "ZZZ");
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
  const p = start(srv.url, { SPRINTREE_COMMANDS: "on" });
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

/** Runs the monitor against a stream of hello, status, command, notification and two summaries; returns the lines printed. */
async function commandRun(extra) {
  const srv = await fake((req, res) =>
    sse(
      res,
      frame("hello", HELLO, 1),
      frame("sprintree", { type: "status", issue: "SPD-1", from: "todo", to: "done", actor: "ann", ev: "s1" }, 2),
      frame("sprintree", { type: "command", issue: "SPD-1", comment: "c1", ev: "c1" }, 3),
      frame("sprintree", { type: "notification", kind: "mention", issue: "SPD-1", actor: "ann", ev: "n1" }, 4),
      frame("sprintree", { type: "summary", mentions: 0, status: 0, commands: 3 }, 5),
      frame("sprintree", { type: "summary", mentions: 2, status: 0, commands: 1 }, 6),
      frame("sprintree", { type: "batch", count: 2, to: "done", actor: "x" }, 7)
    )
  );
  const p = start(srv.url, extra);
  try {
    await p.until(1);
    await new Promise((r) => setTimeout(r, 400));
    return [...p.lines];
  } finally {
    await p.quit();
    await srv.close();
  }
}
const CONNECTED = "sprintree-events connected · session=s-1 · name=main · project=SPD";
const NOTES = "while you were away: 2 notifications (mentions, replies, assignments, reviews)";

test("by default /claude commands are off: the connected line says so, command frames and the commands part of a summary print nothing, other lines still arrive", async () => {
  assert.deepEqual(await commandRun({}), [
    `${CONNECTED} · /claude commands off`,
    "SPD-1 · status todo→done · @ann · ev=s1",
    "SPD-1 · mention · @ann · ev=n1",
    NOTES,
    "2 cards → done · @x",
  ]);
});

for (const v of ["on", "1", "true", " ON "]) {
  test(`SPRINTREE_COMMANDS=${JSON.stringify(v)} turns commands on: the command line prints, the summary keeps its commands part, the connected line has no suffix`, async () => {
    assert.deepEqual(await commandRun({ SPRINTREE_COMMANDS: v }), [
      CONNECTED,
      "SPD-1 · status todo→done · @ann · ev=s1",
      "SPD-1 · /claude command · comment=c1 · ev=c1",
      "SPD-1 · mention · @ann · ev=n1",
      "while you were away: 3 /claude commands",
      `${NOTES}, 1 /claude command`,
      "2 cards → done · @x",
    ]);
  });
}

for (const v of ["off", "yes", "", "0"]) {
  test(`SPRINTREE_COMMANDS=${JSON.stringify(v)} keeps commands off`, async () => {
    const lines = await commandRun({ SPRINTREE_COMMANDS: v });
    assert.equal(lines[0], `${CONNECTED} · /claude commands off`);
    assert.ok(!lines.some((l) => l.includes("/claude command ")) && !lines.some((l) => l.includes("/claude commands") && l !== lines[0]));
    assert.equal(lines.length, 5);
  });
}

test("commandsOn and formatEvent({ commands })", () => {
  assert.equal(commandsOn({}), false);
  assert.equal(commandsOn({ SPRINTREE_COMMANDS: "True" }), true);
  assert.equal(commandsOn({ SPRINTREE_COMMANDS: "yes" }), false);
  const cmd = { type: "command", issue: "SPD-1", comment: "c1", ev: "e1" };
  assert.equal(formatEvent(cmd, { commands: false }), null);
  assert.ok(formatEvent(cmd, { commands: true }).includes("/claude command"));
  assert.equal(formatEvent(cmd), null, "no options: fail closed, a command frame is dropped");
  assert.equal(formatEvent(cmd, {}), null);
  assert.equal(formatEvent({ type: "summary", mentions: 0, status: 0, commands: 2 }, { commands: false }), null);
  assert.equal(formatEvent({ type: "summary", mentions: 1, status: 0, commands: 2 }, { commands: false }), `${NOTES.replace("2 notifications", "1 notification")}`);
  assert.ok(formatEvent({ type: "summary", mentions: 1, status: 0, commands: 2 }, { commands: true }).endsWith("2 /claude commands"));
  const st = { type: "status", issue: "SPD-1", from: "a", to: "b", actor: "x", ev: "e" };
  assert.equal(formatEvent(st, { commands: false }), formatEvent(st));
});

// --- per-session /claude commands (SPD-1360): the setting files, the reconnect on change, command_skipped, the ack ---

const SID = "sess-1360";
/** A config directory of its own (so a test can prepare files before the monitor starts) and the env that points the monitor at it. */
function cfgEnv(extra = {}) {
  const cfg = path.join(tmpDir("sa-listen-cfg-"), "cfg");
  const env = { XDG_CONFIG_HOME: cfg, CLAUDE_CODE_SESSION_ID: SID };
  return { cfg, env: { ...env, ...extra }, sess: sessionFile(env), def: defaultFile(env), ack: ackFile(env) };
}
const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
};
const setSession = (file, v) => put(file, JSON.stringify({ commands: v, at: new Date().toISOString() }));
const waitFor = async (cond, ms = 8000) => {
  const stop = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > stop) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const CMD = { type: "command", issue: "SPD-1", comment: "c1" };

test("toggling the session file reconnects without a restart: the new connect carries X-Stream-Commands and Last-Event-ID, one line says what changed, the command frames follow the switch", { skip: !posix }, async () => {
  const c = cfgEnv();
  setSession(c.sess, "off");
  const srv = await fake((req, res, n) => sse(res, frame("hello", HELLO, `h${n}`), frame("sprintree", { ...CMD, ev: `e${n}` }, `c${n}`)));
  const p = start(srv.url, c.env);
  try {
    await p.until(1);
    assert.equal(p.lines[0], `${CONNECTED} · /claude commands off`);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(srv.requests.length, 1, "no reconnect without a change");
    setSession(c.sess, "on");
    await p.until(3);
    assert.deepEqual(p.lines.slice(1), ["sprintree-events /claude commands on", "SPD-1 · /claude command · comment=c1 · ev=e2"]);
    assert.equal(srv.requests.length, 2);
    assert.deepEqual(srv.requests.map((r) => r.headers["x-stream-commands"]), ["off", "on"]);
    assert.equal(srv.requests[1].headers["last-event-id"], "c1");
    setSession(c.sess, "off");
    await p.until(4);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(p.lines[3], "sprintree-events /claude commands off");
    assert.equal(p.lines.length, 4, "the command frame of the third connection is not printed");
    assert.deepEqual(srv.requests.map((r) => r.headers["x-stream-commands"]), ["off", "on", "off"]);
    assert.equal(srv.requests[2].headers["last-event-id"], "c2");
    assert.equal(srv.requests.length, 3, "a switch is not a failure: no backoff loop");
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("a session file written after the monitor started (no file at start) is picked up; deleting it falls back to off", { skip: !posix }, async () => {
  const c = cfgEnv();
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO, "h")));
  const p = start(srv.url, c.env);
  try {
    await p.until(1);
    setSession(c.sess, "on");
    await p.until(2);
    assert.equal(p.lines[1], "sprintree-events /claude commands on");
    await waitFor(() => srv.requests.length === 2);
    assert.equal(srv.requests[1].headers["x-stream-commands"], "on");
    unlinkSync(c.sess);
    await p.until(3);
    assert.equal(p.lines[2], "sprintree-events /claude commands off");
    await waitFor(() => srv.requests.length === 3);
    assert.equal(srv.requests[2].headers["x-stream-commands"], "off");
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("the default file beats SPRINTREE_COMMANDS and sets the header; the session file beats the default", { skip: !posix }, async () => {
  const c = cfgEnv({ SPRINTREE_COMMANDS: "on" });
  put(c.def, "off\n");
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO, "h"), frame("sprintree", { ...CMD, ev: "e1" }, "c1")));
  const p = start(srv.url, c.env);
  try {
    await p.until(1);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(p.lines, [`${CONNECTED} · /claude commands off`], "env says on, the default says off: the command is not printed");
    assert.equal(srv.requests[0].headers["x-stream-commands"], "off");
    setSession(c.sess, "on");
    await p.until(3);
    assert.equal(p.lines[2], "SPD-1 · /claude command · comment=c1 · ev=e1");
    assert.equal(srv.requests[1].headers["x-stream-commands"], "on");
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("without any file SPRINTREE_COMMANDS still works and is sent as the header", async () => {
  for (const [v, h] of [["on", "on"], ["", "off"]]) {
    const c = cfgEnv({ SPRINTREE_COMMANDS: v });
    const srv = await fake((req, res) => sse(res, frame("hello", HELLO, "h")));
    const p = start(srv.url, c.env);
    try {
      await p.until(1);
      assert.equal(srv.requests[0].headers["x-stream-commands"], h);
    } finally {
      await p.quit();
      await srv.close();
    }
  }
});

test("an old server (no commands in hello, ignores the header) that still sends commands: off hides the command and the commands part of a summary", { skip: !posix }, async () => {
  const c = cfgEnv({ SPRINTREE_COMMANDS: "on" });
  setSession(c.sess, "off");
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO, 1), frame("sprintree", { ...CMD, ev: "e1" }, 2), frame("sprintree", { type: "summary", mentions: 0, status: 0, commands: 3 }, 3), frame("sprintree", { type: "batch", count: 2, to: "done", actor: "x" }, 4)));
  const p = start(srv.url, c.env);
  try {
    await p.until(2);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(p.lines, [`${CONNECTED} · /claude commands off`, "2 cards → done · @x"]);
    await waitFor(() => existsSync(c.ack));
    assert.equal(JSON.parse(readFileSync(c.ack, "utf8")).commands, null, "an old server sends no value: the ack says null");
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("hello commands is written to the ack file (0600) every time, a stale ack of an earlier run is removed at start", { skip: !posix }, async () => {
  const c = cfgEnv();
  put(c.ack, JSON.stringify({ commands: false }));
  let staleAtConnect = null;
  const srv = await fake((req, res, n) => {
    if (n === 1) staleAtConnect = existsSync(c.ack);
    sse(res, frame("hello", { ...HELLO, commands: n === 1 }, `h${n}`));
  });
  const p = start(srv.url, c.env);
  try {
    await p.until(1);
    assert.equal(staleAtConnect, false, "the stale ack is gone before the first connect");
    await waitFor(() => existsSync(c.ack) && JSON.parse(readFileSync(c.ack, "utf8")).commands === true);
    assert.equal(statSync(c.ack).mode & 0o777, 0o600);
    setSession(c.sess, "on");
    await waitFor(() => srv.requests.length === 2 && JSON.parse(readFileSync(c.ack, "utf8")).commands === false);
    assert.ok(!readFileSync(c.ack, "utf8").includes(TOKEN));
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("a command_skipped frame prints one fixed line with the key, no comment text; the key goes through safeLine and a bad one is dropped", async () => {
  const c = cfgEnv();
  const srv = await fake((req, res) =>
    sse(
      res,
      frame("hello", HELLO, 1),
      frame("sprintree", { type: "command_skipped", issue: "SPD-7", ev: "k1", comment: "secret text" }, 2),
      frame("sprintree", { type: "command_skipped", issue: "SPD-7", ev: "k1" }, 3),
      frame("sprintree", { type: "command_skipped", issue: TOKEN, ev: "k2" }, 4),
      frame("sprintree", { type: "command_skipped", issue: "SPD-8\nSPD-9", ev: "k3" }, 5),
      frame("sprintree", { type: "command_skipped", ev: "k4" }, 6)
    )
  );
  const p = start(srv.url, c.env);
  try {
    await p.until(3);
    await new Promise((r) => setTimeout(r, 200));
    const tail = " skipped · /claude commands are off in this session";
    assert.deepEqual(p.lines.slice(1), [`sprintree-events /claude command on SPD-7${tail}`, `sprintree-events /claude command on [token]${tail}`]);
    assert.ok(!p.lines.join("\n").includes("secret") && !p.lines.join("\n").includes(BODY));
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("at start, files older than 30 days with the session-file name are deleted; other names and recent files stay", { skip: !posix }, async () => {
  const c = cfgEnv();
  const dir = path.dirname(c.sess);
  const old = path.join(dir, "11111111-2222-5333-8444-555555555555.json");
  const oldAck = path.join(dir, "11111111-2222-5333-8444-555555555555.ack");
  const fresh = path.join(dir, "aaaaaaaa-2222-5333-8444-555555555555.json");
  const other = path.join(dir, "notes.json");
  for (const f of [old, fresh]) put(f, '{"commands":"on"}');
  for (const f of [oldAck, other]) put(f, "{}");
  const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  const offOld = path.join(dir, "bbbbbbbb-2222-5333-8444-555555555555.json");
  put(offOld, '{"commands":"off"}');
  for (const f of [old, oldAck, other, offOld]) utimesSync(f, past, past);
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO, "h")));
  const p = start(srv.url, c.env);
  try {
    await p.until(1);
    assert.deepEqual([old, oldAck, fresh, other, offOld].map(existsSync), [false, false, true, true, true]);
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("a loose session file turns commands off in the monitor too (no fall-through to env)", { skip: !posix }, async () => {
  const c = cfgEnv({ SPRINTREE_COMMANDS: "on" });
  setSession(c.sess, "on");
  chmodSync(c.sess, 0o644);
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO, "h"), frame("sprintree", { ...CMD, ev: "e1" }, "c1")));
  const p = start(srv.url, c.env);
  try {
    await p.until(1);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(p.lines, [`${CONNECTED} · /claude commands off`]);
    assert.equal(srv.requests[0].headers["x-stream-commands"], "off");
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("the sweep keeps an old session file that is loose, malformed or unreadable as JSON, and still deletes an old clean on", { skip: !posix }, async () => {
  const c = cfgEnv();
  const dir = path.dirname(c.sess);
  const name = (x) => path.join(dir, `${x.repeat(8)}-2222-5333-8444-555555555555.json`);
  const [loose, bad, notObj, on] = [name("c"), name("d"), name("e"), name("f")];
  put(loose, '{"commands":"on"}');
  chmodSync(loose, 0o644);
  put(bad, "{not json");
  put(notObj, "null");
  put(on, '{"commands":"on"}');
  const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  for (const f of [loose, bad, notObj, on]) utimesSync(f, past, past);
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO, "h")));
  const p = start(srv.url, c.env);
  try {
    await p.until(1);
    assert.deepEqual([loose, bad, notObj, on].map(existsSync), [true, true, true, false]);
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("at start the own session file's mtime is refreshed, so a setting turned on 31+ days ago survives, and the refresh does not reconnect", { skip: !posix }, async () => {
  const c = cfgEnv();
  setSession(c.sess, "on");
  const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  utimesSync(c.sess, past, past);
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO, "h")));
  const p = start(srv.url, c.env);
  try {
    await p.until(1);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(existsSync(c.sess));
    assert.ok(Date.now() - statSync(c.sess).mtimeMs < 60_000, "mtime refreshed");
    assert.equal(srv.requests.length, 1, "no reconnect");
    assert.deepEqual(p.lines, [CONNECTED]);
  } finally {
    await p.quit();
    await srv.close();
  }
});

test("a stat error on the session directory (EACCES) reads as off and does not kill the monitor", { skip: !posix || process.getuid?.() === 0 }, async () => {
  const c = cfgEnv();
  setSession(c.sess, "on");
  const dir = path.dirname(c.sess);
  const srv = await fake((req, res) => sse(res, frame("hello", HELLO, "h")));
  const p = start(srv.url, c.env);
  try {
    await p.until(1);
    chmodSync(dir, 0o000);
    await p.until(2);
    assert.equal(p.lines[1], "sprintree-events /claude commands off");
    assert.equal(p.child.exitCode, null, "the monitor is still running");
  } finally {
    chmodSync(dir, 0o700);
    await p.quit();
    await srv.close();
  }
});
