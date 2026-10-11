#!/usr/bin/env node
/**
 * Sprintree MCP over plain JSON-RPC (Streamable HTTP). Pure Node >= 18.8.0, no shell utilities,
 * works on Linux, macOS and Windows. Use it when the agent has no `sprintree` MCP server connected.
 *
 *   node st.mjs tools                      # tool names + argument names
 *   node st.mjs schema <tool>              # one tool's description and input schema
 *   node st.mjs call <tool> '<json-args>'  # call a tool, print its text result
 *   node st.mjs call <tool> @args.json     # same, arguments read from a file (long Markdown)
 *   node st.mjs call <tool> - < args.json  # same, arguments read as JSON from stdin
 *   node st.mjs version                    # print the version of this script
 *   node st.mjs key [dir]                  # resolve the project key for a repo (default: cwd)
 *   node st.mjs config [dir]               # print the resolved project config (only the known keys)
 *
 * Auth: set SPRINTREE_TOKEN to a personal access token (itn_..., Settings -> API & MCP -> Personal access tokens).
 * "Bearer " is added when missing. The token is never printed. SPRINTREE_MCP_URL overrides
 * the endpoint (default https://sprintree.com/mcp; must be https unless the host is
 * localhost, 127.0.0.1 or ::1; redirects are refused). SPRINTREE_TIMEOUT_MS sets the per-request
 * timeout (a whole number of ms from 1 to 600000, default 30000).
 *
 * `.sprintree.json` and the doc files (AGENTS.md, CLAUDE.md, .claude/CLAUDE.md, GEMINI.md) are read by one
 * safe reader: a regular file of at most 1 MB, never a symlink, never hard-linked, and never resolved
 * outside the repo root (the directory holding .git; without a .git, outside the directory the file is in).
 * `config` prints only project, language, typography, statuses and section_titles (other keys are named
 * on stderr as ignored, their values are never printed); a key that looks like a token only warns, it does
 * not make the file safe to commit secrets in. Everything printed (server text, config, warnings, errors)
 * is stripped of terminal control sequences, bidi and zero-width characters first, and Sprintree tokens
 * (itn_, itna_, itnr_) are replaced by [token].
 *
 * OAuth: this fallback client is PAT-only on purpose. When an agent connects the Sprintree MCP
 * server with OAuth, that session (access/refresh tokens) lives in the agent's own keychain and
 * this script cannot reach it. No token means: use the connected MCP tools, or set a PAT.
 *
 * Windows: PowerShell 5.1 strips the inner double quotes of a native-command argument, so
 * inline JSON breaks there. Use `call <tool> @args.json` (the documented Windows path).
 *
 * A refusal (HTTP error, JSON-RPC error, isError, or a text answer starting with "Error:")
 * exits 1, so a failed write is never read as success.
 */
