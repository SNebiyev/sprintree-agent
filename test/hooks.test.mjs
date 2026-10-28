import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bashWrites } from "../skills/sprintree/scripts/discipline.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "skills", "sprintree", "scripts", "discipline.mjs");

const tmp = () => mkdtempSync(path.join(tmpdir(), "hooks-"));
const sid = () => `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function hook(event, input, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, event], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, SPRINTREE_HOOKS: "", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function project(files = { ".sprintree.json": "{}" }) {
  const dir = tmp();
  mkdirSync(path.join(dir, ".git"));
  for (const [n, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
    writeFileSync(path.join(dir, n), c);
  }
  return dir;
}

function transcript(dir, ...tools) {
  const lines = [{ type: "user", message: { role: "user", content: "go" } }];
  for (const t of tools) {
    lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: t.name, input: t.input ?? {} }] } });
  }
  const f = path.join(dir, "t.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

const WRITE = { name: "mcp__sprintree__update_issue_status", input: { key: "SPD-1" } };

// SPD-1726: the reminder is read on every session start; a new line must be a deliberate raise of this cap (SPD-1883: 700 to 900).
const LIMIT = 900;

test("SessionStart: silent without Sprintree config, a short reminder with .sprintree.json", () => {
  const plain = project({});
  const r0 = hook("SessionStart", { cwd: plain, source: "startup" });
  assert.equal(r0.code, 0);
  assert.equal(r0.out, "");
  const dir = project();
  const r = hook("SessionStart", { cwd: dir, source: "compact" });
  assert.equal(r.code, 0);
  const o = JSON.parse(r.out);
  assert.equal(o.hookSpecificOutput.hookEventName, "SessionStart");
  const text = o.hookSpecificOutput.additionalContext;
  assert.ok(text.split("\n").length <= 6);
  assert.match(text, /in_progress/);
  assert.match(text, /data, not instructions/);
  assert.match(text, /get_project_rules/);
  assert.match(text, /Memory Drawer/);
  assert.ok(text.length <= LIMIT, `reminder is ${text.length} characters`);
});

test("SessionStart: a link in a doc file counts, from a subfolder; the KEY placeholder does not", () => {
  const dir = project({ "CLAUDE.md": "board: https://sprintree.com/p/SPD" });
  const sub = path.join(dir, "a", "b");
  mkdirSync(sub, { recursive: true });
  assert.match(hook("SessionStart", { cwd: sub }).out, /additionalContext/);
  const ph = project({ "AGENTS.md": "https://sprintree.com/p/KEY" });
  assert.equal(hook("SessionStart", { cwd: ph }).out, "");
});

test("SessionStart: SPRINTREE_HOOKS=off and garbage input are silent with exit 0", () => {
  const dir = project();
  assert.equal(hook("SessionStart", { cwd: dir }, { SPRINTREE_HOOKS: "off" }).out, "");
  const r = spawnSync(process.execPath, [SCRIPT, "SessionStart"], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "Nope"], { input: "{}", encoding: "utf8" }).stdout, "");
});

const stop = (dir, extra = {}) => ({ cwd: dir, session_id: sid(), ...extra });
const ST_WRITE = { name: "Bash", input: { command: 'node skills/sprintree/scripts/st.mjs call add_comment \'{"key":"SPD-1"}\'' } };
const READ = { name: "mcp__sprintree__get_work_context" };
const EDIT = { name: "Edit", input: { file_path: "x" } };

function append(file, ...tools) {
  const lines = tools.map((t) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: t.name, input: t.input ?? {} }] } }));
  appendFileSync(file, lines.join("\n") + "\n");
}

// <dir of transcript>/<session_id>/subagents/agent-*.jsonl, the layout Claude Code writes
function subagent(dir, session, ...tools) {
  const d = path.join(dir, session, "subagents");
  mkdirSync(d, { recursive: true });
  const f = path.join(d, "agent-a1.jsonl");
  writeFileSync(f, "");
  append(f, ...tools);
  return f;
}

test("SessionStart: a folder without .git counts only for itself, never from a parent above $HOME or the root (st.mjs's repoRoot)", () => {
  const home = tmp();
  writeFileSync(path.join(home, "CLAUDE.md"), "global: https://sprintree.com/p/SPD");
  const sub = path.join(home, "notes", "deep");
  mkdirSync(sub, { recursive: true });
  const env = { HOME: home, USERPROFILE: home };
  assert.equal(hook("SessionStart", { cwd: sub }, env).out, "", "no .git: the parent's link is not picked up");
  assert.match(hook("SessionStart", { cwd: home }, env).out, /additionalContext/, "the folder itself still counts");
  mkdirSync(path.join(home, ".git"));
  assert.match(hook("SessionStart", { cwd: sub }, env).out, /additionalContext/, "with .git at $HOME the walk reaches it");
  const long = project({ "CLAUDE.md": "https://sprintree.com/p/ABCDEFGHIJK" });
  assert.equal(hook("SessionStart", { cwd: long }).out, "", "a key longer than 10 characters is not a project key (KEY_RE)");
});

test("Stop: the claude.ai connector's tool names count in any letter case", () => {
  const dir = project();
  const input = stop(dir, { transcript_path: transcript(dir, { name: "mcp__claude_ai_Sprintree__add_comment", input: { key: "SPD-1" } }) });
  assert.equal(JSON.parse(hook("Stop", input).out).decision, "block");
});

test("Stop: a marker folder that is a symlink, or open to others, is skipped quietly: no marker, no nudge, exit 0", { skip: process.platform === "win32" }, () => {
  const dir = project();
  const base = tmp();
  const target = path.join(base, "elsewhere");
  mkdirSync(target);
  symlinkSync(target, path.join(base, "sprintree-agent-hooks"));
  const input = stop(dir, { transcript_path: transcript(dir, WRITE) });
  const r = hook("Stop", input, { TMPDIR: base });
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.deepEqual(readdirSync(target), []);
  const open = tmp();
  mkdirSync(path.join(open, "sprintree-agent-hooks"), { mode: 0o777 });
  chmodSync(path.join(open, "sprintree-agent-hooks"), 0o777);
  const r2 = hook("Stop", input, { TMPDIR: open });
  assert.equal(r2.code, 0);
  assert.equal(r2.out, "");
  assert.deepEqual(readdirSync(path.join(open, "sprintree-agent-hooks")), []);
  const ok = tmp(); // a fresh folder: created 0700, nudges
  assert.equal(JSON.parse(hook("Stop", input, { TMPDIR: ok }).out).decision, "block");
});

test("Stop: a board write blocks, with a reason that asks to check the cards and leaks no transcript text", () => {
  const dir = project();
  const input = stop(dir, { transcript_path: transcript(dir, WRITE) });
  const first = hook("Stop", input);
  assert.equal(first.code, 0);
  const o = JSON.parse(first.out);
  assert.equal(o.decision, "block");
  assert.match(o.reason, /real status/);
  assert.match(o.reason, /result comment/);
  assert.match(o.reason, /did not ask about any card, do nothing on the board/);
  assert.ok(!o.reason.includes("SPD-1"));
});

test("Stop: a second stop with nothing new is silent; new work after a nudge nudges again", () => {
  const dir = project();
  const t = transcript(dir, WRITE);
  const input = stop(dir, { transcript_path: t });
  assert.equal(JSON.parse(hook("Stop", input).out).decision, "block");
  assert.equal(hook("Stop", input).out, "");
  assert.equal(hook("Stop", input).out, "");
  append(t, EDIT, { name: "mcp__sprintree__list_projects" }); // no qualifying event: still silent
  assert.equal(hook("Stop", input).out, "");
  append(t, ST_WRITE);
  assert.equal(JSON.parse(hook("Stop", input).out).decision, "block");
  assert.equal(hook("Stop", input).out, "");
});

test("Stop: a card read followed by a code change blocks; the order matters and a read alone or an edit alone does not", () => {
  const dir = project();
  const rw = hook("Stop", stop(dir, { transcript_path: transcript(dir, READ, EDIT) }));
  assert.equal(JSON.parse(rw.out).decision, "block");
  for (const name of ["get_issue_details", "get_issue_history", "list_issue_commits", "list_issue_files"]) {
    assert.equal(JSON.parse(hook("Stop", stop(dir, { transcript_path: transcript(dir, { name: `mcp__sprintree__${name}` }, { name: "Write", input: {} }) })).out).decision, "block", name);
  }
  assert.equal(JSON.parse(hook("Stop", stop(dir, { transcript_path: transcript(dir, { name: "Bash", input: { command: "node st.mjs call get_issue_details '{}'" } }, { name: "MultiEdit", input: {} }) })).out).decision, "block");
  assert.equal(hook("Stop", stop(dir, { transcript_path: transcript(dir, EDIT, READ) })).out, "", "the edit came before the read");
  assert.equal(hook("Stop", stop(dir, { transcript_path: transcript(dir, READ) })).out, "");
  assert.equal(hook("Stop", stop(dir, { transcript_path: transcript(dir, EDIT, { name: "Write", input: {} }) })).out, "", "code changed, Sprintree never touched");
  const lists = transcript(dir, { name: "mcp__sprintree__list_projects" }, { name: "mcp__sprintree__search_issues" }, { name: "mcp__sprintree__list_statuses" }, EDIT);
  assert.equal(hook("Stop", stop(dir, { transcript_path: lists })).out, "", "lists and searches are not card reads");
});

test("Stop: a read, then a code change after a nudge counts only when both are new", () => {
  const dir = project();
  const t = transcript(dir, READ);
  const input = stop(dir, { transcript_path: t });
  assert.equal(hook("Stop", input).out, "");
  append(t, EDIT);
  assert.equal(JSON.parse(hook("Stop", input).out).decision, "block");
  append(t, EDIT);
  assert.equal(hook("Stop", input).out, "", "the read was before the last nudge");
});

test("Stop: a subagent's board write nudges the main session; its card read plus a main edit does too", () => {
  const dir = project();
  const session = sid();
  const t = transcript(dir, EDIT);
  subagent(dir, session, ST_WRITE);
  assert.equal(JSON.parse(hook("Stop", { cwd: dir, session_id: session, transcript_path: t }).out).decision, "block");
  const dir2 = project();
  const s2 = sid();
  const t2 = transcript(dir2, EDIT);
  subagent(dir2, s2, EDIT);
  assert.equal(hook("Stop", { cwd: dir2, session_id: s2, transcript_path: t2 }).out, "", "edits alone, no Sprintree");
  subagent(dir2, s2, READ);
  assert.equal(JSON.parse(hook("Stop", { cwd: dir2, session_id: s2, transcript_path: t2 }).out).decision, "block");
});

test("Stop: a symlinked subagent file is not read", () => {
  const dir = project();
  const session = sid();
  const t = transcript(dir, EDIT);
  const other = path.join(dir, "other.jsonl");
  writeFileSync(other, "");
  append(other, ST_WRITE);
  mkdirSync(path.join(dir, session, "subagents"), { recursive: true });
  symlinkSync(other, path.join(dir, session, "subagents", "agent-link.jsonl"));
  assert.equal(hook("Stop", { cwd: dir, session_id: session, transcript_path: t }).out, "");
});

test("Stop: a st.mjs call counts only after a node invocation; grep and cat of the text do not", () => {
  const dir = project();
  for (const command of ["grep 'st.mjs call add_comment' README.md", "grep -n \"st.mjs call update_issue_status\" README.md", "cat skills/sprintree/scripts/st.mjs call add_comment"]) {
    assert.equal(hook("Stop", stop(dir, { transcript_path: transcript(dir, { name: "Bash", input: { command } }) })).out, "", command);
  }
  for (const command of ['node "${CLAUDE_PLUGIN_ROOT}/skills/sprintree/scripts/st.mjs" call add_comment @c.json', "cd x && node --no-warnings ./st.mjs call update_issue_status '{}'"]) {
    assert.equal(JSON.parse(hook("Stop", stop(dir, { transcript_path: transcript(dir, { name: "Bash", input: { command } }) })).out).decision, "block", command);
  }
});

test("Stop: not when stop_hook_active, not with SPRINTREE_HOOKS=off", () => {
  const dir = project();
  const t = transcript(dir, WRITE);
  assert.equal(hook("Stop", { cwd: dir, session_id: sid(), transcript_path: t, stop_hook_active: true }).out, "");
  assert.equal(hook("Stop", { cwd: dir, session_id: sid(), transcript_path: t }, { SPRINTREE_HOOKS: "off" }).out, "");
  // the opt-out and stop_hook_active must not have used up the session's one nudge
  const s = sid();
  assert.equal(hook("Stop", { cwd: dir, session_id: s, transcript_path: t, stop_hook_active: true }).out, "");
  assert.equal(JSON.parse(hook("Stop", { cwd: dir, session_id: s, transcript_path: t }).out).decision, "block");
});

test("Stop: the answer to a nudge (a board write under stop_hook_active) is not new work on the next turn", () => {
  const dir = project();
  const t = transcript(dir, READ, EDIT);
  const input = stop(dir, { transcript_path: t });
  assert.equal(JSON.parse(hook("Stop", input).out).decision, "block", "turn 1");
  append(t, { name: "mcp__sprintree__add_comment", input: { key: "SPD-1" } });
  assert.equal(hook("Stop", { ...input, stop_hook_active: true }).out, "", "the nudge answer");
  append(t, { name: "mcp__sprintree__list_projects" }); // turn 2: an unrelated question
  assert.equal(hook("Stop", input).out, "", "turn 2");
  assert.equal(hook("Stop", input).out, "", "turn 3");
});

test("Stop: a Bash command that writes files after a card read counts as a code change; read-only commands do not", () => {
  const bash = (command) => ({ name: "Bash", input: { command } });
  const writes = [
    "sed -i 's/a/b/' src/x.js", "sed -i.bak -e 's/a/b/' x", "perl -pi -e 's/a/b/' x", "echo hi > out.txt", "cat <<EOF >> notes.md\nx\nEOF",
    "cat > f.js <<'EOF'\nx\nEOF", "npm test 2>&1 | tee build.log", "git apply fix.patch", "git commit -m x", "git -C . am p.mbox",
    "perl -i.bak -pe 's/a/b/' f", "perl -pi -e s/a/b/ f", "perl -0pi -e s/a/b/ f", "perl -0777pi -e s/a/b/ f", "perl -0777 -pi -e s/a/b/ f",
    "perl -wpi -e s/a/b/ f", "perl -pi -Mstrict f", "cd x && sed -i s/a/b/ f", "ls >/dev/null; echo hi > out.txt",
  ];
  for (const command of writes) {
    const dir = project();
    assert.equal(JSON.parse(hook("Stop", stop(dir, { transcript_path: transcript(dir, READ, bash(command)) })).out).decision, "block", command);
  }
  const readOnly = [
    "npm test", "git status", "grep -rn foo src", "cat src/x.js", "sed -n '1,5p' x", "ls > /dev/null", "npm test 2>&1", "make 2>/dev/null",
    "echo hi >&2", "git diff | head", "node -e \"x=>x\"", "ls | tee /dev/null", "ls >/dev/null; echo done", "make >/dev/null&&echo ok",
    "(ls >/dev/null)", "ls | tee /dev/null; echo x", "perl -Mstrict -e 1", "perl -MList::Util=sum -le 'print 1'", "perl -I lib -e 1",
    "perl -wMstrict -e 1", "perl -wIlib -e 1",
  ];
  for (const command of readOnly) {
    const dir = project();
    assert.equal(hook("Stop", stop(dir, { transcript_path: transcript(dir, READ, bash(command)) })).out, "", command);
  }
  const dir = project();
  assert.equal(hook("Stop", stop(dir, { transcript_path: transcript(dir, bash("sed -i s/a/b/ x")) })).out, "", "no card read before it");
});

test("bashWrites: an 80k crafted sed or perl flag token classifies in under 200 ms", () => {
  const crafted = `-${"i".repeat(80000)}!`;
  for (const word of ["sed", "perl"]) {
    const t0 = performance.now();
    assert.equal(bashWrites(`${word} ${crafted} x`), false);
    const ms = performance.now() - t0;
    console.log(`bashWrites ${word} 80k token: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 200, `${word}: ${ms} ms`);
  }
});

