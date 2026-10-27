#!/usr/bin/env node
/**
 * The numbers for `record_work`: what this Claude Code session spent, read from its local transcripts. Pure Node >= 18.7.0, no
 * dependencies. The skill runs it by hand after the commits and the PCC of a card's work.
 *
 *   node work.mjs usage [--since ISO] [--session ID] [--key SPD-1]
 *
 * Prints ONE JSON object, ready to merge into the `record_work` arguments: { agent, usage, commits, subagents, duration_minutes }.
 * It sends nothing: no network module is imported or used, no token is read, nothing is written.
 *
 * Counting is `pcc-cost.py`'s rule: per assistant message input + cache_creation + output (cache reads are reported, not part of
 * the total). Claude Code writes a streamed message several times with the same message id; each message is counted once, from
 * the record with the largest output. The main transcript and the subagent transcripts (<project folder>/<session>/subagents/**)
 * are read; with --since only the lines at or after that time. Per model: input, output, cache_write, cache_read; the 5 biggest
 * models are kept (record_work takes 5), the number left out is said on stderr. subagents = subagent transcripts with a line in
 * range. duration_minutes = first to last timestamp in range.
 *
 * Session: --session, else $CLAUDE_CODE_SESSION_ID, else the newest transcript of the project folder
 * ~/.claude/projects/<repo path with every character but letters and digits turned into "-">.
 * Commits (only with --key): `git log --grep=<KEY>` (the whole key, not a longer one such as SPD-10 for SPD-1) of this repo (since --since), 20 at most, newest first; SHAs only.
 *
 * Privacy: each line is parsed and only `type`, `timestamp`, `message.id`, `message.model` and `message.usage` are picked. Message
 * text, tool input and tool output are never kept, copied or printed. An unknown format or an unreadable folder ends with
 * `usage unavailable` on stderr, an empty usage and exit 0. Reads are bounded (file size, line length, file count).
 */
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const FILE_MAX = 200 * 1024 * 1024;
const LINE_MAX = 16 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const FILES_MAX = 200;
const DEPTH_MAX = 4;
const MODELS_MAX = 5;
const COMMITS_MAX = 20;
const DURATION_MAX = 7 * 24 * 60;
const TOKENS_MAX = 10_000_000_000;
const KEY_OK = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/;
const SESSION_OK = /^[A-Za-z0-9_-]{1,64}$/;

const num = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), TOKENS_MAX) : 0);

/** The lines of a file, one string each. Lines over LINE_MAX are dropped whole; a file over FILE_MAX is skipped (throws on a read error). */
function* fileLines(file) {
  const fd = openSync(file, "r");
  try {
    const dec = new StringDecoder("utf8");
    const buf = Buffer.alloc(CHUNK);
    let carry = "";
    let dropping = false; // inside a line that is over the cap: skip to its newline
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const text = dec.write(buf.subarray(0, n));
      let start = 0;
      for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
        const piece = text.slice(start, nl);
        start = nl + 1;
        if (dropping) {
          dropping = false;
        } else {
          const line = carry + piece;
          if (line.length <= LINE_MAX) yield line;
        }
        carry = "";
      }
      if (!dropping) {
        carry += text.slice(start);
        if (carry.length > LINE_MAX) {
          carry = "";
          dropping = true;
        }
      }
    }
    carry += dec.end();
    if (carry && !dropping) yield carry;
  } finally {
    closeSync(fd);
  }
}

/**
 * What one transcript holds in range: the final usage of each message (by id) and the first and last timestamp.
 * Only the fields named in the header are read from a line.
 */
