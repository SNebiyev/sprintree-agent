#!/usr/bin/env node
/**
 * /sprintree:connect: get a live-events token (itns_...) with the device flow and save it where listen.mjs reads it.
 * Pure Node >= 18.7.0, no dependencies.
 *
 *   node connect.mjs start   # asks for a code, prints the link and the code, saves the pending request (0600) and exits at once
 *   node connect.mjs wait    # waits for the approval of that request, saves the token, removes the pending request
 *   node connect.mjs         # both in one process (for agents that show the output of a running command)
 *
 * Claude Code runs a long command in the background, so the code printed by a single run is not seen while the browser page asks the
 * user to compare it: the slash command runs `start` first (short, its output is shown), then `wait`.
 * The poll carries `replaces`: the token this file holds now, so the server revokes it when it issues the new one (an older server
 * ignores the unknown field). It is sent only to the server that issued that token: the origin is recorded next to the token file in
 * stream-token.origin (a token without a record counts as issued by sprintree.com).
 *
 * The token is written to ${XDG_CONFIG_HOME:-$HOME/.config}/sprintree/stream-token (directory 0700, file 0600, written to a temp file in
 * the same directory and renamed) and is never printed. SPRINTREE_URL points at another server (https, or http for localhost).
 * Exit 0: connected. Exit 1: denied, expired, refused or unreachable.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { isMainModule, stripControls } from "./st.mjs";
import { baseUrl, configDir, errorCode, fileTokenFits, isStreamToken, readJson, readToken, safeLine, secondMs, tokenFile, tokenOriginFile, writeAtomic } from "./stream-common.mjs";

const SAFE_URL_RE = /^https?:\/\/[A-Za-z0-9._~:/?#=%@!$'()*+,;-]+$/; // no space, quote, & ^ | < > or backslash: nothing a shell or cmd.exe would act on

class Failure extends Error {}

/** The machine's name as the server may show it: [A-Za-z0-9._-], at most 100 characters. */
export const clientName = (name = hostname()) => String(name).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100) || "computer";

/** Opens `url` in the browser without a shell. Failure is ignored: the link is printed anyway. */
function openBrowser(url, platform = process.platform) {
  if (!SAFE_URL_RE.test(url)) return;
  const [cmd, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try {
    const c = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    c.on("error", () => {});
    c.unref();
  } catch {
    // no browser: the link is on screen
  }
}

/** Writes the token atomically: a 0700 directory, a 0600 temp file next to the target, then a rename. Returns true when a file was replaced. */
export function saveToken(file, token) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const replaced = existsSync(file);
  const tmp = path.join(dir, `.stream-token.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(tmp, 0o600); // a umask never loosens it, but be sure
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return replaced;
}

/** Records which server issued the token just saved (stream-token.origin). Without the record the token counts as sprintree.com's, so a failed write drops a stale one. */
function saveOrigin(env, origin) {
  try {
    writeAtomic(tokenOriginFile(env), `${origin}\n`);
  } catch {
    rmSync(tokenOriginFile(env), { force: true });
  }
}

// `soft`: a network error or timeout answers { status: 0 } instead of throwing (the token poll retries it).
async function post(origin, route, body, soft = false, timeoutMs = 15_000) {
  let res;
  try {
    res = await fetch(`${origin}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    if (soft) return { status: 0, json: null };
    throw new Failure("Could not reach the server. Check the connection and run /sprintree:connect again.");
  }
  let json = null;
  try {
    json = JSON.parse((await res.text()).slice(0, 65536));
  } catch {
    // not JSON, or the body could not be read
  }
  return { status: res.status, json };
}

const EXPIRED_AT_DEADLINE = "The code expired. Run /sprintree:connect again. If you approved it, revoke the unused stream token in Settings > API & MCP > Personal access tokens.";