import {
  existsSync, statSync, lstatSync, realpathSync, readFileSync, openSync, fstatSync, readSync, closeSync, constants as FS_CONSTANTS,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One version source. A constant (not a read of ../../../package.json) so it keeps working when
// the skill folder is copied alone. A test (and scripts/check-version.mjs) keeps it equal to package.json.
export const VERSION = "0.1.0";
// The one minimum Node version: the runtime check, its message and package.json `engines.node` are built from
// or tested against it, and so is the CI matrix. A test fails when a doc states another one.
export const MIN_NODE = "18.8.0";
const DEFAULT_URL = "https://sprintree.com/mcp";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 600000;
const PROTOCOL_VERSION = "2025-06-18";
const REAL_FS = { existsSync, statSync, lstatSync, realpathSync, readFileSync, openSync, fstatSync, readSync, closeSync, constants: FS_CONSTANTS };
const MAX_TEXT_BYTES = 1024 * 1024; // config and doc files are small; anything bigger is not one
// The server's project key rule. Doc links and `.sprintree.json` are both checked against it.
const KEY_CHARS = "[A-Za-z][A-Za-z0-9]{0,9}";
const KEY_RE = new RegExp(`sprintree\\.com/p/(${KEY_CHARS})\\b`, "g");
const PROJECT_RE = new RegExp(`^${KEY_CHARS}$`);
const PLACEHOLDER_KEY = "KEY"; // the template link is https://sprintree.com/p/KEY
export const KNOWN_CONFIG_KEYS = ["project", "language", "typography", "statuses", "section_titles"];
const DOC_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", path.join(".claude", "CLAUDE.md")];
const PAT_HINT = "tokens start with itn_; create one under Settings -> API & MCP -> Personal access tokens";

/** Decode a text file: strips a UTF-8 BOM, reads UTF-16LE (FF FE), refuses UTF-16BE (FE FF). */
function decodeText(data, label = "file") {
  if (typeof data === "string") return data.replace(/^\uFEFF/, "");
  const b = Buffer.from(data);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  if (b[0] === 0xfe && b[1] === 0xff) throw new Error(`${label} is UTF-16BE, which is not supported; save it as UTF-8`);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString("utf8");
  return b.toString("utf8");
}

/** Walk from `dir` up to the filesystem root (stops after the first dir holding .git). */
export function* ancestors(dir, { path: p = path, fs = REAL_FS } = {}) {
  let cur = p.resolve(dir);
  for (;;) {
    yield cur;
    if (fs.existsSync(p.join(cur, ".git"))) return;
    const up = p.dirname(cur);
    if (up === cur) return;
    cur = up;
  }
}

const SECRET_KEY_RE = /token|secret|password|(^|[^a-z])pat($|[^a-z])/i;
// Sprintree tokens: personal access tokens (itn_) and OAuth access/refresh tokens (itna_, itnr_). Same rule as .gitleaks.toml.
const TOKEN_SRC = String.raw`\bitn[ar]?_[A-Za-z0-9_-]{20,}`;
const TOKEN_PREFIX_RE = /^(Bearer\s+)?itn[ar]?_/i;

/** Dotted paths of keys/values in a parsed config that look like a credential. Values are never returned. */
function suspiciousPaths(obj, prefix = "") {
  const found = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const here = prefix + k;
    if (SECRET_KEY_RE.test(k) || new RegExp(TOKEN_SRC).test(k) || (typeof v === "string" && TOKEN_PREFIX_RE.test(v.trim()))) found.push(here);
    else if (v && typeof v === "object" && !Array.isArray(v)) found.push(...suspiciousPaths(v, here + "."));
  }
  return found;
}

function checkProjectKey(key, where) {
  if (typeof key !== "string" || !PROJECT_RE.test(key)) {
    throw new Error(`${where}: invalid project key (1 to 10 letters or digits, starting with a letter, like the key in a Sprintree URL)`);
  }
  if (key.toUpperCase() === PLACEHOLDER_KEY) {
    throw new Error(`${where}: the project key is still the placeholder ${PLACEHOLDER_KEY}; replace it with your project's key (list_projects shows it)`);
  }
}

/** The directory holding .git above `dir` (the repo root), or null when the walk reaches the filesystem root without one. */
function repoRoot(dir, p, fs) {
  let last = null;
  for (const d of ancestors(dir, { path: p, fs })) last = d;
  return last !== null && fs.existsSync(p.join(last, ".git")) ? last : null;
}

/**
 * Read one local text file safely: a regular file of at most 1 MB, decoded (UTF-8 BOM, UTF-16LE).
 * Returns null when it does not exist (or, without `follow`, is not a regular file).
 * Without `follow` (config and doc files) it throws for a symlink, a hard-linked file, a file whose real path
 * leaves `contain` (a directory; default: the file's own) and a size over the limit, and it opens the file
 * with O_NOFOLLOW (where the OS has it) and checks the opened descriptor again, so a swap between the check and
 * the open cannot redirect the read. `follow` is for the explicit `@file` argument: a symlink is fine there.
 */
