#!/usr/bin/env node
/**
 * Live events for a Claude Code session: a plugin monitor (monitors/monitors.json) runs this when an interactive session opens
 * and keeps it running; every stdout line becomes a notification to the model. Pure Node >= 18.7.0, no dependencies.
 *
 *   node listen.mjs      # GET <SPRINTREE_URL or https://sprintree.com>/api/stream?project=<KEY>, one line per event
 *
 * Silent (exit 0, nothing printed) without a live-events token or without a project: a user who never ran /sprintree:connect
 * gets no notification. The token (itns_...) is SPRINTREE_STREAM_TOKEN or the first line of
 * ${XDG_CONFIG_HOME:-$HOME/.config}/sprintree/stream-token (mode 0600). The project is the `project` of .sprintree.json (nearest
 * wins, as for st.mjs), else SPRINTREE_PROJECT.
 *
 * What is printed: ids and enums only. The stream is treated as hostile: a key, enum, id or handle is `[A-Za-z0-9_.:-]` and at most
 * 64 characters, a number a non-negative integer, a line at most 300 characters; a frame with an invalid required field prints
 * nothing. Control characters never reach the terminal and the token is never printed (safeLine = st.mjs's scrub).
 * `/claude` commands are opt-in on the local machine: unless they are on (/sprintree:commands on for this session, or its default, or
 * SPRINTREE_COMMANDS=on in the user's own ~/.claude/settings.json `env`; see readCommandsState) a command frame, and the commands part
 * of a summary, print nothing, so someone who takes over the Sprintree account cannot hand work to this session. Status, notification
 * and batch lines are unaffected. The setting is re-read when its file changes: the monitor then reconnects with the new
 * X-Stream-Commands header (no restart) and writes what the server answered in hello to <session>.ack.
 * The session id sent is derived from CLAUDE_CODE_SESSION_ID (a hash: the raw id never leaves the machine).
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, watch } from "node:fs";
import path from "node:path";
import { isMainModule, resolveConfig } from "./st.mjs";
import { ackFile, baseUrl, configDir, defaultFile, errorCode, readCommandsState, readToken, safeLine, secondMs, sessionFile, sessionId, writeAtomic } from "./stream-common.mjs";

const KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const FIELD_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const HEADER_ID_RE = /^[\x21-\x7e]{1,128}$/;
const LINE_MAX = 300;
const IDLE_MS = 120_000; // no byte (not even a keep-alive comment) for this long: the connection is dead, reconnect
const BUFFER_MAX = 1024 * 1024;
const DATA_MAX = 64 * 1024;
const RETRY_AFTER_MAX_S = 300;
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(json|ack)$/;
const DAY_MS = 24 * 3600 * 1000;
const SESSION_FILE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const prefix = "sprintree-events";

/** An id, enum or handle: the allowed characters only and at most 64 of them, else null. */
export const field = (v) => (typeof v === "string" && FIELD_RE.test(v) ? v : null);
/** A non-negative integer, else null. */
export const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** A branch-like label: lower-case, [^a-z0-9._-] -> "-", 40 characters, "main" when there is nothing. */
export const cleanLabel = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 40) || "main";

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, timeout: 3000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** The label: the current branch, or the repository folder's name when HEAD is detached. */
export function labelOf(cwd) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch && branch !== "HEAD") return cleanLabel(branch);
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  return cleanLabel(top ? path.basename(top) : "");
}

/** The project key: .sprintree.json (the repository's), else SPRINTREE_PROJECT. Null when there is none or it is not a key. */
export function projectOf(cwd, env) {
  let key = null;
  try {
    key = resolveConfig(cwd).project ?? null;
  } catch {
    // an unreadable or invalid config: fall back to the environment
  }
  if (typeof key === "string") key = key.trim().toUpperCase();
  if (!key) key = (env.SPRINTREE_PROJECT || "").trim().toUpperCase();
  return typeof key === "string" && KEY_RE.test(key) ? key : null;
}

/** A bounded memory of recent keys: seen(key) is true for a repeat, otherwise it remembers the key and evicts the oldest past `cap`. */
export function dedupe(cap = 1000) {
  const seen = new Set();
  return (key) => {
    if (seen.has(key)) return true;
    seen.add(key);
    if (seen.size > cap) seen.delete(seen.values().next().value);
    return false;
  };
}

