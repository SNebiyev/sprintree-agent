// connect.mjs (/sprintree:connect, the device flow) against a fake server on 127.0.0.1 (port 0).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { BODY, ROOT, childEnv, tmpDir } from "../test-support/helpers.mjs";
import { clientName } from "../skills/sprintree/scripts/connect.mjs";

const SCRIPT = path.join(ROOT, "skills", "sprintree", "scripts", "connect.mjs");
const TOKEN = `itns_${BODY}`;
// Node 18 prints an ExperimentalWarning about fetch on stderr first: the script's own message is the last line
const lastLine = (text) => text.trim().split("\n").pop();
const DEADLINE_EXPIRED = "The code expired. Run /sprintree:connect again. If you approved it, revoke the unused stream token in Settings > API & MCP > Personal access tokens.";
const posix = process.platform !== "win32";

/** `tokenAnswers`: what POST /api/stream/device/token answers in turn, as [status, json]; the last one repeats. */
/** The default start answer gives the full 570-unit window (the cap), so a slow runner does not hit the deadline in a test that waits for a token; tests meant to reach the deadline pass their own expires_in. */
async function fake(tokenAnswers, start = {}, minGapMs = 0) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push({ at: Date.now(), url: req.url, method: req.method, body: body ? JSON.parse(body) : null, headers: req.headers });
      const send = (status, json) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
      if (req.url === "/api/stream/device") {
        const origin = `http://127.0.0.1:${server.address().port}`;
        return send(200, { device_code: "dev-code-1", user_code: "ABCD-1234", verification_uri: `${origin}/connect`, verification_uri_complete: `${origin}/connect?code=ABCD-1234`, interval: 1, expires_in: 570, ...start });
      }
      const n = calls.filter((c) => c.url === "/api/stream/device/token").length;
      const prev = calls.filter((c) => c.url === "/api/stream/device/token").at(-2); // the real server answers slow_down to a poll that comes too soon
      if (prev && calls.at(-1).at - prev.at < minGapMs) return send(400, env("slow_down"));
      const [status, json, raw] = typeof tokenAnswers === "function" ? tokenAnswers(n, calls) : tokenAnswers[Math.min(n, tokenAnswers.length) - 1];
      if (status === "drop") return req.socket.destroy(); // a network error
      if (raw !== undefined) return res.writeHead(status, { "Content-Type": "text/plain" }).end(raw); // a body that is not JSON
      send(status, json);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => (server.closeAllConnections?.(), new Promise((r) => server.close(r))) };
}

async function run(srv, { home = tmpDir("sa-connect-"), extra = {} } = {}) {
  const env = childEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "cfg"), SPRINTREE_URL: srv.url, SPRINTREE_CONNECT_TEST_SECOND_MS: "5", SPRINTREE_CONNECT_NO_BROWSER: "1", SPRINTREE_STREAM_TOKEN: "", ...extra });
  const child = spawn(process.execPath, [SCRIPT], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("exit", r));
  const exitAt = Date.now();
  return { code, exitAt, out, err, file: path.join(home, "cfg", "sprintree", "stream-token"), dir: path.join(home, "cfg", "sprintree") };
}

// The real server envelope: {"error":{"kind","code","message"}}.
const env = (code) => ({ error: { kind: "bad_request", code, message: `server says ${code}` } });