function readTextFile(f, fs, { contain = null, follow = false, path: p = path } = {}) {
  let st;
  try {
    st = follow ? fs.statSync(f) : fs.lstatSync(f);
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
  if (!follow && st.isSymbolicLink()) throw new Error(`${f} is a symlink; refusing to read it (put a regular file there)`);
  if (!st.isFile()) {
    if (follow) throw new Error(`${f} is not a regular file`);
    return null;
  }
  const refuseHardLink = () => {
    throw new Error(`${f} has more than one hard link; refusing to read it`);
  };
  const refuseSize = () => {
    throw new Error(`${f} is larger than 1 MB; refusing to read it`);
  };
  if (!follow && st.nlink > 1) refuseHardLink();
  if (st.size > MAX_TEXT_BYTES) refuseSize();
  if (contain) {
    const rel = p.relative(fs.realpathSync(contain), fs.realpathSync(f));
    if (rel === ".." || rel.startsWith(".." + p.sep) || p.isAbsolute(rel)) {
      throw new Error(`${f} resolves outside the repo it was found in; refusing to read it`);
    }
  }
  let data;
  if (typeof fs.openSync === "function") {
    let fd;
    try {
      fd = fs.openSync(f, fs.constants.O_RDONLY | (follow ? 0 : fs.constants.O_NOFOLLOW ?? 0));
    } catch (e) {
      if (e?.code === "ELOOP") throw new Error(`${f} is a symlink; refusing to read it (put a regular file there)`);
      throw e;
    }
    try {
      const open = fs.fstatSync(fd);
      if (!open.isFile()) throw new Error(`${f} is not a regular file`);
      if (!follow && open.nlink > 1) refuseHardLink();
      if (open.size > MAX_TEXT_BYTES) refuseSize();
      const buf = Buffer.alloc(open.size);
      let got = 0;
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, null);
        if (!n) break;
        got += n;
      }
      data = buf.subarray(0, got);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    data = fs.readFileSync(f); // a stand-in file system without descriptors (tests)
  }
  return decodeText(data, f);
}

/** Read and parse one `.sprintree.json`: no symlink, no escape from the repo, never echoes file content. */
function readConfigFile(f, root, dir, fs, p) {
  const text = readTextFile(f, fs, { contain: root ?? dir, path: p });
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${f} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${f} must contain a JSON object`);
  return parsed;
}

/**
 * The project key from a `sprintree.com/p/<KEY>` link in a doc file, nearest directory first: every link of a file is
 * looked at, the template placeholder (`.../p/KEY`) is skipped. Returns { key (upper-case), file } or null. A doc file
 * that is refused (symlink, hard link, too large, UTF-16BE) is skipped with a warning, never read.
 * Throws only when the placeholder is the sole link found. opts: { path, fs, warn(line) }.
 */
export function findDocKey(dir, opts = {}) {
  const p = opts.path ?? path;
  const fs = opts.fs ?? REAL_FS;
  const root = repoRoot(dir, p, fs);
  let placeholderIn = null;
  for (const d of ancestors(dir, { path: p, fs })) {
    for (const name of DOC_FILES) {
      const f = p.join(d, name);
      let text;
      try {
        text = readTextFile(f, fs, { contain: root ?? d, path: p });
      } catch (e) {
        opts.warn?.(`Warning: skipped ${e.message}`);
        continue;
      }
      if (text === null) continue;
      for (const m of text.matchAll(KEY_RE)) {
        if (m[1].toUpperCase() === PLACEHOLDER_KEY) {
          placeholderIn ??= f;
          continue;
        }
        return { key: m[1].toUpperCase(), file: f };
      }
    }
  }
  if (placeholderIn) checkProjectKey(PLACEHOLDER_KEY, placeholderIn);
  return null;
}

/**
 * Project config: `.sprintree.json` (nearest wins), then a `sprintree.com/p/<KEY>` link in a doc file.
 * Only the known keys are returned. opts: { path (default node:path, pass path.win32 to test Windows
 * paths), fs, warn(line) }. Every warn line has its control sequences stripped.
 */
export function resolveConfig(dir, opts = {}) {
  const p = opts.path ?? path;
  const fs = opts.fs ?? REAL_FS;
  const warn = opts.warn ? (line) => opts.warn(stripControls(line)) : null;
  const root = repoRoot(dir, p, fs);
  const config = {};
  let source = null;
  for (const d of ancestors(dir, { path: p, fs })) {
    const f = p.join(d, ".sprintree.json");
    const parsed = readConfigFile(f, root, d, fs, p);
    if (!parsed) continue;
    for (const k of KNOWN_CONFIG_KEYS) if (Object.hasOwn(parsed, k)) config[k] = parsed[k];
    if (Object.hasOwn(parsed, "project")) {
      checkProjectKey(parsed.project, f);
      config.project = parsed.project.toUpperCase();
    }
    source = f;
    const bad = suspiciousPaths(parsed);
    const ignored = Object.keys(parsed).filter((k) => !KNOWN_CONFIG_KEYS.includes(k) && !bad.includes(k));
    if (warn) {
      if (ignored.length) warn(`Warning: ${f}: ignored unknown key(s): ${ignored.join(", ")} (only ${KNOWN_CONFIG_KEYS.join(", ")} are used)`);
      if (bad.length) {
        warn(
          `Warning: ${f} has ${bad.length === 1 ? "a key that looks" : "keys that look"} like a token (${bad.join(", ")}). ` +
            "Never commit tokens: keep them in the SPRINTREE_TOKEN environment variable and remove them from this file."
        );
      }
    }
    break;
  }
  if (!config.project) {
    const found = findDocKey(dir, { path: p, fs, warn });
    if (found) {
      config.project = found.key;
      source = source ?? found.file;
    }
  }
  return source ? { ...config, _source: source } : config;
}

/** Refuse a plain-http endpoint unless it is local, so the token never crosses the network in clear. */
export function checkMcpUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`SPRINTREE_MCP_URL is not a valid URL: ${raw}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.href;
  throw new Error(
    `SPRINTREE_MCP_URL must be https (plain http is only allowed for localhost, 127.0.0.1 and ::1), got ${u.protocol}//${u.host}`
  );
}