test("Stop: a card read that falls out of the scanned tail before the edit still counts", () => {
  const dir = project();
  const big = path.join(dir, "big.jsonl");
  const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(1000) } }) + "\n";
  writeFileSync(big, transcript(dir, READ) && readFileSync(transcript(dir, READ), "utf8"));
  const input = stop(dir, { transcript_path: big });
  assert.equal(hook("Stop", input).out, "", "a read alone");
  appendFileSync(big, filler.repeat(3000)); // the read is now >2 MiB from the end
  append(big, EDIT);
  assert.equal(JSON.parse(hook("Stop", input).out).decision, "block");
  append(big, EDIT);
  assert.equal(hook("Stop", input).out, "", "the read was used up by the nudge");
});

test("Stop: not for a read-only session, a missing transcript, a non-Sprintree project or no session id", () => {
  const dir = project();
  const ro = transcript(dir, { name: "mcp__sprintree__get_issue_details" }, { name: "mcp__sprintree__list_projects" });
  assert.equal(hook("Stop", { cwd: dir, session_id: sid(), transcript_path: ro }).out, "");
  assert.equal(hook("Stop", { cwd: dir, session_id: sid(), transcript_path: path.join(dir, "missing.jsonl") }).out, "");
  assert.equal(hook("Stop", { cwd: dir, session_id: sid() }).out, "");
  const t = transcript(dir, WRITE);
  assert.equal(hook("Stop", { cwd: dir, transcript_path: t }).out, "");
  const plain = project({});
  assert.equal(hook("Stop", { cwd: plain, session_id: sid(), transcript_path: transcript(plain, WRITE) }).out, "");
});

