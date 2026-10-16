// commands.mjs (/sprintree:commands) and readCommandsState: run as the command file runs it, with its own XDG_CONFIG_HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { BODY, ROOT, childEnv, tmpDir } from "../test-support/helpers.mjs";
import { ackFile, defaultFile, readCommandsState, sessionFile } from "../skills/sprintree/scripts/stream-common.mjs";
import { parseArgs } from "../skills/sprintree/scripts/commands.mjs";

const SCRIPT = path.join(ROOT, "skills", "sprintree", "scripts", "commands.mjs");
const posix = process.platform !== "win32";

function setup(extra = {}) {
  const home = tmpDir("sa-commands-");
  const env = childEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "cfg"), CLAUDE_CODE_SESSION_ID: "sess-1", SPRINTREE_COMMANDS: "", SPRINTREE_STREAM_TOKEN: `itns_${BODY}`, ...extra });
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, cwd: home, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split("\n").filter(Boolean) };
  };
  return { home, env, run };
}
const mode = (f) => statSync(f).mode & 0o777;

test("parseArgs: case-insensitive, extra spaces, empty means status, anything else is null", () => {
  assert.deepEqual(parseArgs(""), { action: "status" });
  assert.deepEqual(parseArgs("  STATUS "), { action: "status" });
  assert.deepEqual(parseArgs("On"), { action: "on" });
  assert.deepEqual(parseArgs("default   OFF"), { action: "default", value: "off" });
  for (const bad of ["maybe", "on off", "default", "default maybe", "on now", "--help", "status on"]) assert.equal(parseArgs(bad), null, bad);
});

test("on and off write the session file, one argument string or several words work, and status follows", { skip: !posix }, () => {
  const { env, run } = setup();
  const file = sessionFile(env);
  let r = run("on");
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["/claude commands on in this session (the monitor reconnects within a few seconds)"]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).commands, "on");
  assert.ok(!Number.isNaN(Date.parse(JSON.parse(readFileSync(file, "utf8")).at)));
  assert.equal(mode(file), 0o600);
  assert.equal(mode(path.dirname(file)), 0o700);
  assert.deepEqual(readdirSync(path.dirname(file)), [path.basename(file)], "no temp file is left");
  assert.equal(readCommandsState(env).value, true);
  assert.equal(readCommandsState(env).source, "session");
  r = run("OFF");
  assert.equal(r.lines[0], "/claude commands off in this session (the monitor reconnects within a few seconds)");
  assert.equal(readCommandsState(env).value, false);
  r = run("  on  ");
  assert.equal(readCommandsState(env).value, true);
});

test("default on and off write the default file (0600) that sessions without their own setting follow", { skip: !posix }, () => {
  const { env, run } = setup();
  let r = run("default", "on");
  assert.equal(r.code, 0);
  assert.match(r.lines[0], /^\/claude commands default on /);
  assert.equal(readFileSync(defaultFile(env), "utf8"), "on\n");
  assert.equal(mode(defaultFile(env)), 0o600);
  assert.deepEqual(readCommandsState(env), { value: true, source: "default" });
  run("default off");
  assert.deepEqual(readCommandsState(env), { value: false, source: "default" });
  run("on");
  run("default off");
  assert.equal(readCommandsState(env).value, true, "the session file beats the default");
});

test("default works without CLAUDE_CODE_SESSION_ID; on and off refuse with one line and exit 0, nothing is written", () => {
  const { env, run, home } = setup({ CLAUDE_CODE_SESSION_ID: "" });
  for (const a of ["on", "off"]) {
    const r = run(a);
    assert.equal(r.code, 0);
    assert.equal(r.lines.length, 1);
    assert.match(r.lines[0], /no Claude Code session id/);
  }
  assert.throws(() => statSync(path.join(home, "cfg")));
  assert.equal(run("default on").code, 0);
  assert.equal(readCommandsState(env).value, true);
});

test("priority: session file, then default file, then SPRINTREE_COMMANDS, then off", { skip: !posix }, () => {
  const { env, run } = setup({ SPRINTREE_COMMANDS: "on" });
  assert.deepEqual(readCommandsState(env), { value: true, source: "env" });
  assert.deepEqual(readCommandsState({ ...env, SPRINTREE_COMMANDS: "off" }), { value: false, source: "env" });
  assert.deepEqual(readCommandsState({ ...env, SPRINTREE_COMMANDS: "" }), { value: false, source: "none" });
  run("default off");
  assert.deepEqual(readCommandsState(env), { value: false, source: "default" }, "the default file beats env");
  run("on");
  assert.deepEqual(readCommandsState(env), { value: true, source: "session" });
  run("default on");
  run("off");
  assert.deepEqual(readCommandsState(env), { value: false, source: "session" }, "a session off beats a default on");
});