/**
 * True when this module is the process entry point. Compares realpaths, so a symlink (for example a
 * node_modules/.bin link) and a different Windows drive-letter case still count. Shared by the scripts.
 */
export function isMainModule(argv1, metaUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Pick the JSON-RPC message answering request `id` from a JSON or SSE body (multi-line data frames joined). */
function pickMessage(text, id) {
  const trimmed = text.trim();
  let candidates = [];
  if (/^(event:|data:|id:|retry:|:)/.test(trimmed)) {
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data.trim()) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        /* ignore an unreadable frame, a later one may match */
      }
    }
  } else {
    const parsed = JSON.parse(trimmed);
    candidates = Array.isArray(parsed) ? parsed : [parsed];
  }
  return candidates.find((m) => m && m.id === id);
}

function authHeader(env) {
  const t = (env.SPRINTREE_TOKEN || "").trim();
  if (!t) {
    throw new Error(
      `No token. Set SPRINTREE_TOKEN to a Sprintree personal access token (${PAT_HINT}), ` +
        "or connect the Sprintree MCP server in your agent (OAuth) and use its tools directly."
    );
  }
  return /^Bearer\s/i.test(t) ? t : `Bearer ${t}`;
}

// Terminal control sequences a hostile server (or a hostile config file name) could send: OSC/DCS/APC/PM/SOS strings
// (OSC 52 writes the clipboard), CSI and other ESC sequences, every remaining C0/C1 control except \n and \t, and
// the bidi / zero-width characters that make text read differently from what it is.
const STRING_SEQ_RE = /\u001b[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const ESC_SEQ_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]?|[ -/]*[0-~]?)/g;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text made safe to print on a terminal: control sequences removed (ESC sequences first, so one cannot be split). */
export function stripControls(text) {
  return String(text).replace(STRING_SEQ_RE, "").replace(ESC_SEQ_RE, "").replace(CONTROL_RE, "").replace(BIDI_RE, "");
}

/** The configured token and anything shaped like a Sprintree token (itn_, itna_, itnr_) replaced by [token]. */
function redact(text, env) {
  const t = (env.SPRINTREE_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
  const clean = t && t.length >= 6 ? String(text).split(t).join("[token]") : String(text);
  return clean.replace(new RegExp(TOKEN_SRC, "g"), "[token]");
}

/** Everything that is printed goes through this: control sequences first (so they cannot split the token), then the token. */
function scrub(text, env) {
  return redact(stripControls(text), env);
}

/** `v` ("18.20.8") >= `min` ("18.14.0"), compared part by part. */
function nodeAtLeast(v, min) {
  const a = String(v).split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

function timeoutMs(env) {
  const raw = env.SPRINTREE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= MAX_TIMEOUT_MS)) {
    throw new Error(`SPRINTREE_TIMEOUT_MS must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS} (default ${DEFAULT_TIMEOUT_MS})`);
  }
  return n;
}