export function readTranscript(file, sinceMs = null) {
  const st = statSync(file);
  if (!st.isFile() || st.size > FILE_MAX) return null;
  const msgs = new Map(); // message id -> { model, input, output, cacheWrite, cacheRead }
  let first = null;
  let last = null;
  let loose = 0; // a usage record with no message id counts on its own
  for (const line of fileLines(file)) {
    if (!line.startsWith("{")) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const t = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (sinceMs !== null && !(t >= sinceMs)) continue; // a line with no usable time is not "at or after"
    if (Number.isFinite(t)) {
      if (first === null || t < first) first = t;
      if (last === null || t > last) last = t;
    }
    if (o.type !== "assistant") continue;
    const m = o.message;
    const u = m && typeof m === "object" ? m.usage : null;
    if (!u || typeof u !== "object") continue;
    const rec = {
      model: typeof m.model === "string" ? m.model.slice(0, 80) : "unknown",
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
    };
    const key = typeof m.id === "string" && m.id ? m.id : `#${loose++}`;
    const prev = msgs.get(key);
    if (prev && rec.output < prev.output) continue; // streaming records of one id: the last (largest output) is final
    msgs.set(key, rec);
  }
  return { msgs, first, last };
}

/** Regular .jsonl files under `dir` (agent-*.jsonl, also nested), no symlinks, bounded in depth and count. */
function jsonlFiles(dir, depth = 0, acc = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of names.sort()) {
    if (acc.length >= FILES_MAX) break;
    const f = path.join(dir, name);
    let st;
    try {
      st = lstatSync(f);
    } catch {
      continue;
    }
    if (st.isFile() && name.endsWith(".jsonl")) acc.push(f);
    else if (st.isDirectory() && depth < DEPTH_MAX) jsonlFiles(f, depth + 1, acc);
  }
  return acc;
}

/** Claude Code's folder name for a path: every character that is not a letter or a digit becomes "-". */
const projectKeys = (p) => [...new Set([p.replace(/[^A-Za-z0-9]/g, "-"), p.replace(/[/\\.:]/g, "-")])];

function gitTop(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

/** The project folders under ~/.claude/projects for this repo (git top first, then cwd), as many as exist. */
function projectDirs(cwd, home) {
  const root = path.join(home, ".claude", "projects");
  const found = [];
  for (const base of [gitTop(cwd), cwd]) {
    if (!base) continue;
    for (const k of projectKeys(base)) {
      const d = path.join(root, k);
      try {
        if (statSync(d).isDirectory() && !found.includes(d)) found.push(d);
      } catch {
        // not this one
      }
    }
  }
  return found;
}

/** The folder holding <session>.jsonl: the candidates first (the session may run in a worktree folder), then every project folder. */
function dirOfSession(cands, home, session) {
  const has = (d) => {
    try {
      return lstatSync(path.join(d, `${session}.jsonl`)).isFile();
    } catch {
      return false;
    }
  };
  for (const d of cands) if (has(d)) return d;
  const root = path.join(home, ".claude", "projects");
  try {
    for (const name of readdirSync(root)) {
      const d = path.join(root, name);
      if (has(d)) return d;
    }
  } catch {
    // no projects folder
  }
  return null;
}

/** The newest *.jsonl (session id without the extension) of a project folder, or "". */
function newestSession(dir) {
  let best = "";
  let bestM = -1;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -6);
      if (!SESSION_OK.test(id)) continue;
      const st = lstatSync(path.join(dir, name));
      if (st.isFile() && st.mtimeMs > bestM) {
        best = id;
        bestM = st.mtimeMs;
      }
    }
  } catch {
    // none
  }
  return best;
}