test("a file readable or writable by others counts as off and never falls through to a lower source", { skip: !posix }, () => {
  const { env, run } = setup({ SPRINTREE_COMMANDS: "on" });
  run("on");
  for (const m of [0o644, 0o660, 0o606]) {
    chmodSync(sessionFile(env), m);
    assert.deepEqual(readCommandsState(env), { value: false, source: "session", reason: "loose" }, m.toString(8));
  }
  assert.match(run("status").lines[0], /^\/claude commands: off \(this session\) \(the file is readable by others/);
  run("on"); // rewriting through a rename makes it 0600 again
  assert.equal(readCommandsState(env).value, true);
  run("default on");
  chmodSync(defaultFile(env), 0o644);
  chmodSync(sessionFile(env), 0o600);
  writeFileSync(sessionFile(env), "", { mode: 0o600 });
  assert.deepEqual(readCommandsState(env), { value: false, source: "session", reason: "malformed" });
});

test("malformed files count as off with a reason, also the default file; an unknown value is malformed", { skip: !posix }, () => {
  const { env } = setup({ SPRINTREE_COMMANDS: "on" });
  mkdirSync(path.dirname(sessionFile(env)), { recursive: true, mode: 0o700 });
  for (const body of ["{not json", '{"commands":"yes"}', '{"commands":true}', "[]", "null"]) {
    writeFileSync(sessionFile(env), body, { mode: 0o600 });
    assert.deepEqual(readCommandsState(env), { value: false, source: "session", reason: "malformed" }, body);
  }
  /** @type {Record<string,string>} */
  const e2 = { ...env, CLAUDE_CODE_SESSION_ID: "other" };
  writeFileSync(defaultFile(env), "maybe\n", { mode: 0o600 });
  assert.deepEqual(readCommandsState(e2), { value: false, source: "default", reason: "malformed" });
  writeFileSync(defaultFile(env), "ON\r\nsecond line\n", { mode: 0o600 });
  assert.deepEqual(readCommandsState(e2), { value: true, source: "default" });
});

test("status shows the effective state and source, the server's acknowledgement, the default and the env value, with no path or token", { skip: !posix }, () => {
  const { env, run, home } = setup({ SPRINTREE_COMMANDS: "on" });
  let r = run("status");
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["/claude commands: on (SPRINTREE_COMMANDS)", "Server: the monitor has not confirmed yet", "Default: not set", "SPRINTREE_COMMANDS: on"]);
  assert.deepEqual(run("").lines, r.lines, "no argument means status");
  run("off");
  run("default on");
  mkdirSync(path.dirname(ackFile(env)), { recursive: true });
  writeFileSync(ackFile(env), JSON.stringify({ commands: false }), { mode: 0o600 });
  r = run("status");
  assert.deepEqual(r.lines, ["/claude commands: off (this session)", "Server: confirmed off", "Default: on", "SPRINTREE_COMMANDS: on"]);
  writeFileSync(ackFile(env), JSON.stringify({ commands: null }), { mode: 0o600 });
  assert.match(run("status").lines[1], /does not report/);
  for (const a of ["on", "off", "status", "default on", "bogus"]) {
    const o = run(a);
    const all = o.out + o.err;
    assert.ok(!all.includes(BODY) && !all.includes(home) && !all.includes("sessions") && !all.includes(".json"), `${a}: ${all}`);
  }
});

test("status right after a toggle says reconnecting while the ack is older than the setting", { skip: !posix }, () => {
  const { env, run } = setup();
  mkdirSync(path.dirname(ackFile(env)), { recursive: true });
  writeFileSync(ackFile(env), JSON.stringify({ commands: true, at: new Date(Date.now() - 60_000).toISOString() }), { mode: 0o600 });
  run("off");
  assert.equal(run("status").lines[1], "Server: reconnecting (run status again in a few seconds)");
  writeFileSync(ackFile(env), JSON.stringify({ commands: false, at: new Date(Date.now() + 1000).toISOString() }), { mode: 0o600 });
  assert.equal(run("status").lines[1], "Server: confirmed off");
  // the default file: judged by its mtime
  const d = setup();
  mkdirSync(path.dirname(ackFile(d.env)), { recursive: true });
  writeFileSync(ackFile(d.env), JSON.stringify({ commands: true, at: new Date(Date.now() - 60_000).toISOString() }), { mode: 0o600 });
  d.run("default off");
  assert.equal(d.run("status").lines[1], "Server: reconnecting (run status again in a few seconds)");
});

test("status does not say reconnecting when the old ack already agrees with the setting set again", { skip: !posix }, () => {
  const { env, run } = setup();
  mkdirSync(path.dirname(ackFile(env)), { recursive: true });
  writeFileSync(ackFile(env), JSON.stringify({ commands: true, at: new Date(Date.now() - 60_000).toISOString() }), { mode: 0o600 });
  run("on");
  assert.equal(run("status").lines[1], "Server: confirmed on");
  // the default file set to the same value again
  const d = setup();
  mkdirSync(path.dirname(ackFile(d.env)), { recursive: true });
  writeFileSync(ackFile(d.env), JSON.stringify({ commands: false, at: new Date(Date.now() - 60_000).toISOString() }), { mode: 0o600 });
  d.run("default off");
  assert.equal(d.run("status").lines[1], "Server: confirmed off");
});

test("an unknown argument prints one usage line and exits 0", () => {
  const { run } = setup();
  for (const a of [["maybe"], ["default"], ["on", "off"], ["--help"], ["default", "sideways"]]) {
    const r = run(...a);
    assert.equal(r.code, 0, a.join(" "));
    assert.deepEqual(r.lines, ["usage: /sprintree:commands on | off | status | default on | default off"]);
  }
});

test("a config directory that cannot be written gives one clear line and exit 0", { skip: !posix || process.getuid?.() === 0 }, () => {
  const { home, run } = setup();
  mkdirSync(path.join(home, "cfg"), { mode: 0o500 });
  const r = run("on");
  assert.equal(r.code, 0);
  assert.match(r.lines[0], /could not write/);
  assert.ok(!r.out.includes(home));
});