test("Stop: a hostile session_id cannot leave the temp folder, and a huge transcript is read only at its tail", () => {
  const dir = project();
  const t = transcript(dir, WRITE);
  const r = hook("Stop", { cwd: dir, session_id: "../../etc/x" + sid(), transcript_path: t });
  assert.equal(r.code, 0);
  const big = path.join(dir, "big.jsonl");
  const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(1000) } }) + "\n";
  writeFileSync(big, WRITE_LINE() + filler.repeat(3000)); // the write is >2 MiB from the end
  assert.equal(hook("Stop", { cwd: dir, session_id: sid(), transcript_path: big }).out, "");
});

function WRITE_LINE() {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: WRITE.name, input: {} }] } }) + "\n";
}

test("hooks.json: the card-reminder hooks are node commands that end quietly without Node (2>/dev/null || true, like the agent-runs hooks), with small timeouts", () => {
  const doc = JSON.parse(readFileSync(path.join(ROOT, "claude-hooks", "hooks.json"), "utf8"));
  const found = [];
  for (const [event, groups] of Object.entries(doc.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        if (!h.command.includes("discipline.mjs")) continue;
        found.push(event);
        assert.match(h.command, new RegExp(`^node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/skills/sprintree/scripts/discipline\\.mjs" ${event} 2>/dev/null \\|\\| true$`));
        assert.ok(!/[|&;<>`$(\[]/.test(h.command.replace('${CLAUDE_PLUGIN_ROOT}', "").replace(" 2>/dev/null || true", "")), h.command);
        assert.ok(h.timeout <= 5);
        assert.equal(g.matcher, undefined, "all SessionStart sources");
      }
    }
  }
  assert.deepEqual(found.sort(), ["SessionStart", "Stop"]);
});

test("Stop: a card read with no nudge leaves a marker; an active stop does not swallow the edit, the next normal turn nudges", () => {
  const dir = project();
  const t = transcript(dir, READ);
  const input = stop(dir, { transcript_path: t });
  assert.equal(hook("Stop", input).out, "", "turn 1: card read, no code yet, no nudge");
  append(t, EDIT);
  // turn 2: another plugin's blocking Stop hook forced a continuation; the hook stays silent and must not advance past the edit
  assert.equal(hook("Stop", { ...input, stop_hook_active: true }).out, "", "turn 2 (active) is silent");
  assert.equal(JSON.parse(hook("Stop", input).out).decision, "block", "turn 3 nudges");
});

test("bashWrites: a 320 KB command of repeated sed words classifies in linear time", () => {
  const cmd = "sed ".repeat(80 * 1024);
  const t0 = performance.now();
  assert.equal(bashWrites(cmd), false);
  assert.equal(bashWrites(`${cmd} -i x`), true);
  const ms = performance.now() - t0;
  console.log(`bashWrites 320KB x2: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 500, `${ms} ms`);
});

// SPD-1760: a card read plus a git commit with no record_work after it adds one line to the same nudge.
const COMMIT = { name: "Bash", input: { command: 'git commit -m "feat: x (SPD-1)"' } };
const RECORD = { name: "mcp__sprintree__record_work", input: { key: "SPD-1" } };
const reasonOf = (dir, ...tools) => JSON.parse(hook("Stop", stop(dir, { transcript_path: transcript(dir, ...tools) })).out).reason;

test("Stop: a card read and a commit add the record_work reminder line to the nudge", () => {
  const dir = project();
  const reason = reasonOf(dir, READ, EDIT, COMMIT);
  assert.match(reason, /Sprintree check/);
  assert.match(reason, /record_work/);
  assert.match(reason, /work\.mjs usage/);
  assert.equal(reason.split("\n").length, 3, "body, the record line, then the closing sentence");
  assert.match(reason.split("\n")[1], /record_work/);
  assert.equal(reason.split("\n")[2], "Then stop normally and do not repeat this check.", "the closing sentence is last");
  assert.equal(reason.split("Then stop normally").length, 2);
  assert.match(reasonOf(dir, READ, { name: "Bash", input: { command: "git -C . commit -q -m x" } }), /record_work/);
});

test("Stop: no record_work line without a commit, without a card read, or when record_work came after the commit", () => {
  const dir = project();
  assert.doesNotMatch(reasonOf(dir, READ, EDIT), /record_work/, "an edit, no commit");
  assert.doesNotMatch(reasonOf(dir, READ, { name: "Bash", input: { command: "git status && git log -3" } }, EDIT), /record_work/, "git without a commit");
  assert.doesNotMatch(reasonOf(dir, WRITE, COMMIT), /record_work/, "a board write and a commit, but no card read");
  assert.doesNotMatch(reasonOf(dir, READ, COMMIT, RECORD), /record_work/, "record_work after the commit (MCP)");
  const viaSt = { name: "Bash", input: { command: "node skills/sprintree/scripts/st.mjs call record_work '{\"key\":\"SPD-1\"}'" } };
  assert.doesNotMatch(reasonOf(dir, READ, COMMIT, viaSt), /record_work/, "record_work after the commit (st.mjs)");
  assert.match(reasonOf(dir, READ, RECORD, COMMIT), /record_work/, "record_work BEFORE the last commit does not count");
});

test("Stop: the record_work line is one nudge, never a loop; record_work is a board write", () => {
  const dir = project();
  const input = stop(dir, { transcript_path: transcript(dir, READ, COMMIT) });
  assert.match(JSON.parse(hook("Stop", input).out).reason, /record_work/);
  assert.equal(hook("Stop", input).out, "", "the next stop with nothing new is silent");
  assert.equal(hook("Stop", { ...input, stop_hook_active: true }).out, "", "an active stop is silent");
  const only = project();
  const r = hook("Stop", stop(only, { transcript_path: transcript(only, RECORD) }));
  assert.equal(JSON.parse(r.out).decision, "block", "record_work alone counts as a board write");
  assert.doesNotMatch(JSON.parse(r.out).reason, /record_work/);
});

test("Stop: the record_work line survives a nudge between the card read and the commit (multi-turn)", () => {
  const dir = project();
  const t = transcript(dir, READ, EDIT);
  const input = stop(dir, { transcript_path: t });
  assert.doesNotMatch(JSON.parse(hook("Stop", input).out).reason, /record_work/, "turn 1: nudge, no commit yet");
  append(t, COMMIT);
  assert.match(JSON.parse(hook("Stop", input).out).reason, /record_work/, "turn 2: the commit alone brings the line");
  assert.equal(hook("Stop", input).out, "", "and only once");
});

test("Stop: a commit in a subagent file and record_work in the main file gives no record_work line", () => {
  const dir = project();
  const main = transcript(dir, READ, EDIT, RECORD);
  const input = stop(dir, { transcript_path: main });
  subagent(dir, input.session_id, COMMIT);
  assert.doesNotMatch(JSON.parse(hook("Stop", input).out).reason, /record_work/);
});

test("Stop: only a git commit at a command start adds the record_work line", () => {
  const bash = (command) => ({ name: "Bash", input: { command } });
  const dir = project();
  for (const command of ["grep -n 'git commit' README.md", "echo git commit"]) {
    assert.doesNotMatch(reasonOf(dir, READ, EDIT, bash(command)), /record_work/, command);
  }
  for (const command of ["cd a && git commit -m x", "git -C dir commit -m x", "make; git commit -m x", "(git commit -m x)", "ls\ngit commit -m x", "FOO=1 git commit -m x", "env A=b git commit -m x", "true || git commit -m x"]) {
    assert.match(reasonOf(dir, READ, bash(command)), /record_work/, command);
  }
});

test("Stop: a commit in a subagent file and record_work later in the main file gives no record_work line", () => {
  const dir = project();
  const main = transcript(dir, READ, EDIT);
  const input = stop(dir, { transcript_path: main });
  subagent(dir, input.session_id, COMMIT);
  append(main, RECORD);
  assert.doesNotMatch(JSON.parse(hook("Stop", input).out).reason, /record_work/);
});

test("Stop: after record_work the remembered card read is cleared: later commits alone add no record_work line", () => {
  const dir = project();
  const t = transcript(dir, READ, COMMIT);
  const input = stop(dir, { transcript_path: t });
  assert.match(JSON.parse(hook("Stop", input).out).reason, /record_work/, "read, commit: the line");
  append(t, RECORD);
  hook("Stop", input); // the record_work turn (a board write)
  for (let i = 0; i < 2; i++) {
    append(t, COMMIT);
    assert.doesNotMatch(hook("Stop", input).out, /record_work/, `turn ${i + 1}: a commit with no new card read`);
  }
  append(t, READ, COMMIT);
  assert.match(JSON.parse(hook("Stop", input).out).reason, /record_work/, "a new card read brings the line back");
});

// SPD-1883: an answered AskUserQuestion with no page write after it adds the Memory Drawer line to the nudge, alone when there is no card work.
const ASK = { name: "AskUserQuestion", id: "q1", input: { questions: [] } };
const ANSWER = { result: "q1" };
const PAGE = { name: "mcp__sprintree__create_page", input: { project: "SPD", kind: "decision" } };
const PAGE_UPDATE = { name: "mcp__sprintree__update_page", input: { project: "SPD", page: 79 } };
const DECISION = /Memory Drawer/;

function convo(dir, ...items) {
  const lines = [{ type: "user", message: { role: "user", content: "go" } }];
  for (const t of items) {
    if (t.result) lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: t.result, content: "User answered", ...(t.error ? { is_error: true } : {}) }] } });
    else lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: t.id ?? "x", name: t.name, input: t.input ?? {} }] } });
  }
  const f = path.join(dir, "c.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}
const decisionOut = (dir, ...items) => hook("Stop", stop(dir, { transcript_path: convo(dir, ...items) })).out;

test("Stop: an answered question with no page write nudges with the decision line alone", () => {
  const dir = project();
  const o = JSON.parse(decisionOut(dir, ASK, ANSWER));
  assert.equal(o.decision, "block");
  assert.match(o.reason, DECISION);
  assert.match(o.reason, /get_project_rules query/);
  assert.doesNotMatch(o.reason, /Sprintree check/, "no card-check text without card work");
  assert.match(o.reason, /Then stop normally and do not repeat this check\.$/);
  assert.equal(o.reason.split("Then stop normally").length, 2, "the closing sentence appears once");
  assert.match(o.reason, /no secrets/);
});

test("Stop: a decision-only nudge keeps the remembered card read, so a later edit still gets the card check", () => {
  const dir = project();
  const t = convo(dir, READ, ASK, ANSWER);
  const input = stop(dir, { transcript_path: t });
  const first = JSON.parse(hook("Stop", input).out);
  assert.match(first.reason, DECISION);
  assert.doesNotMatch(first.reason, /Sprintree check/);
  append(t, EDIT);
  const second = JSON.parse(hook("Stop", input).out);
  assert.match(second.reason, /Sprintree check/, "the read survived the decision-only nudge");
});

test("Stop: a page write after the answer (create_page or update_page) leaves no decision line", () => {
  const dir = project();
  assert.equal(decisionOut(dir, ASK, ANSWER, PAGE), "");
  assert.equal(decisionOut(dir, ASK, ANSWER, PAGE_UPDATE), "");
  assert.match(decisionOut(dir, PAGE, ASK, ANSWER), DECISION, "a page write BEFORE the answer does not count");
  const viaSt = { name: "Bash", input: { command: "node skills/sprintree/scripts/st.mjs call create_page '{\"project\":\"SPD\"}'" } };
  assert.equal(decisionOut(dir, ASK, ANSWER, viaSt), "", "create_page through st.mjs counts too");
});

test("Stop: a question without an answer, a failed answer or a different tool_result gives no decision line", () => {
  const dir = project();
  assert.equal(decisionOut(dir, ASK), "", "no tool_result");
  assert.equal(decisionOut(dir, ASK, { result: "q1", error: true }), "", "the question was rejected");
  assert.equal(decisionOut(dir, ASK, { result: "other" }), "", "result of another call");
});

test("Stop: stop_hook_active never re-nudges for an answered question", () => {
  const dir = project();
  const t = convo(dir, ASK, ANSWER);
  assert.equal(hook("Stop", stop(dir, { transcript_path: t, stop_hook_active: true })).out, "");
});

test("Stop: the decision nudge comes once per new answered question", () => {
  const dir = project();
  const input = stop(dir, { transcript_path: convo(dir, ASK, ANSWER) });
  assert.match(hook("Stop", input).out, DECISION);
  assert.equal(hook("Stop", input).out, "", "same transcript: no second nudge");
  appendFileSync(input.transcript_path, [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "q2", name: "AskUserQuestion", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q2", content: "ok" }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.match(hook("Stop", input).out, DECISION, "a new answered question nudges again");
});

test("Stop: card work and an answered question share one nudge; card-only nudges are unchanged", () => {
  const dir = project();
  const both = JSON.parse(decisionOut(dir, WRITE, ASK, ANSWER)).reason;
  assert.match(both, /Sprintree check/);
  assert.match(both, DECISION);
  const only = reasonOf(dir, WRITE);
  assert.doesNotMatch(only, DECISION);
  assert.match(only, /Sprintree check/);
  assert.equal(only.split("\n").length, 1);
  assert.match(only, /do nothing on the board\. Then stop normally and do not repeat this check\.$/, "card-only text is unchanged");
  assert.ok(both.indexOf("Memory Drawer") < both.indexOf("Then stop normally"), "the decision line comes before the closing sentence");
  assert.equal(both.split("Then stop normally").length, 2, "one closing sentence");
  assert.match(both, /Then stop normally and do not repeat this check\.$/);
  assert.ok(both.indexOf("Sprintree check") < both.indexOf("Memory Drawer"));
});
