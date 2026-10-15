/**
 * Shared by listen.mjs (the live-events monitor) and connect.mjs (/sprintree:connect): where the live-events token lives, which
 * server they talk to, and what may be printed. Pure Node >= 18.7.0, no dependencies. The token is never printed; every line that
 * leaves these scripts goes through `safeLine`.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { scrub } from "./st.mjs";

export const DEFAULT_URL = "https://sprintree.com";
export const TOKEN_PREFIX = "itns_";
const TOKEN_RE = /^itns_[A-Za-z0-9_-]{20,}$/;

/** The token file: ${XDG_CONFIG_HOME:-$HOME/.config}/sprintree/stream-token. */
export function tokenFile(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || env.USERPROFILE || homedir(), ".config");
  return path.join(base, "sprintree", "stream-token");
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
