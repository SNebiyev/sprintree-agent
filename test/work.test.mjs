import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "skills", "sprintree", "scripts", "work.mjs");
const FIXTURE = path.join(ROOT, "test", "fixtures", "work");
const NO_NET = path.join(ROOT, "test-support", "no-network.cjs");
const SESSION = "sess-fixture-0001";
const SECRET = "hunter2-not-a-real-secret";

// A fixed identity through the environment, so the test repos commit on a machine with no git config (CI).
const WHO = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };
// Commits dated 2020, so a --since after that leaves them out (git's date parser breaks on far-future years).
const OLD = { GIT_AUTHOR_DATE: "2020-06-01T12:00:00Z", GIT_COMMITTER_DATE: "2020-06-01T12:00:00Z" };
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...WHO, ...OLD } }).trim();

/** A temp HOME with a repo under it and the project folder Claude Code would use for that repo: ~/.claude/projects/<key>. */
function setup() {
  const home = mkdtempSync(path.join(tmpdir(), "work-"));
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  const top = git(repo, "rev-parse", "--show-toplevel");
  const proj = path.join(home, ".claude", "projects", top.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(proj, { recursive: true });
  return { home, repo, proj };
}

function run(env, args) {
  const r = spawnSync(process.execPath, ["--require", NO_NET, SCRIPT, "usage", ...args], {
    cwd: env.repo,
    encoding: "utf8",
    env: { ...process.env, HOME: env.home, USERPROFILE: env.home, CLAUDE_CODE_SESSION_ID: "", ...(env.vars ?? {}) },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

const withFixture = () => {
  const e = setup();
  cpSync(FIXTURE, e.proj, { recursive: true });
  return e;
};
const byModel = (j) => Object.fromEntries(j.usage.map((u) => [u.model, u]));
const weight = (u) => u.input + u.output + u.cache_write;

// Expected numbers by hand (pcc-cost.py's rule: each message id once, from the record with the largest output;
// tokens = input + cache_creation + output; cache reads are reported, not counted):
//   msg_A opus, 3 records with outputs 5, 120, 80             -> in 10, out 120, cache_write 1000, cache_read 5000
//   msg_C opus                                                 -> in 4, out 50, cache_write 200, cache_read 6000
//   msg_B sonnet (main) + msg_E sonnet (subagent a2)           -> in 20 + 3, out 300 + 30, cache_write 0 + 300, cache_read 2000
//   msg_D haiku (subagent a1, 2 records with outputs 30, 70)   -> in 7, out 70, cache_write 700, cache_read 100
const OPUS = { model: "claude-opus-fake", input: 14, output: 170, cache_write: 1200, cache_read: 11000 };
const SONNET = { model: "claude-sonnet-fake", input: 23, output: 330, cache_write: 300, cache_read: 2000 };
const HAIKU = { model: "claude-haiku-fake", input: 7, output: 70, cache_write: 700, cache_read: 100 };

test("work usage: per model totals count a streamed message once, include the subagents, and follow the pcc-cost.py rule", () => {
  const e = withFixture();
  const r = run(e, ["--session", SESSION]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  assert.deepEqual(r.json.usage, [OPUS, HAIKU, SONNET].sort((a, b) => weight(b) - weight(a)), "the biggest model first");
  assert.equal(r.json.agent, "claude-code");
  assert.equal(r.json.subagents, 2);
  assert.equal(r.json.duration_minutes, 120);
  assert.deepEqual(r.json.commits, []);
  assert.deepEqual(Object.keys(r.json).sort(), ["agent", "commits", "duration_minutes", "subagents", "usage"]);
  assert.equal(r.json.usage.reduce((n, u) => n + weight(u), 0), 1384 + 777 + 653);
});

test("work usage: --since keeps only the lines at or after that time (models, subagents, duration)", () => {
  const e = withFixture();
  const r = run(e, ["--session", SESSION, "--since", "2026-10-28T10:00:00Z"]);
  assert.equal(r.code, 0);
  const m = byModel(r.json);
  assert.deepEqual(m["claude-opus-fake"], { model: "claude-opus-fake", input: 4, output: 50, cache_write: 200, cache_read: 6000 });
  assert.deepEqual(m["claude-sonnet-fake"], SONNET);
  assert.equal(m["claude-haiku-fake"], undefined, "the haiku subagent worked before --since");
  assert.equal(r.json.subagents, 1);
  assert.equal(r.json.duration_minutes, 30);
  assert.equal(run(e, ["--session", SESSION, "--since", "2026-10-28T10:30:00.000Z"]).json.duration_minutes, 30, "a line at the boundary counts");
});

test("work usage: the session is --session, else CLAUDE_CODE_SESSION_ID, else the newest transcript of the project folder", () => {
  const e = withFixture();
  const line = { type: "assistant", timestamp: "2026-10-28T12:00:00Z", message: { id: "m1", model: "m-other", usage: { input_tokens: 1, output_tokens: 2 } } };
  writeFileSync(path.join(e.proj, "newer-session.jsonl"), `${JSON.stringify(line)}\n`);
  const named = { ...e, vars: { CLAUDE_CODE_SESSION_ID: SESSION } };
  assert.equal(run(named, []).json.usage.length, 3, "the env var names the fixture session");
  assert.deepEqual(run(named, ["--session", "newer-session"]).json.usage, [{ model: "m-other", input: 1, output: 2, cache_write: 0, cache_read: 0 }], "the flag wins over the env var");
  assert.deepEqual(run(e, []).json.usage.map((u) => u.model), ["m-other"], "no flag, no env var: the newest *.jsonl");
  const missing = run({ ...e, vars: { CLAUDE_CODE_SESSION_ID: "no-such-session" } }, []);
  assert.match(missing.err, /usage unavailable/);
  assert.deepEqual(missing.json.usage, [], "a named session that is not there is not replaced by another one");
  assert.match(run(e, ["--session", "../x"]).err, /usage unavailable/, "a session id is a plain name, never a path");
});

test("work usage: keeps the 5 biggest models and says how many were left out", () => {
  const e = setup();
  const lines = [];
  for (let i = 1; i <= 7; i++) {
    lines.push(JSON.stringify({ type: "assistant", timestamp: `2026-10-28T09:0${i}:00Z`, message: { id: `m${i}`, model: `model-${i}`, usage: { input_tokens: i * 10, output_tokens: 1 } } }));
  }
  writeFileSync(path.join(e.proj, "s.jsonl"), `${lines.join("\n")}\n`);
  const r = run(e, ["--session", "s"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.usage.map((u) => u.model), ["model-7", "model-6", "model-5", "model-4", "model-3"]);
  assert.match(r.err, /2 more model\(s\) left out/);
});

test("work usage: no message text reaches the output", () => {
  const e = withFixture();
  assert.ok(readFileSync(path.join(FIXTURE, `${SESSION}.jsonl`), "utf8").includes(SECRET), "the fixture really carries the secret-looking string");
  const r = run(e, ["--session", SESSION, "--key", "SPD-1"]);
  assert.ok(!r.out.includes(SECRET));
  assert.ok(!r.err.includes(SECRET));
  assert.ok(!r.out.includes("working on it"));
});

test("work usage: an unknown format or no transcripts is `usage unavailable` on stderr, an empty usage and exit 0", () => {
  const e = setup();
  writeFileSync(path.join(e.proj, "odd.jsonl"), '{"type":"assistant","message":{"role":"assistant","content":"hi"}}\n{"hello":1}\n[1,2]\nnot json\n');
  const r = run(e, ["--session", "odd"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /usage unavailable/);
  assert.deepEqual(r.json, { agent: "claude-code", usage: [], commits: [], subagents: 0, duration_minutes: 0 });
  const none = run(setup(), []);
  assert.equal(none.code, 0);
  assert.match(none.err, /usage unavailable/);
  const bare = mkdtempSync(path.join(tmpdir(), "work-n-"));
  const r2 = run({ home: bare, repo: bare }, []);
  assert.equal(r2.code, 0);
  assert.match(r2.err, /usage unavailable/);
});

test("work usage --key: the commits of the repo that name the key, newest first, SHAs only; none without --key", () => {
  const e = withFixture();
  writeFileSync(path.join(e.repo, "a"), "1");
  git(e.repo, "add", "a");
  git(e.repo, "commit", "-q", "-m", "feat: first (SPD-1)");
  const first = git(e.repo, "rev-parse", "HEAD");
  git(e.repo, "commit", "-q", "--allow-empty", "-m", "chore: other card (SPD-2)");
  git(e.repo, "commit", "-q", "--allow-empty", "-m", "fix: second (SPD-1)");
  const second = git(e.repo, "rev-parse", "HEAD");
  assert.deepEqual(run(e, ["--session", SESSION, "--key", "SPD-1"]).json.commits, [second, first]);
  assert.deepEqual(run(e, ["--session", SESSION]).json.commits, []);
  assert.deepEqual(run(e, ["--session", SESSION, "--key", "SPD-9"]).json.commits, []);
  assert.deepEqual(run(e, ["--session", SESSION, "--key", "SPD-1", "--since", "2021-01-01T00:00:00Z"]).json.commits, [], "--since applies to the commits too");
  assert.deepEqual(run(e, ["--session", SESSION, "--key", "SPD-1", "--since", "2019-01-01T00:00:00Z"]).json.commits, [second, first]);
  git(e.repo, "commit", "-q", "--allow-empty", "-m", "feat: longer key (SPD-10)");
  git(e.repo, "commit", "-q", "--allow-empty", "-m", "feat: other project (XSPD-1)");
  assert.deepEqual(run(e, ["--session", SESSION, "--key", "SPD-1"]).json.commits, [second, first], "SPD-1 does not match SPD-10 or XSPD-1");
  assert.equal(run(e, ["--session", SESSION, "--key", "SPD-10"]).json.commits.length, 1);
  const many = setup();
  for (let i = 0; i < 25; i++) git(many.repo, "commit", "-q", "--allow-empty", "-m", `c${i} SPD-1`);
  assert.equal(run(many, ["--key", "SPD-1"]).json.commits.length, 20, "at most 20");
  assert.equal(run(e, ["--key", "x; rm -rf"]).code, 2, "a key that is not a card key is refused");
});

test("work usage: offline - nothing in the script touches fetch, sockets, http(s) or DNS", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(!/from "node:(?:net|tls|http2?|https|dns|dgram)"|\brequire\(|\bfetch\(|undici|XMLHttpRequest|WebSocket/.test(src), "no network module or call in work.mjs");
  assert.ok(!/from "\.\/st\.mjs"/.test(src), "work.mjs does not pull in the client");
  // negative control: the preload really fails on network use, so the run below proves something
  const probe = spawnSync(process.execPath, ["--require", NO_NET, "-e", "fetch('http://127.0.0.1:9/')"], { encoding: "utf8" });
  assert.notEqual(probe.status, 0);
  assert.match(probe.stderr, /network use: fetch/);
  assert.equal(run(withFixture(), ["--session", SESSION, "--key", "SPD-1"]).code, 0, "runs to the end with the network blocked");
});

test("work usage: bad arguments exit 2 with a message", () => {
  const e = withFixture();
  assert.equal(run(e, ["--since", "yesterday"]).code, 2);
  assert.equal(run(e, ["--nope", "1"]).code, 2);
  const r = spawnSync(process.execPath, [SCRIPT, "report"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node work\.mjs usage/);
});

test("work usage: the session file is found when the session runs from another project folder (a worktree), not another session's numbers", () => {
  const e = withFixture();
  const wt = path.join(e.repo, ".claude", "worktrees", "x");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, "f"), "1");
  git(wt, "init", "-q");
  const other = path.join(e.home, ".claude", "projects", wt.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, "other-session.jsonl"), "{}\n");
  const r = spawnSync(process.execPath, ["--require", NO_NET, SCRIPT, "usage", "--session", SESSION], {
    cwd: wt,
    encoding: "utf8",
    env: { ...process.env, HOME: e.home, USERPROFILE: e.home, CLAUDE_CODE_SESSION_ID: "" },
  });
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).usage.length > 0, "found in the repo's folder although cwd is the worktree");
  const none = spawnSync(process.execPath, ["--require", NO_NET, SCRIPT, "usage", "--session", "missing-id"], { cwd: wt, encoding: "utf8", env: { ...process.env, HOME: e.home, USERPROFILE: e.home, CLAUDE_CODE_SESSION_ID: "" } });
  assert.match(none.stderr, /usage unavailable/, "an unknown id never falls back to another session");
});
