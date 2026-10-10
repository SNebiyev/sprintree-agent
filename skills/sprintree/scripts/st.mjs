#!/usr/bin/env node
/**
 * Sprintree MCP over plain JSON-RPC (Streamable HTTP). Pure Node >= 18, no shell utilities,
 * works on Linux, macOS and Windows. Use it when the agent has no `sprintree` MCP server connected.
 *
 *   node st.mjs tools                      # tool names + argument names
 *   node st.mjs schema <tool>              # one tool's description and input schema
 *   node st.mjs call <tool> '<json-args>'  # call a tool, print its text result
 *   node st.mjs call <tool> @args.json     # same, arguments read from a file (long Markdown)
 *   node st.mjs key [dir]                  # resolve the project key for a repo (default: cwd)
 *   node st.mjs config [dir]               # print the resolved project config (JSON, no secrets)
 *
 * Auth: set SPRINTREE_TOKEN to a personal access token (Settings -> Tokens in Sprintree).
 * "Bearer " is added when missing. The token is never printed. SPRINTREE_MCP_URL overrides
 * the endpoint (default https://sprintree.com/mcp).
 *
 * A refusal (HTTP error, JSON-RPC error, isError, or a text answer starting with "Error:")
 * exits 1, so a failed write is never read as success.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "https://sprintree.com/mcp";
const KEY_RE = /sprintree\.com\/p\/([A-Za-z][A-Za-z0-9]{0,9})\b/;
const DOC_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", path.join(".claude", "CLAUDE.md")];

class CliError extends Error {}

/** Walk from `dir` up to the filesystem root (stops after the first dir holding .git). */
function* ancestors(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    yield cur;
    if (existsSync(path.join(cur, ".git"))) return;
    const up = path.dirname(cur);
    if (up === cur) return;
    cur = up;
  }
}

/** Project config: `.sprintree.json` (nearest wins), then a `sprintree.com/p/<KEY>` link in a doc file. */
export function resolveConfig(dir) {
  const config = {};
  let source = null;
  for (const d of ancestors(dir)) {
    const f = path.join(d, ".sprintree.json");
    if (existsSync(f) && statSync(f).isFile()) {
      try {
        Object.assign(config, JSON.parse(readFileSync(f, "utf8")));
        source = f;
      } catch (e) {
        throw new CliError(`${f} is not valid JSON: ${e.message}`);
      }
      break;
    }
  }
  if (!config.project) {
    for (const d of ancestors(dir)) {
      for (const name of DOC_FILES) {
        const f = path.join(d, name);
        if (!existsSync(f)) continue;
        const m = KEY_RE.exec(readFileSync(f, "utf8"));
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

function authHeader(env) {
  const t = (env.SPRINTREE_TOKEN || "").trim();
  if (!t) {
    throw new CliError(
      "No token. Set SPRINTREE_TOKEN to a Sprintree personal access token (Settings -> Tokens), " +
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

function makeClient({ fetchImpl, env }) {
  const url = env.SPRINTREE_MCP_URL || DEFAULT_URL;
  const auth = authHeader(env);
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
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
    sid = res.headers?.get?.("mcp-session-id") ?? sid;
    const text = await res.text();
    if (notify) return null;
    if (!res.ok) throw new CliError(`HTTP ${res.status}: ${scrub(text.slice(0, 300), env)}`);
    // Streamable HTTP may answer as SSE: the last `data:` line carries the JSON-RPC response.
    const isSse = text.startsWith("data:") || text.includes("\ndata:");
    const payload = isSse
      ? text
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5))
          .pop()
      : text;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      throw new CliError(`Unreadable answer to ${method}: ${scrub(String(text).slice(0, 200), env)}`);
    }
    if (msg.error) throw new CliError(`RPC ${method}: ${scrub(JSON.stringify(msg.error), env)}`);
    return msg.result;
  }

  async function connect() {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "sprintree-agent", version: "0.1.0" },
    });
    await rpc("notifications/initialized", {}, true);
  }

  return { rpc, connect };
}

/**
 * Run one CLI invocation. Returns the exit code; all I/O goes through `deps` so tests can mock it.
 * deps: { fetch, env, cwd, out(line), err(line) }
 */
export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const cwd = deps.cwd ?? process.cwd();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const [cmd, a1, a2] = argv;
  try {
    if (cmd === "key" || cmd === "config") {
      const cfg = resolveConfig(path.resolve(cwd, a1 || "."));
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
      throw new CliError("usage: st.mjs tools | schema <tool> | call <tool> <json|@file.json> | key [dir] | config [dir]");
    }
    if (cmd === "schema" && !a1) throw new CliError("usage: st.mjs schema <tool>");
    if (cmd === "call" && !a1) throw new CliError("usage: st.mjs call <tool> '<json>' | @file.json");
    let args = {};
    if (cmd === "call") {
      let raw = a2 ?? "{}";
      if (raw.startsWith("@")) {
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await run(process.argv.slice(2));
}
