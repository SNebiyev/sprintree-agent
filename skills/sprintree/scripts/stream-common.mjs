/**
 * Shared by listen.mjs (the live-events monitor) and connect.mjs (/sprintree:connect): where the live-events token lives, which
 * server they talk to, and what may be printed. Pure Node >= 18.7.0, no dependencies. The token is never printed; every line that
 * leaves these scripts goes through `safeLine`.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { scrub } from "./st.mjs";

export const DEFAULT_URL = "https://sprintree.com";
const TOKEN_RE = /^itns_[A-Za-z0-9_-]{20,}$/;

/** The config directory: ${XDG_CONFIG_HOME:-$HOME/.config}/sprintree. */
export function configDir(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || env.USERPROFILE || homedir(), ".config");
  return path.join(base, "sprintree");
}

/** The token file: <configDir>/stream-token. */
export function tokenFile(env = process.env) {
  return path.join(configDir(env), "stream-token");
}

/**
 * The origin the token in the token file was issued by: <configDir>/stream-token.origin (one line, written by connect.mjs after the
 * token). A sidecar, so the token file keeps its one-line shape that older scripts and the user read.
 */
export function tokenOriginFile(env = process.env) {
  return `${tokenFile(env)}.origin`;
}

/** The recorded origin of the token file (first line), or null (no record: a token from before 0.8.0 or a hand-written file). Never throws. */
export function readTokenOrigin(env = process.env, platform = process.platform) {
  try {
    const v = readSmall(tokenOriginFile(env), platform);
    return v && typeof v.text === "string" ? v.text.split(/\r?\n/)[0].trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * True when the token in the token file may be sent to `origin`: its recorded origin equals it; with no record (legacy) only the
 * default production origin qualifies, because that is where every legacy token came from unless SPRINTREE_URL was set.
 */
export function fileTokenFits(origin, env = process.env, platform = process.platform) {
  const recorded = readTokenOrigin(env, platform);
  return recorded ? recorded === origin : origin === new URL(DEFAULT_URL).origin;
}

/** The UUID-shaped session id: a hash of the Claude Code session id (a resumed session keeps it), else random. */
export function sessionId(env) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id) return randomUUID();
  const h = createHash("sha256").update(`sprintree-stream:${id}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The per-session commands setting: <configDir>/sessions/<hash>.json. Null without CLAUDE_CODE_SESSION_ID (a random id has no file). */
export const sessionFile = (env = process.env) => (env.CLAUDE_CODE_SESSION_ID ? path.join(configDir(env), "sessions", `${sessionId(env)}.json`) : null);
/** What the server last acknowledged for this session (written by the monitor): <configDir>/sessions/<hash>.ack. */
export const ackFile = (env = process.env) => (env.CLAUDE_CODE_SESSION_ID ? path.join(configDir(env), "sessions", `${sessionId(env)}.ack`) : null);
/** Where the running monitor of this session says who it is (pid, address): <configDir>/sessions/<hash>.live. */
export const liveFile = (env = process.env) => (env.CLAUDE_CODE_SESSION_ID ? path.join(configDir(env), "sessions", `${sessionId(env)}.live`) : null);

/** The Claude Code process id (CLAUDE_PID, which Claude Code exports to everything it starts), else null. */
export function claudePid(env = process.env) {
  const n = Number(env.CLAUDE_PID);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
/**
 * The pointer from a Claude Code process to its monitor: <configDir>/sessions/proc-<CLAUDE_PID>.json = { sid, pid, at }.
 * /clear gives a Claude Code process a new CLAUDE_CODE_SESSION_ID but the running monitor keeps the old one in its environment,
 * and the session id is what names the setting file. CLAUDE_PID does not change on /clear, is the same for the monitor and for the
 * slash-command script, and differs between two Claude Code processes in the same folder, so it is the key that finds the monitor.
 */
export const pointerFile = (env = process.env) => (claudePid(env) ? path.join(configDir(env), "sessions", `proc-${claudePid(env)}.json`) : null);

/** True when a process with this id exists (signal 0 sends nothing; EPERM still means it exists). */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** Reads and parses a small JSON file of ours; null when missing, loose, not a file or not JSON. */
export function readJson(file, platform = process.platform) {
  if (!file) return null;
  const r = readSmall(file, platform);
  if (!r || r.text === undefined) return null;
  try {
    const v = JSON.parse(r.text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The environment to use for the per-session files: when the monitor of this Claude Code process (found through the pointer, and
 * still running) was started under another session id (after /clear), the same env with that session id; else `env` itself.
 */
export function monitorEnv(env = process.env, platform = process.platform) {
  const p = readJson(pointerFile(env), platform);
  if (!p || typeof p.sid !== "string" || !p.sid || !pidAlive(p.pid)) return env;
  return { ...env, CLAUDE_CODE_SESSION_ID: p.sid };
}

/** What the running monitor of this session wrote: { address, pid } or null (no monitor, a dead one, or no address yet). */
export function readLive(env = process.env, platform = process.platform) {
  const v = readJson(liveFile(env), platform);
  return v && typeof v.address === "string" && v.address && pidAlive(v.pid) ? { address: v.address, pid: v.pid } : null;
}

/** The default for every session: <configDir>/commands-default (one line, on or off). */
export const defaultFile = (env = process.env) => path.join(configDir(env), "commands-default");

/** True only when SPRINTREE_COMMANDS is on, 1 or true (any case, trimmed): /claude commands reach the session only then. */
export function commandsOn(env) {
  return ["on", "1", "true"].includes((env?.SPRINTREE_COMMANDS || "").trim().toLowerCase());
}

/** Writes `text` to `file` (directory 0700, file 0600) through a temp file in the same directory and a rename. Throws on failure. */
export function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to do
    }
    throw e;
  }
}

/**
 * Reads a small settings file. Returns null when it does not exist, else { text } or { loose: true } (a POSIX file readable or writable
 * by group or others) or { bad: true } (not a regular file or unreadable).
 */
function readSmall(file, platform = process.platform) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch (e) {
    return e?.code === "ENOENT" ? null : { bad: true };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { bad: true };
    if (platform !== "win32" && (st.mode & 0o077) !== 0) return { loose: true };
    const buf = Buffer.alloc(512);
    return { text: buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8") };
  } catch {
    return { bad: true };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing to do
    }
  }
}

/** One layer: null (no file), or { value, reason? }. A loose or malformed file is { value: false, reason }, never a fall-through. */
function layer(file, parse, platform) {
  if (!file) return null;
  const r = readSmall(file, platform);
  if (r === null) return null;
  if (r.loose) return { value: false, reason: "loose" };
  if (r.bad) return { value: false, reason: "malformed" };
  const v = parse(r.text);
  return v === null ? { value: false, reason: "malformed" } : { value: v };
}

const onOff = (s) => (s === "on" ? true : s === "off" ? false : null);
const parseSession = (text) => {
  try {
    return onOff(JSON.parse(text)?.commands);
  } catch {
    return null;
  }
};
const parseDefault = (text) => onOff(text.split(/\r?\n/)[0].trim().toLowerCase());

/** The three layers on their own: { session, default, env } (each null or { value, reason? }; env is { value, raw } when set). */
export function readLayers(env = process.env, platform = process.platform) {
  const raw = (env.SPRINTREE_COMMANDS || "").trim();
  return {
    session: layer(sessionFile(env), parseSession, platform),
    default: layer(defaultFile(env), parseDefault, platform),
    env: raw ? { value: commandsOn(env), raw } : null,
  };
}

/**
 * Whether /claude commands are on: the session file, else the default file, else SPRINTREE_COMMANDS, else off.
 * { value: true|false, source: "session"|"default"|"env"|"none", reason?: "loose"|"malformed", ack? } where ack is "on", "off" or
 * "unknown" (the server sent none) once the monitor has written one. Never throws.
 */
export function readCommandsState(env = process.env, platform = process.platform) {
  const l = readLayers(env, platform);
  const [source, hit] = l.session ? ["session", l.session] : l.default ? ["default", l.default] : l.env ? ["env", l.env] : ["none", { value: false }];
  const state = { value: hit.value, source };
  if (hit.reason) state.reason = hit.reason;
  const a = readSmall(ackFile(env) ?? "", platform);
  if (a?.text !== undefined) {
    try {
      const c = JSON.parse(a.text)?.commands;
      state.ack = c === true ? "on" : c === false ? "off" : "unknown";
    } catch {
      // an unreadable ack counts as none
    }
  }
  return state;
}

/**
 * When the setting in force was written and when the monitor's ack was written, in ms (null when unknown): { setAt, ackAt }. setAt is the
 * session file's `at` for a session setting, the default file's mtime for the default, null for SPRINTREE_COMMANDS or nothing. Never throws.
 */
export function readSettingTimes(env = process.env, platform = process.platform) {
  const l = readLayers(env, platform);
  const ms = (v) => {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? null : t;
  };
  let setAt = null;
  let ackAt = null;
  try {
    if (l.session) setAt = ms(JSON.parse(readSmall(sessionFile(env), platform)?.text)?.at);
    else if (l.default) setAt = statSync(defaultFile(env)).mtimeMs;
  } catch {
    // no usable time: the caller then makes no claim
  }
  try {
    ackAt = ms(JSON.parse(readSmall(ackFile(env) ?? "", platform)?.text)?.at);
  } catch {
    // none
  }
  return { setAt, ackAt };
}

/** The error code of a server answer: {"error":{"code"}} (the real envelope), else a flat {"code"} or {"error":"code"}. "" when there is none. */
export function errorCode(json) {
  if (typeof json?.error?.code === "string") return json.error.code;
  if (typeof json?.code === "string") return json.code;
  return typeof json?.error === "string" ? json.error : "";
}

/** True when `t` is shaped like a live-events token (itns_ and at least 20 token characters). */
export const isStreamToken = (t) => typeof t === "string" && TOKEN_RE.test(t);

/** The server's origin: SPRINTREE_URL (https, or http for localhost and 127.0.0.1 only), else sprintree.com. Throws a message without the value. */
export function baseUrl(env = process.env) {
  const raw = (env.SPRINTREE_URL || "").trim() || DEFAULT_URL;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("SPRINTREE_URL is not a valid URL");
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.username || u.password || u.host === "") throw new Error("SPRINTREE_URL must not hold credentials");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("SPRINTREE_URL must be https (plain http only for localhost and 127.0.0.1)");
  return { origin: u.origin, local };
}

/** The scale of the test knobs: only honoured against localhost, so a real run never reads them. Returns ms per "second", or 1000. */
export function secondMs(env, name, local) {
  if (!local) return 1000;
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 1000;
}

/**
 * The token from SPRINTREE_STREAM_TOKEN, else from the token file (first line). Returns { token } or { missing: true } or { loose: path }
 * (a POSIX file readable by group or others is refused). Never throws.
 */
export function readToken(env = process.env, platform = process.platform) {
  const fromEnv = (env.SPRINTREE_STREAM_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
  if (fromEnv) return isStreamToken(fromEnv) ? { token: fromEnv } : { missing: true };
  const file = tokenFile(env);
  let fd;
  try {
    fd = openSync(file, "r");
    const st = fstatSync(fd);
    if (!st.isFile()) return { missing: true };
    if (platform !== "win32" && (st.mode & 0o077) !== 0) return { loose: file };
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf8").split(/\r?\n/)[0].trim();
    return isStreamToken(first) ? { token: first } : { missing: true };
  } catch {
    return { missing: true };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

/** One printable line: tokens hidden, control and invisible characters removed, no line break, cut to `max`. */
export function safeLine(text, token = "", max = 300) {
  const s = scrub(String(text), { SPRINTREE_TOKEN: token }).replace(/[\r\n]+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}