const word = (v, max = 64) => (typeof v === "string" ? stripControls(v).replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The pending device request written by `start` and read by `wait`: <configDir>/connect-device.json (0600). */
export const deviceFile = (env = process.env) => path.join(configDir(env), "connect-device.json");

/** Asks the server for a code and prints the link and the code. Returns the pending request (device_code, interval, expires_at in ms, origin). */
async function startDevice({ env, log, base, unit }) {
  const start = await post(base.origin, "/api/stream/device", { client_name: clientName() });
  const d = start.json;
  const userCode = word(d?.user_code, 32);
  const link = word(d?.verification_uri_complete, 2048);
  const deviceCode = typeof d?.device_code === "string" ? d.device_code : "";
  if (start.status !== 200 || !userCode || !link || !deviceCode) {
    throw new Failure(`The server did not start the connection (HTTP ${start.status}). Try again later.`);
  }
  log(`Open ${link} and check that it shows the code ${userCode}, then approve.`);
  // the browser opens only for a link on the server we talk to; any other link is on screen for the user to judge
  let sameSite = false;
  try {
    sameSite = new URL(link).origin === base.origin;
  } catch {
    // not a URL
  }
  if (sameSite && !env.SPRINTREE_CONNECT_NO_BROWSER) openBrowser(link);
  const expiresIn = Math.min(Math.max(Number(d.expires_in) || 600, 1), 3600);
  return { origin: base.origin, device_code: deviceCode, interval: Number(d.interval) || 5, expires_at: Date.now() + expiresIn * unit };
}

/** Reads the pending request `start` saved; throws a Failure when there is none or it is for another server. */
function readPending(env, base) {
  const p = readJson(deviceFile(env));
  if (!p || typeof p.device_code !== "string" || !p.device_code || p.origin !== base.origin || !Number.isFinite(p.expires_at)) {
    throw new Failure("There is no pending connection. Run /sprintree:connect again.");
  }
  return p;
}

export async function main({ env = process.env, log = (l) => process.stdout.write(`${l}\n`), mode = "all" } = {}) {
  const processStart = Date.now(); // the 570 s budget counts from here, the start POST included
  let base;
  try {
    base = baseUrl(env);
  } catch (e) {
    throw new Failure(e.message);
  }
  const unit = secondMs(env, "SPRINTREE_CONNECT_TEST_SECOND_MS", base.local);

  if (mode === "start") {
    const pending = await startDevice({ env, log, base, unit });
    try {
      writeAtomic(deviceFile(env), `${JSON.stringify(pending)}\n`);
    } catch {
      throw new Failure("Could not save the pending connection (check the permissions of the sprintree config directory).");
    }
    return;
  }
  const pending = mode === "wait" ? readPending(env, base) : await startDevice({ env, log, base, unit });
  try {
    await pollDevice({ env, log, base, unit, pending, processStart });
  } finally {
    if (mode === "wait") rmSync(deviceFile(env), { force: true });
  }
}

async function pollDevice({ env, log, base, unit, pending, processStart }) {
  const deviceCode = pending.device_code;
  // the token this file holds now (not SPRINTREE_STREAM_TOKEN) is the one the new token replaces, if it came from this server
  const old = fileTokenFits(base.origin, env) ? readToken({ ...env, SPRINTREE_STREAM_TOKEN: "" }).token : undefined;
  const MAX_INTERVAL = 60;
  let interval = Math.min(Math.max(Number(pending.interval) || 5, 1), MAX_INTERVAL);
  const grow = () => {
    interval = Math.min(interval + 5, MAX_INTERVAL);
  };
  // 30 s under the 600 s Bash timeout of commands/connect.md. The last FINAL of it is kept for the last poll's request:
  // the clipped sleep ends at deadline - FINAL, so an approval up to FINAL before the deadline is fetched. No poll follows
  // it at once (the server answers slow_down to a poll that comes too soon)
  const deadline = Math.min(pending.expires_at, processStart + 570 * unit);
  const MIN_REQUEST_MS = Math.max(1, Math.min(250, unit)); // less than this is left: no request is worth starting
  const FINAL = Math.min(5 * unit, 15_000);
  for (;;) {
    const wait = Math.min(interval * unit, deadline - Date.now() - FINAL);
    if (wait <= 0) break;
    await new Promise((r) => setTimeout(r, wait));
    const remaining = deadline - Date.now();
    if (remaining < MIN_REQUEST_MS) break;
    const r = await post(base.origin, "/api/stream/device/token", { device_code: deviceCode, ...(old ? { replaces: old } : {}) }, true, Math.min(15_000, remaining));
    if (r.status === 200 && (!r.json || typeof r.json !== "object")) {
      throw new Failure(`The server answered 200 but the reply could not be read, so a token may have been created. Revoke the unused stream token in Settings > API & MCP > Personal access tokens, then run /sprintree:connect again.`);
    }
    if (r.status === 200) {
      const token = typeof r.json.token === "string" ? r.json.token.trim() : "";
      if (!isStreamToken(token)) throw new Failure("The server answered without a usable token. Nothing was saved.");
      const file = tokenFile(env);
      const replaced = saveToken(file, token);
      saveOrigin(env, base.origin);
      log("Connected. Restart this Claude Code session to start live events (monitors start with the session).");
      if (replaced) log("This replaced the previous token in that file. The server revokes the old token itself; if an older server left it listed in Settings > API & MCP > Personal access tokens, revoke that one (not the new token).");
      return;
    }
    const code = errorCode(r.json);
    if (r.status === 400) {
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        grow();
        continue;
      }
      if (code === "access_denied") throw new Failure("Denied in the browser. Nothing was saved.");
      if (code === "expired_token") throw new Failure("The code expired. Run /sprintree:connect again.");
    }
    if (r.status === 409 && code === "too_many_tokens") throw new Failure("This account already has 20 stream tokens. Revoke one in Settings, then run /sprintree:connect again.");
    if (r.status === 429) {
      grow();
      continue;
    }
    // a hiccup (network error, timeout, 5xx, 408) is waited out like a pending approval, until the deadline
    if (r.status === 0 || r.status === 408 || r.status >= 500) {
      grow();
      continue;
    }
    throw new Failure(`The server refused the connection (HTTP ${r.status}). Nothing was saved.`);
  }
  throw new Failure(EXPIRED_AT_DEADLINE);
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const arg = process.argv[2];
  const mode = arg === "start" || arg === "wait" ? arg : "all";
  main({ mode }).then(
    () => {
      process.exitCode = 0;
      setTimeout(() => process.exit(0), 1000).unref();
    },
    (e) => {
      // only our own messages are printed: an unexpected error (a full disk) shows its text, which never holds the token
      process.stderr.write(`${safeLine(e instanceof Failure ? e.message : `Could not save the token: ${e?.code ?? "error"}`)}\n`);
      process.exit(1);
    }
  );
}