/** " · @actor" for a valid actor, "" when the server does not know it (empty or missing; never an invented name), null for a bad one. */
const by = (actor) => {
  if (actor === "" || actor === undefined || actor === null) return "";
  const a = field(actor);
  return a ? ` · @${a}` : null;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The line for one `sprintree` frame (already parsed JSON), or null: unknown type, or a required field that is not valid. Commands print only with `commands: true` (the default is off, fail closed). */
export function formatEvent(d, { commands = false } = {}) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const tail = d.claim === true ? " · claim first" : "";
  let s = null;
  switch (d.type) {
    case "status": {
      const [issue, from, to, ev] = [d.issue, d.from, d.to, d.ev].map(field);
      if ([issue, from, to, ev].includes(null)) return null;
      const who = by(d.actor);
      if (who === null) return null;
      s = `${issue} · status ${from}→${to}${who} · ev=${ev}`;
      break;
    }
    case "notification": {
      const [kind, issue, ev] = [d.kind, d.issue, d.ev].map(field);
      if ([kind, issue, ev].includes(null)) return null;
      const who = by(d.actor);
      if (who === null) return null;
      s = `${issue} · ${kind}${who} · ev=${ev}`;
      break;
    }
    case "command": {
      if (!commands) return null;
      const [issue, comment, ev] = [d.issue, d.comment, d.ev].map(field);
      if ([issue, comment, ev].includes(null)) return null;
      s = `${issue} · /claude command · comment=${comment} · ev=${ev}`;
      break;
    }
    case "batch": {
      const n = count(d.count);
      const to = field(d.to);
      const who = by(d.actor);
      if (n === null || to === null || who === null) return null;
      return `${plural(n, "card", "cards")} → ${to}${who}`.slice(0, LINE_MAX);
    }
    case "summary": {
      const [m, st, c] = [d.mentions ?? 0, d.status ?? 0, d.commands ?? 0].map(count);
      if ([m, st, c].includes(null)) return null;
      const parts = [];
      if (m) parts.push(`${plural(m, "notification", "notifications")} (mentions, replies, assignments, reviews)`);
      if (st) parts.push(plural(st, "status change", "status changes"));
      if (c && commands) parts.push(plural(c, "/claude command", "/claude commands"));
      return parts.length ? `while you were away: ${parts.join(", ")}`.slice(0, LINE_MAX) : null;
    }
    default:
      return null;
  }
  return (s + tail).slice(0, LINE_MAX);
}

