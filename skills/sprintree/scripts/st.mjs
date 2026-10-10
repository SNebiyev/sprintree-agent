#!/usr/bin/env node
/**
 * Sprintree MCP over plain JSON-RPC (Streamable HTTP). Pure Node >= 18, no shell utilities,
 * works on Linux, macOS and Windows. Use it when the agent has no `sprintree` MCP server connected.
 *
 *   node st.mjs tools                      # tool names + argument names
 *   node st.mjs schema <tool>              # one tool's description and input schema
 *   node st.mjs call <tool> '<json-args>'  # call a tool, print its text result
 *   node st.mjs call <tool> @args.json     # same, arguments read from a file (long Markdown)
 *   node st.mjs call <tool> -              # same, arguments read as JSON from stdin
 *   node st.mjs version                    # print the version of this script
 *   node st.mjs key [dir]                  # resolve the project key for a repo (default: cwd)
 *   node st.mjs config [dir]               # print the resolved project config (JSON, no secrets)
 *
 * Auth: set SPRINTREE_TOKEN to a personal access token (itn_..., Settings -> API & MCP -> Personal access tokens).
 * "Bearer " is added when missing. The token is never printed. SPRINTREE_MCP_URL overrides
 * the endpoint (default https://sprintree.com/mcp; must be https unless the host is
 * localhost, 127.0.0.1 or ::1). SPRINTREE_TIMEOUT_MS sets the per-request timeout (default 30000).
 *
 * OAuth: this fallback client is PAT-only on purpose. When an agent connects the Sprintree MCP
 * server with OAuth, that session (access/refresh tokens) lives in the agent's own keychain and
 * this script cannot reach it. No token means: use the connected MCP tools, or set a PAT.
 *
 * Windows: PowerShell 5.1 strips the inner double quotes of a native-command argument, so
 * inline JSON breaks there. Use `call <tool> @args.json` (the documented Windows path) or
 * pipe the JSON into `call <tool> -`.
 *
 * A refusal (HTTP error, JSON-RPC error, isError, or a text answer starting with "Error:")
 * exits 1, so a failed write is never read as success.
 */
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One version source. A constant (not a read of ../../../package.json) so it keeps working when
// the skill folder is copied alone. A test (and the A3 version check) keeps it equal to package.json.
export const VERSION = "0.1.0";
const DEFAULT_URL = "https://sprintree.com/mcp";
const DEFAULT_TIMEOUT_MS = 30000;
const REAL_FS = { existsSync, statSync, readFileSync };
const KEY_RE = /sprintree\.com\/p\/([A-Za-z][A-Za-z0-9]{0,9})\b/;
const DOC_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", path.join(".claude", "CLAUDE.md")];

class CliError extends Error {}

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

/** Dotted paths of keys/values in a parsed config that look like a credential. Values are never returned. */
function suspiciousPaths(obj, prefix = "") {
  const found = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const here = prefix + k;
    if (SECRET_KEY_RE.test(k) || (typeof v === "string" && /^(Bearer\s+)?itn_/i.test(v.trim()))) found.push(here);
    else if (v && typeof v === "object" && !Array.isArray(v)) found.push(...suspiciousPaths(v, here + "."));
  }
  return found;
}

/**
 * Project config: `.sprintree.json` (nearest wins), then a `sprintree.com/p/<KEY>` link in a doc file.
 * opts: { path (default node:path, pass path.win32 to test Windows paths), fs, warn(line) }.
 */