/** What to tell the user about a failed fetch: the cause code (else a short cause text) and the host, never the path, query, userinfo or token. */
function networkMessage(e, url, host, env) {
  const cause = e?.cause;
  if (/redirect/i.test(String(cause?.message ?? e?.message ?? ""))) {
    return "server redirected; set SPRINTREE_MCP_URL to the final URL";
  }
  const code = String(cause?.code ?? e?.code ?? "").replace(/[^A-Za-z0-9_]/g, "");
  const text = cause?.message ? scrub(String(cause.message).split(url).join("[url]"), env).trim().slice(0, 80) : "";
  return `fetch failed: ${code || text || "unknown error"} ${host}`;
}

/** The `tools/list` answer of a connected client: the array of tools (shared by `tools`, `schema` and the snapshot refresh). */
export async function listTools(client) {
  const answer = await client.rpc("tools/list", {});
  if (!Array.isArray(answer?.tools)) throw new Error("the tools/list answer has no `tools` array");
  return answer.tools;
}

/** JSON-RPC client over Streamable HTTP. `connect()` runs the initialize handshake; `rpc(method, params)` returns the result. */
export function makeClient({ fetchImpl, env, warn }) {
  const url = checkMcpUrl(env.SPRINTREE_MCP_URL || DEFAULT_URL);
  const { host, hostname } = new URL(url);
  const auth = authHeader(env);
  const ms = timeoutMs(env);
  if (hostname !== "sprintree.com") warn?.(`Note: your SPRINTREE_TOKEN is sent to ${host} (SPRINTREE_MCP_URL), not to sprintree.com`);
  const excerpt = (text, n) => scrub(text, env).trim().slice(0, n);
  let sid = null;
  let protocol = null;
  let seq = 0;

  async function rpc(method, params, notify = false) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: auth,
    };
    if (sid) headers["Mcp-Session-Id"] = sid;
    if (protocol) headers["MCP-Protocol-Version"] = protocol;
    const body = { jsonrpc: "2.0", method, params };
    if (!notify) body.id = ++seq;
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(ms),
      });
      sid = res.headers.get("mcp-session-id") ?? sid;
      text = await res.text();
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new Error(`request to ${host} timed out after ${ms} ms (set SPRINTREE_TIMEOUT_MS to change)`);
      }
      throw new Error(networkMessage(e, url, host, env));
    }
    if (notify) return null;
    const said = () => {
      const t = excerpt(text, 300);
      return t ? ` Server said: ${t}` : "";
    };
    if (res.status === 401) throw new Error(`HTTP 401: invalid, expired or revoked token (${PAT_HINT}).${said()}`);
    if (res.status === 403) throw new Error(`HTTP 403: the token cannot do this (read-only token on a write tool?) - ${PAT_HINT}.${said()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${excerpt(text, 300)}`);
    let msg;
    try {
      msg = pickMessage(text, body.id);
    } catch {
      throw new Error(`Unreadable answer to ${method}: ${excerpt(text, 200)}`);
    }
    if (!msg) throw new Error(`no answer with id ${body.id} to ${method} in the response`);
    if (msg.error) throw new Error(`RPC ${method}: ${excerpt(JSON.stringify(msg.error), 300)}`);
    return msg.result;
  }

  async function connect() {
    const init = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "sprintree-agent", version: VERSION },
    });
    const negotiated = init?.protocolVersion;
    protocol = typeof negotiated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(negotiated) ? negotiated : PROTOCOL_VERSION;
    await rpc("notifications/initialized", {}, true);
  }

  return { rpc, connect };
}

/**
 * Run one CLI invocation. Returns the exit code; all I/O goes through `deps` so tests can mock it.
 * deps: { fetch, env, cwd, out(line), err(line), stdin(): Promise<string>, nodeVersion }
 */