/** An incremental Server-Sent Events parser: `push(text)` calls `onEvent({ id, event, data })` for every complete frame. */
export function sseParser(onEvent) {
  let buf = "";
  let ev = { event: "", data: [], size: 0 };
  let lastId;
  const line = (l) => {
    if (l === "") {
      if (ev.data.length || ev.event) onEvent({ id: lastId, event: ev.event || "message", data: ev.data.join("\n") });
      ev = { event: "", data: [], size: 0 };
      return;
    }
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const name = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") ev.event = value;
    else if (name === "data") {
      ev.size += value.length + 1;
      if (ev.size <= DATA_MAX) ev.data.push(value);
    } else if (name === "id" && !value.includes("\0")) lastId = value;
  };
  return {
    push(text) {
      buf += text;
      if (buf.length > BUFFER_MAX) throw new Error("stream line too long");
      // a CR at the very end may be the first half of a CRLF: it waits for the next chunk
      const hold = buf.endsWith("\r") ? "\r" : "";
      const parts = (hold ? buf.slice(0, -1) : buf).split(/\r\n|\n|\r/);
      buf = parts.pop() + hold;
      for (const l of parts) line(l);
    },
  };
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export async function main({ env = process.env, cwd = process.cwd(), write = (l) => process.stdout.write(`${l}\n`), signal: outer } = {}) {
  const tok = readToken(env);
  if (tok.loose) {
    write(safeLine(`${prefix}: the token file is readable by others; run chmod 600 ${tok.loose}`));
    return;
  }
  if (!tok.token) return;
  const token = tok.token;
  const project = projectOf(cwd, env);
  if (!project) return;
  let base;
  try {
    base = baseUrl(env);
  } catch (e) {
    write(safeLine(`${prefix}: ${e.message}`, token));
    return;
  }
  const out = (line) => write(safeLine(line, token, LINE_MAX));
  const sec = secondMs(env, "SPRINTREE_LISTEN_TEST_BACKOFF_MS", base.local);
  const session = sessionId(env);
  const label = labelOf(cwd);
  const sessFile = sessionFile(env);
  const files = [sessFile, defaultFile(env)];
  const sigOf = () =>
    files
      .map((f) => {
        try {
          const st = f ? statSync(f, { throwIfNoEntry: false }) : undefined;
          return st ? `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}` : "-";
        } catch {
          return "err"; // EACCES and the like: readCommandsState reads an unreadable file as off
        }
      })
      .join("|");
  let sig = sigOf();
  let state = readCommandsState(env);
  /** The effective commands state, re-read only when a setting file changed (a cheap stat). */
  const current = () => {
    const s = sigOf();
    if (s !== sig) {
      sig = s;
      state = readCommandsState(env);
    }
    return state;
  };
  let applied = state.value; // what the current (or next) connection announces in X-Stream-Commands
  let connAbort = null; // aborts the connection in flight
  let switching = false; // the abort is a commands change, not a failure
  const url = `${base.origin}/api/stream?project=${encodeURIComponent(project)}`;

  const ctl = new AbortController();
  const stop = () => ctl.abort();
  outer?.addEventListener("abort", stop, { once: true });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.on?.("error", stop); // the reader of our stdout is gone

  setupSessionFiles();
  const dirs = [path.join(configDir(env), "sessions"), configDir(env)];
  const watchers = [];
  for (const d of dirs) {
    try {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      const w = watch(d, { persistent: false }, () => check());
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      // no watch here: the interval below still sees the change
    }
  }
  let touchedAt = Date.now();
  const poll = setInterval(() => {
    check();
    if (Date.now() - touchedAt > DAY_MS) {
      touchedAt = Date.now();
      touchOwn();
    }
  }, 2 * sec);
  poll.unref?.();

  const repeated = dedupe(1000); // the server may re-send recent frames after a reconnect
  let lastId;
  let helloLabel = null; // the label the server last said hello with
  let backoff = sec;
  let outageSince = null;
  let lostPrinted = false;

  try {
    await loop();
  } finally {
    ctl.abort();
    clearInterval(poll);
    for (const w of watchers) w.close();
  }

  /** Refresh the own session file's mtime so the 30-day sweep (here and in other monitors) keeps a live or resumed session's setting. */
  function touchOwn() {
    if (!sessFile) return;
    try {
      const now = new Date();
      utimesSync(sessFile, now, now);
      sig = sigOf(); // an mtime-only change is not a setting change: no re-read
    } catch {
      // no session file (ENOENT) or not ours: nothing to keep
    }
  }

  /** Delete own stale ack and session files older than 30 days (only files with the expected name). */
  function setupSessionFiles() {
    touchOwn(); // before the sweep; the own ack is removed just below and rewritten by the first hello
    const own = ackFile(env);
    try {
      if (own) unlinkSync(own);
    } catch {
      // none yet
    }
    const dir = path.join(configDir(env), "sessions");
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!SESSION_FILE_RE.test(n)) continue;
      try {
        const st = lstatSync(path.join(dir, n));
        if (!st.isFile() || Date.now() - st.mtimeMs <= SESSION_FILE_MAX_AGE_MS) continue;
        const f = path.join(dir, n);
        // only a session file that reads cleanly as "on" is swept; an "off", a loose or a malformed one is kept (the reader
        // counts them as off, and deleting would let the session fall back to the default)
        if (n.endsWith(".json")) {
          let on = false;
          try {
            on = st.size < 4096 && (process.platform === "win32" || (st.mode & 0o077) === 0) && JSON.parse(readFileSync(f, "utf8"))?.commands === "on";
          } catch {
            // unreadable or not JSON: keep it
          }
          if (!on) continue;
        }
        unlinkSync(f);
      } catch {
        // gone or not ours to delete
      }
    }
  }

  /** The setting may have changed: say so once, and have the connection in flight replaced (no backoff). */
  function check() {
    try {
      const v = current().value;
      if (v === applied) return;
      applied = v;
      out(`${prefix} /claude commands ${v ? "on" : "off"}`);
      if (connAbort) {
        switching = true;
        connAbort();
      }
    } catch {
      // a timer or watch callback must never throw out and kill the monitor
    }
  }

  async function loop() {
    while (!ctl.signal.aborted) {
      let retryAfter = 0;
      let connectedAt = 0;
      const conn = new AbortController();
      const onStop = () => conn.abort();
      ctl.signal.addEventListener("abort", onStop, { once: true });
      try {
        check();
        connAbort = () => conn.abort();
        const headers = {
          Authorization: `Bearer ${token}`,
          "X-Stream-Session": session,
          "X-Stream-Label": label,
          "X-Stream-Commands": applied ? "on" : "off",
          Accept: "text/event-stream",
        };
        if (lastId !== undefined && HEADER_ID_RE.test(lastId)) headers["Last-Event-ID"] = lastId;
        const res = await fetch(url, { headers, signal: conn.signal, redirect: "manual" });
        if (res.status !== 200) {
          const body = await readSmall(res);
          const ra = Number(res.headers.get("retry-after"));
          if (res.status === 401) return out(`${prefix}: the live-events token was rejected; run /sprintree:connect`);
          if (res.status === 404) return out(`${prefix}: project ${project} not found or not shared with you`);
          if (res.status === 429 && codeOf(body) === "connection_limit") return out(`${prefix}: 10 live connections already open; not connecting`);
          if (res.status === 409 && codeOf(body) === "session_detached") return out(`${prefix}: this session was detached in Settings; restart Claude Code after 10 minutes to reconnect`);
          if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) return out(`${prefix}: the server answered ${res.status}; not connecting`);
          if (Number.isFinite(ra) && ra > 0) retryAfter = Math.min(ra, RETRY_AFTER_MAX_S) * sec;
          throw new Error("retry");
        }
        if (!res.body) throw new Error("retry");
        connectedAt = Date.now();
        if (outageSince !== null) {
          if (lostPrinted) out(`${prefix}: reconnected`);
          outageSince = null;
          lostPrinted = false;
        }
        const parser = sseParser((f) => {
          if (f.id !== undefined) lastId = f.id;
          if (f.event === "hello") hello(f.data);
          else if (f.event === "sprintree") frame(f.data);
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        for (;;) {
          const idle = setTimeout(() => reader.cancel().catch(() => {}), IDLE_MS);
          let r;
          try {
            r = await reader.read();
          } finally {
            clearTimeout(idle);
          }
          if (r.done) break;
          parser.push(decoder.decode(r.value, { stream: true }));
        }
      } catch {
        // network error, 5xx, 429, stream end or a broken stream: reconnect below (an abort ends the loop)
      } finally {
        connAbort = null;
        ctl.signal.removeEventListener("abort", onStop);
      }
      if (ctl.signal.aborted) break;
      if (switching) {
        switching = false; // a commands change: reconnect at once, not a failure
        continue;
      }
      if (connectedAt && Date.now() - connectedAt > 60 * sec) backoff = sec;
      if (outageSince === null) outageSince = Date.now();
      if (!lostPrinted && Date.now() - outageSince > 60 * sec) {
        out(`${prefix}: connection lost, retrying`);
        lostPrinted = true;
      }
      const jitter = 1 + (Math.random() * 0.4 - 0.2);
      await sleep(Math.max(retryAfter, Math.round(backoff * jitter)), ctl.signal);
      backoff = Math.min(backoff * 2, 60 * sec);
    }
  }

  function hello(data) {
    let d;
    try {
      d = JSON.parse(data);
    } catch {
      return;
    }
    const [s, l, p] = [d?.session, d?.label, d?.project].map(field);
    if (s === null || l === null || p === null) return;
    writeAck(d.commands);
    if (helloLabel === l) return; // a reconnect: nothing to say unless the label changed
    helloLabel = l;
    out(`${prefix} connected · session=${s} · name=${l} · project=${p}${current().value ? "" : " · /claude commands off"}`);
  }
  /** What the server said it knows: true, false or null (an older server). Only for a session with an id. */
  function writeAck(c) {
    const file = ackFile(env);
    if (!file) return;
    try {
      writeAtomic(file, JSON.stringify({ commands: c === true ? true : c === false ? false : null, at: new Date().toISOString() }));
    } catch {
      // the status line then says the monitor has not confirmed
    }
  }
  function frame(data) {
    let d;
    try {
      d = JSON.parse(data);
    } catch {
      return;
    }
    if (d?.type === "command_skipped") {
      const [issue, ev] = [d.issue, d.ev].map(field);
      if (issue === null || ev === null || repeated(`command_skipped:${ev}`)) return;
      out(`${prefix} /claude command on ${issue} skipped · /claude commands are off in this session`);
      return;
    }
    const line = formatEvent(d, { commands: current().value });
    if (!line) return;
    if ((d.type === "status" || d.type === "notification" || d.type === "command") && repeated(`${d.type}:${d.ev}`)) return;
    out(line);
  }
}

async function readSmall(res) {
  try {
    const r = res.body?.getReader();
    if (!r) return "";
    let text = "";
    const dec = new TextDecoder();
    while (text.length < 4096) {
      const { done, value } = await r.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    r.cancel().catch(() => {});
    return text;
  } catch {
    return "";
  }
}

function codeOf(body) {
  try {
    return errorCode(JSON.parse(body));
  } catch {
    return "";
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const done = () => {
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 1000).unref(); // a keep-alive socket must not hold the process
  };
  main().then(done, done);
}