test("pending, then slow_down, then the token: the link and code are printed, the token is saved 0600 and never printed", async () => {
  const srv = await fake([
    [400, env("authorization_pending")],
    [400, env("slow_down")],
    [400, env("authorization_pending")],
    [200, { token: TOKEN }],
  ]);
  try {
    const r = await run(srv);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split("\n");
    assert.equal(lines[0], `Open ${srv.url}/connect?code=ABCD-1234 and check that it shows the code ABCD-1234, then approve.`);
    assert.equal(lines[1], "Connected. Restart this Claude Code session to start live events (monitors start with the session).");
    assert.equal(lines.length, 2);
    assert.equal(readFileSync(r.file, "utf8"), `${TOKEN}\n`);
    if (posix) {
      assert.equal(statSync(r.file).mode & 0o777, 0o600);
      assert.equal(statSync(r.dir).mode & 0o777, 0o700);
    }
    assert.deepEqual(readdirSync(r.dir), ["stream-token"], "no temp file is left");
    assert.ok(!(r.out + r.err).includes(BODY));
    const [start, ...polls] = srv.calls;
    assert.equal(start.url, "/api/stream/device");
    assert.match(start.body.client_name, /^[A-Za-z0-9._-]{1,100}$/);
    assert.equal(polls.length, 4);
    assert.ok(polls.every((c) => c.url === "/api/stream/device/token" && c.body.device_code === "dev-code-1"));
  } finally {
    await srv.close();
  }
});

test("an existing token file is replaced, and the output says so and points at revoking the old token", async () => {
  const home = tmpDir("sa-connect-");
  const dir = path.join(home, "cfg", "sprintree");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "stream-token"), "itns_old-token\n");
  const srv = await fake([[200, { token: TOKEN }]]);
  try {
    const r = await run(srv, { home });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /replaced the previous token.*revoke the old one in Settings > API & MCP > Personal access tokens/);
    assert.equal(readFileSync(r.file, "utf8"), `${TOKEN}\n`);
  } finally {
    await srv.close();
  }
});

for (const [name, answer, message] of [
  ["denied", [400, env("access_denied")], "Denied in the browser. Nothing was saved."],
  ["expired", [400, env("expired_token")], "The code expired. Run /sprintree:connect again."],
  ["a token without the itns_ prefix", [200, { token: `itn_${BODY}` }], "The server answered without a usable token. Nothing was saved."],
  ["too many tokens", [409, { error: { kind: "conflict", code: "too_many_tokens", message: "20" } }], "This account already has 20 stream tokens. Revoke one in Settings, then run /sprintree:connect again."],
  ["a refusal", [403, {}], "The server refused the connection (HTTP 403). Nothing was saved."],
]) {
  test(`${name}: exit 1, one message, no file, no token`, async () => {
    const srv = await fake([answer]);
    try {
      const r = await run(srv);
      assert.equal(r.code, 1);
      assert.equal(lastLine(r.err), message);
      assert.ok(!existsSync(r.file));
      assert.ok(!(r.out + r.err).includes(BODY));
    } finally {
      await srv.close();
    }
  });
}

test("a 502, a dropped connection and a 408 during the poll are waited out, then the token arrives", async () => {
  const srv = await fake([[502, {}], ["drop", null], [408, {}], [200, { token: TOKEN }]]);
  try {
    const r = await run(srv);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Connected\./);
    assert.equal(readFileSync(r.file, "utf8"), `${TOKEN}\n`);
    assert.equal(srv.calls.filter((c) => c.url === "/api/stream/device/token").length, 4);
  } finally {
    await srv.close();
  }
});

test("a server that keeps answering 502 ends with the expired message at the deadline", async () => {
  const srv = await fake([[502, {}]], { expires_in: 3 });
  try {
    const r = await run(srv);
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.err), DEADLINE_EXPIRED);
    assert.ok(!existsSync(r.file));
  } finally {
    await srv.close();
  }
});

test("the old flat error shapes are still understood as a fallback", async () => {
  const srv = await fake([[400, { code: "authorization_pending" }], [400, { error: "slow_down" }], [200, { token: TOKEN }]]);
  try {
    const r = await run(srv);
    assert.equal(r.code, 0, r.err);
  } finally {
    await srv.close();
  }
});

test("pending until expires_in ends: the code expired, exit 1", async () => {
  const srv = await fake([[400, env("authorization_pending")]], { interval: 1, expires_in: 4 });
  try {
    const r = await run(srv);
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.err), DEADLINE_EXPIRED);
  } finally {
    await srv.close();
  }
});