export function resolveConfig(dir, opts = {}) {
  const p = opts.path ?? path;
  const fs = opts.fs ?? REAL_FS;
  const config = {};
  let source = null;
  for (const d of ancestors(dir, { path: p, fs })) {
    const f = p.join(d, ".sprintree.json");
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch (e) {
        throw new CliError(`${f} is not valid JSON: ${e.message}`);
      }
      Object.assign(config, parsed);
      source = f;
      const bad = suspiciousPaths(parsed);
      if (bad.length && opts.warn) {
        opts.warn(
          `Warning: ${f} has ${bad.length === 1 ? "a key that looks" : "keys that look"} like a token (${bad.join(", ")}). ` +
            "Never commit tokens: keep them in the SPRINTREE_TOKEN environment variable and remove them from this file."
        );
      }
      break;
    }
  }
  if (!config.project) {
    for (const d of ancestors(dir, { path: p, fs })) {
      for (const name of DOC_FILES) {
        const f = p.join(d, name);
        if (!fs.existsSync(f)) continue;
        const m = KEY_RE.exec(fs.readFileSync(f, "utf8"));
        if (m) {
          config.project = m[1].toUpperCase();
          source = source ?? f;
          return { ...config, _source: source };
        }
      }
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
    throw new CliError(`SPRINTREE_MCP_URL is not a valid URL: ${raw}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.href;
  throw new CliError(
    `SPRINTREE_MCP_URL must be https (plain http is only allowed for localhost, 127.0.0.1 and ::1), got ${u.protocol}//${u.host}`
  );
}

/** True when this module is the process entry point: realpath on both sides (symlinks, npm shims, drive-letter case). */
export function isMainModule(argv1, metaUrl, { realpath = realpathSync, toPath = fileURLToPath } = {}) {
  if (!argv1) return false;
  try {
    return realpath(argv1) === realpath(toPath(metaUrl));
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
    throw new CliError(
      "No token. Set SPRINTREE_TOKEN to a Sprintree personal access token (itn_..., Settings -> API & MCP -> Personal access tokens), " +
        "or connect the Sprintree MCP server in your agent (OAuth) and use its tools directly."
    );
  }
  return /^Bearer\s/i.test(t) ? t : `Bearer ${t}`;
}

/** Remove the token (and its bare value) from any text before it can reach a terminal. */
function scrub(text, env) {
  const t = (env.SPRINTREE_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
  return t && t.length >= 6 ? String(text).split(t).join("[token]") : String(text);
}

function timeoutMs(env) {
  const n = Number(env.SPRINTREE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function makeClient({ fetchImpl, env }) {
  const url = checkMcpUrl(env.SPRINTREE_MCP_URL || DEFAULT_URL);
  const auth = authHeader(env);
  const ms = timeoutMs(env);
  let sid = null;
  let seq = 0;

  async function rpc(method, params, notify = false) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: auth,
    };
    if (sid) headers["Mcp-Session-Id"] = sid;
    const body = { jsonrpc: "2.0", method, params };
    if (!notify) body.id = ++seq;
    let res;
    let text;
    try {
      res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
      sid = res.headers?.get?.("mcp-session-id") ?? sid;
      text = await res.text();
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new CliError(`request to ${new URL(url).host} timed out after ${ms} ms (set SPRINTREE_TIMEOUT_MS to change)`);
      }
      throw e;
    }
    if (notify) return null;
    if (res.status === 401) throw new CliError("HTTP 401: invalid, expired or revoked token (create a new one in Settings -> API & MCP -> Personal access tokens)");
    if (res.status === 403) throw new CliError("HTTP 403: the token cannot do this (read-only token on a write tool?)");
    if (!res.ok) throw new CliError(`HTTP ${res.status}: ${scrub(text.slice(0, 300), env)}`);
    let msg;
    try {
      msg = pickMessage(text, body.id);
    } catch {
      throw new CliError(`Unreadable answer to ${method}: ${scrub(String(text).slice(0, 200), env)}`);
    }
    if (!msg) throw new CliError(`no answer with id ${body.id} to ${method} in the response`);
    if (msg.error) throw new CliError(`RPC ${method}: ${scrub(JSON.stringify(msg.error), env)}`);
    return msg.result;
  }

  async function connect() {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "sprintree-agent", version: VERSION },
    });
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
    if (Number(String(nodeVersion).split(".")[0]) < 18 || typeof fetchImpl !== "function") {
      throw new CliError(
        `st.mjs needs Node.js 18 or newer (global fetch); this is Node ${nodeVersion}${typeof fetchImpl === "function" ? "" : " without fetch"}. Upgrade Node: https://nodejs.org`
      );
    }
    if (cmd === "key" || cmd === "config") {
      const cfg = resolveConfig(path.resolve(cwd, a1 || "."), { warn: err });
      if (cmd === "config") {
        out(JSON.stringify(cfg, null, 2));
        return 0;
      }
      if (!cfg.project) {
        throw new CliError(
          "No project key. Put a `sprintree.com/p/<KEY>` link in AGENTS.md/CLAUDE.md/GEMINI.md, " +
            'or `{"project":"KEY"}` in .sprintree.json. Otherwise find it with list_projects.'
        );
      }
      out(cfg.project);
      return 0;
    }
    if (!["tools", "schema", "call"].includes(cmd)) {
      throw new CliError("usage: st.mjs tools | schema <tool> | call <tool> <json|@file.json|-> | key [dir] | config [dir] | version");
    }
    if (cmd === "schema" && !a1) throw new CliError("usage: st.mjs schema <tool>");
    if (cmd === "call" && !a1) throw new CliError("usage: st.mjs call <tool> '<json>' | @file.json | -");
    let args = {};
    if (cmd === "call") {
      let raw = a2 ?? "{}";
      if (raw === "-") {
        raw = await readStdin();
        if (!raw.trim()) throw new CliError("no JSON arguments on stdin");
      } else if (raw.startsWith("@")) {
        const f = path.resolve(cwd, raw.slice(1));
        if (!existsSync(f)) throw new CliError(`argument file not found: ${f}`);
        raw = readFileSync(f, "utf8");
      }
      try {
        args = JSON.parse(raw);
      } catch (e) {
        throw new CliError(`arguments are not valid JSON: ${e.message}`);
      }
    }
    const client = makeClient({ fetchImpl, env });
    await client.connect();
    if (cmd === "tools" || cmd === "schema") {
      const { tools } = await client.rpc("tools/list", {});
      if (cmd === "tools") {
        for (const t of tools) out(`${t.name}(${Object.keys(t.inputSchema?.properties ?? {}).join(", ")})`);
      } else {
        const t = tools.find((x) => x.name === a1);
        if (!t) throw new CliError(`no such tool: ${a1}`);
        out(t.description);
        out(JSON.stringify(t.inputSchema, null, 2));
      }
      return 0;
    }
    const result = await client.rpc("tools/call", { name: a1, arguments: args });
    const text = scrub((result.content ?? []).map((c) => c.text ?? "").join("\n"), env);
    out(text);
    // Sprintree reports refusals as normal content starting with "Error:".
    return result.isError || /^Error:/.test(text.trim()) ? 1 : 0;
  } catch (e) {
    if (!(e instanceof CliError)) {
      err(`Error: ${scrub(e?.message ?? e, env)}`);
      return 1;
    }
    err(`Error: ${e.message}`);
    return 1;
  }
}

async function readProcessStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