/** The usage of one session: { models: [{model,input,output,cache_write,cache_read}], left, subagents, duration_minutes } or null when no usage was found. */
export function sessionUsage(dir, session, sinceMs = null) {
  const totals = new Map();
  let first = null;
  let last = null;
  let subagents = 0;
  let any = false;
  const take = (file, isSub) => {
    let r;
    try {
      r = readTranscript(file, sinceMs);
    } catch {
      return;
    }
    if (!r) return;
    if (isSub && r.first !== null) subagents++;
    if (r.first !== null) {
      if (first === null || r.first < first) first = r.first;
      if (last === null || r.last > last) last = r.last;
    }
    for (const v of r.msgs.values()) {
      any = true;
      const t = totals.get(v.model) ?? { model: v.model, input: 0, output: 0, cache_write: 0, cache_read: 0 };
      t.input = Math.min(t.input + v.input, TOKENS_MAX);
      t.output = Math.min(t.output + v.output, TOKENS_MAX);
      t.cache_write = Math.min(t.cache_write + v.cacheWrite, TOKENS_MAX);
      t.cache_read = Math.min(t.cache_read + v.cacheRead, TOKENS_MAX);
      totals.set(v.model, t);
    }
  };
  take(path.join(dir, `${session}.jsonl`), false);
  for (const f of jsonlFiles(path.join(dir, session, "subagents"))) take(f, true);
  if (!any) return null;
  const all = [...totals.values()]
    .filter((t) => t.input + t.output + t.cache_write + t.cache_read > 0)
    .sort((a, b) => b.input + b.output + b.cache_write - (a.input + a.output + a.cache_write) || a.model.localeCompare(b.model));
  if (all.length === 0) return null;
  const minutes = first === null ? 0 : Math.min(Math.round((last - first) / 60000), DURATION_MAX);
  return { models: all.slice(0, MODELS_MAX), left: Math.max(all.length - MODELS_MAX, 0), subagents, duration_minutes: minutes };
}

/** The SHAs of the commits whose message names `key`, newest first, at most 20. Arguments go as an array: no shell. */
export function commitsFor(key, since, cwd) {
  const args = ["log", "--format=%H", "-E", `--grep=(^|[^A-Za-z0-9-])${key}([^0-9]|$)`, "-n", String(COMMITS_MAX)];
  if (since) args.push(`--since=${since}`);
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, maxBuffer: 1024 * 1024 });
    return out.split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/.test(s)).slice(0, COMMITS_MAX);
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const o = { since: "", session: "", key: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name !== "--since" && name !== "--session" && name !== "--key") throw new Error(`unknown argument ${a.slice(0, 40)}`);
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (typeof v !== "string") throw new Error(`${name} needs a value`);
    o[name.slice(2)] = v;
  }
  return o;
}

/** The result object and the notes for stderr. */
export function usageReport(argv, env = process.env, cwd = process.cwd()) {
  const opts = parseArgs(argv);
  const notes = [];
  let sinceMs = null;
  if (opts.since) {
    sinceMs = Date.parse(opts.since);
    if (!Number.isFinite(sinceMs)) throw new Error("--since must be an ISO time, e.g. 2026-10-28T09:00:00Z");
  }
  if (opts.key && !KEY_OK.test(opts.key)) throw new Error("--key must look like SPD-1");
  const out = { agent: "claude-code", usage: [], commits: [], subagents: 0, duration_minutes: 0 };
  let found = null;
  const home = env.HOME || env.USERPROFILE || homedir();
  const cands = projectDirs(cwd, home);
  const known = opts.session || (env.CLAUDE_CODE_SESSION_ID || "").trim();
  let dir = null;
  let session = known;
  if (known) {
    if (SESSION_OK.test(known)) dir = dirOfSession(cands, home, known);
  } else if (cands.length > 0) {
    dir = cands[0];
    session = newestSession(dir);
  }
  if (dir && SESSION_OK.test(session)) found = sessionUsage(dir, session, sinceMs);
  if (found) {
    out.usage = found.models;
    out.subagents = found.subagents;
    out.duration_minutes = found.duration_minutes;
    if (found.left > 0) notes.push(`${found.left} more model(s) left out (record_work takes ${MODELS_MAX})`);
  } else {
    notes.push("usage unavailable");
  }
  if (opts.key) out.commits = commitsFor(opts.key, opts.since, cwd);
  return { out, notes };
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    if (process.argv[2] !== "usage") throw new Error("usage: node work.mjs usage [--since ISO] [--session ID] [--key SPD-1]");
    const { out, notes } = usageReport(process.argv.slice(3));
    for (const n of notes) process.stderr.write(`${n}\n`);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    process.stderr.write(`work.mjs: ${e instanceof Error ? e.message : "failed"}\n`);
    process.exitCode = 2;
  }
}