export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const cwd = deps.cwd ?? process.cwd();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const readStdin = deps.stdin ?? readProcessStdin;
  const [cmd, a1, a2] = argv;
  try {
    if (cmd === "version") {
      out(VERSION);
      return 0;
    }
    const warn = (line) => err(scrub(line, env));
    if (cmd === "key" || cmd === "config") {
      const { _source, ...cfg } = resolveConfig(path.resolve(cwd, a1 || "."), { warn });
      if (cmd === "config") {
        // JSON.stringify escapes C0 but leaves DEL and C1 raw: escape them too, so the output is plain text and still valid JSON.
        const json = JSON.stringify(cfg, null, 2).replace(/[\u007f-\u009f]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`);
        out(scrub(json, env));
        return 0;
      }
      if (!cfg.project) {
        throw new Error(
          "No project key. Put a `sprintree.com/p/<KEY>` link in AGENTS.md, CLAUDE.md, .claude/CLAUDE.md or GEMINI.md, " +
            'or `{"project":"KEY"}` in .sprintree.json. Otherwise find it with list_projects.'
        );
      }
      out(cfg.project);
      return 0;
    }
    if (!nodeAtLeast(nodeVersion, MIN_NODE) || typeof fetchImpl !== "function") {
      throw new Error(
        `st.mjs needs Node.js ${MIN_NODE} or newer (global fetch); this is Node ${nodeVersion}${typeof fetchImpl === "function" ? "" : " without fetch"}. Upgrade Node: https://nodejs.org`
      );
    }
    if (!["tools", "schema", "call"].includes(cmd)) {
      throw new Error("usage: st.mjs tools | schema <tool> | call <tool> <json|@file.json|-> | key [dir] | config [dir] | version");
    }
    if (cmd === "schema" && !a1) throw new Error("usage: st.mjs schema <tool>");
    if (cmd === "call" && !a1) throw new Error("usage: st.mjs call <tool> '<json>' | @file.json | -");
    let args = {};
    if (cmd === "call") {
      let raw = a2 ?? "{}";
      if (raw === "-") {
        raw = await readStdin();
        if (!raw.trim()) throw new Error("no JSON arguments on stdin");
      } else if (raw.startsWith("@")) {
        const f = path.resolve(cwd, raw.slice(1));
        raw = readTextFile(f, REAL_FS, { follow: true });
        if (raw === null) throw new Error(`argument file not found: ${f}`);
      }
      try {
        args = JSON.parse(raw);
      } catch (e) {
        // V8's message quotes the start of the text; the text may be a file the agent should not echo, so only the position is kept.
        const at = /position (\d+)/.exec(e?.message ?? "");
        throw new Error(`arguments are not valid JSON${at ? ` (at position ${at[1]})` : ""}`);
      }
    }
    const client = makeClient({ fetchImpl, env, warn });
    await client.connect();
    if (cmd === "tools" || cmd === "schema") {
      const tools = await listTools(client);
      if (cmd === "tools") {
        for (const t of tools) out(scrub(`${t.name}(${Object.keys(t.inputSchema?.properties ?? {}).join(", ")})`, env));
      } else {
        const t = tools.find((x) => scrub(x?.name, env) === a1);
        if (!t) throw new Error(`no such tool: ${a1}`);
        out(scrub(t.description ?? "", env));
        out(scrub(JSON.stringify(t.inputSchema, null, 2), env));
      }
      return 0;
    }
    const result = await client.rpc("tools/call", { name: a1, arguments: args });
    const texts = (Array.isArray(result?.content) ? result.content : []).map((c) => String(c?.text ?? ""));
    out(scrub(texts.join("\n"), env));
    // Sprintree reports refusals as normal content starting with "Error:", in any content item.
    return result?.isError || texts.some((t) => /^Error:/.test(stripControls(t).trimStart())) ? 1 : 0;
  } catch (e) {
    err(`Error: ${scrub(e?.message ?? e, env)}`);
    return 1;
  }
}

async function readProcessStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return decodeText(Buffer.concat(chunks), "stdin");
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