test("SPRINTREE_URL must be https: plain http to another host is refused before any request", async () => {
  const r = await run({ url: "http://example.com" });
  assert.equal(r.code, 1);
  assert.match(r.err, /SPRINTREE_URL must be https/);
});

test("the client name is the host name reduced to [A-Za-z0-9._-], at most 100 characters", () => {
  assert.equal(clientName("Samir's MacBook (2)"), "Samir-s-MacBook--2-");
  assert.equal(clientName("a".repeat(150)).length, 100);
  assert.equal(clientName(""), "computer");
});

const tokenCalls = (srv) => srv.calls.filter((c) => c.url === "/api/stream/device/token");

test("expires_in 3600 is capped at 570 units: pending answers end with the expired message right after them", async () => {
  const srv = await fake([[400, env("authorization_pending")]], { interval: 1, expires_in: 3600 });
  try {
    const r = await run(srv); // 5 ms per unit: 570 units are 2850 ms
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.err), DEADLINE_EXPIRED);
    // server-observed times only: the deadline counts from the process start, which is before the start POST arrives
    const start = srv.calls[0];
    const polls = tokenCalls(srv);
    assert.ok(polls.at(-1).at - start.at < 570 * 5, `last poll at ${polls.at(-1).at - start.at} ms`);
    assert.ok(polls.at(-1).at - start.at > 400 * 5, "the polls ran to the end of the window");
    assert.ok(r.exitAt - start.at < 570 * 5 + 30, `closed at ${r.exitAt - start.at} ms`);
  } finally {
    await srv.close();
  }
});

test("transient errors grow the interval (at most 60 units) and the run still ends at the deadline, not one long sleep later", async () => {
  const srv = await fake([[502, {}]], { interval: 1, expires_in: 3600 });
  try {
    const r = await run(srv, { extra: { SPRINTREE_CONNECT_TEST_SECOND_MS: "10" } }); // 570 units are 5700 ms
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.err), DEADLINE_EXPIRED);
    const start = srv.calls[0];
    const polls = tokenCalls(srv);
    assert.ok(polls.length >= 10);
    // without the capped sleep the 16th uncapped step falls at 616 units; a regression that only drops the cap polls after 570
    assert.ok(polls.at(-1).at - start.at < 570 * 10, `last poll at ${polls.at(-1).at - start.at} ms`);
    assert.ok(r.exitAt - start.at < 570 * 10 + 30, `closed at ${r.exitAt - start.at} ms`);
  } finally {
    await srv.close();
  }
});

test("an approval in the last poll interval before the deadline is still fetched and saved", async () => {
  // 10 ms per unit, interval 20 units, expires_in 60: the deadline is 600 ms, the plain polls fall at ~200 and ~400 ms
  const srv = await fake((n, calls) => (Date.now() - calls[0].at >= 450 ? [200, { token: TOKEN }] : [400, env("authorization_pending")]), { interval: 20, expires_in: 60 }, 30); // 3 units between polls
  try {
    const r = await run(srv, { extra: { SPRINTREE_CONNECT_TEST_SECOND_MS: "10" } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Connected\./);
    assert.equal(readFileSync(r.file, "utf8"), `${TOKEN}\n`);
  } finally {
    await srv.close();
  }
});

test("a 200 whose body is not JSON: exit 1, the message says to revoke the unused stream token, nothing is saved", async () => {
  const srv = await fake([[200, null, "<html>oops</html>"]]);
  try {
    const r = await run(srv);
    assert.equal(r.code, 1);
    assert.match(lastLine(r.err), /may have been created\. Revoke the unused stream token in Settings > API & MCP > Personal access tokens/);
    assert.ok(!existsSync(r.file));
    assert.equal(tokenCalls(srv).length, 1, "no retry");
  } finally {
    await srv.close();
  }
});
