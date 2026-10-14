#!/usr/bin/env node
// Checks that every tool name, argument name and enum value the docs mention exists in the committed
// snapshot of the live Sprintree tool list (test/tools.snapshot.json). Offline by default.
//
//   node scripts/check-tools.mjs            check SKILL.md, README.md, GEMINI.md and the AGENTS.md template against the snapshot
//   node scripts/check-tools.mjs --refresh  rebuild the snapshot from the live server
//                                           (needs SPRINTREE_TOKEN; never runs in CI)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeClient, listTools, isMainModule, KNOWN_CONFIG_KEYS } from "../skills/sprintree/scripts/st.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT = path.join(ROOT, "test", "tools.snapshot.json");
export const DOCS = ["skills/sprintree/SKILL.md", "templates/AGENTS.md", "README.md", "GEMINI.md"];

/** True when `tool` takes the argument `k`. */
const hasArg = (tools, tool, k) => Object.hasOwn(tools[tool].properties, k);

/** Collect every enum value found anywhere inside a JSON schema fragment. */
function enumsOf(schema, acc = new Set()) {
  if (!schema || typeof schema !== "object") return acc;
  if (Array.isArray(schema.enum)) schema.enum.forEach((v) => acc.add(v));
  for (const k of ["anyOf", "oneOf", "allOf"]) (schema[k] ?? []).forEach((s) => enumsOf(s, acc));
  if (schema.items) enumsOf(schema.items, acc);
  return acc;
}

/** tools/list result -> compact, stable snapshot. */
export function buildSnapshot(tools) {
  const out = {};
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const props = {};
    for (const p of Object.keys(t.inputSchema?.properties ?? {}).sort()) {
      const e = [...enumsOf(t.inputSchema.properties[p])];
      props[p] = e.length ? { enum: e } : {};
    }
    out[t.name] = { properties: props, required: [...(t.inputSchema?.required ?? [])].sort() };
  }
  return { tools: out };
}

const SNAKE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;
const WORD = new RegExp(`^${SNAKE.source}$`);
const OPEN_FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/;

// Backticked snake_case words that are not tools, arguments or enum values of the live server: the snake_case
// `.sprintree.json` keys and a Codex config option.
export const ALLOW = new Set([...KNOWN_CONFIG_KEYS.filter((k) => WORD.test(k)), "bearer_token_env_var"]);

/** Top-level `{"...": ...}` substrings of a line (string-aware brace matching), with their start index. */
function jsonObjects(line) {
  const found = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "{" || !/^\{\s*"/.test(line.slice(i, i + 4))) continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < line.length; j++) {
      const c = line[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        found.push({ index: i, raw: line.slice(i, j + 1) });
        i = j;
        break;
      }
    }
  }
  return found;
}

/** Returns a list of problems (strings). Empty list = consistent. */
export function checkText(text, snap, file = "text") {
  const problems = [];
  const tools = snap.tools;
  // arg name -> the enum values it has across all tools, and whether some tool takes it as free text. The union is the
  // fallback when no tool can be named for a JSON example; an enum only binds when every tool that has the arg enumerates it.
  const allProps = new Map();
  const allEnums = new Set();
  for (const t of Object.values(tools)) {
    for (const [p, d] of Object.entries(t.properties)) {
      if (!allProps.has(p)) allProps.set(p, { values: new Set(), free: false });
      const entry = allProps.get(p);
      if (d.enum) d.enum.forEach((v) => { entry.values.add(String(v)); allEnums.add(String(v)); });
      else entry.free = true;
    }
  }
  const unionEnum = (k) => { const e = allProps.get(k); return e && !e.free && e.values.size ? e.values : null; };
  /** Problems of argument `k` with the string `values` for `tool` (null: no tool is named, any tool will do). */
  const checkArg = (at, tool, k, values) => {
    if (tool ? !hasArg(tools, tool, k) : !allProps.has(k)) return [`${at}: ${tool ?? "no tool"} has no argument "${k}"`];
    const en = tool ? tools[tool].properties[k].enum?.map(String) : [...(unionEnum(k) ?? [])];
    return en?.length ? values.filter((x) => !en.includes(x)).map((x) => `${at}: ${tool ?? "any tool"}.${k} "${x}" is not one of [${en.join(", ")}]`) : [];
  };
  const checkObject = (at, tool, obj) => {
    for (const [k, v] of Object.entries(obj)) problems.push(...checkArg(at, tool, k, [].concat(v).filter((x) => typeof x === "string")));
  };
  let carry = null; // the last tool named earlier in this paragraph (a JSON example often sits on the line after its tool)
  let fence = null; // the open code fence: { isJson, closer (regex), start, body, tool }
  const lines = text.split(/\r?\n/);
  const closeFence = () => {
    // A ```json block is a config example when it only has config keys, otherwise it is checked as arguments of the paragraph's tool.
    if (!fence.isJson) return;
    const at = `${file}:${fence.start}`;
    let obj;
    try { obj = JSON.parse(fence.body.join("\n")); } catch { problems.push(`${at}: JSON block does not parse`); return; }
    if (obj && typeof obj === "object" && !Array.isArray(obj) && !Object.keys(obj).every((k) => KNOWN_CONFIG_KEYS.includes(k))) checkObject(at, fence.tool, obj);
  };
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    if (fence) {
      if (fence.closer.test(line)) { closeFence(); fence = null; return; }
      if (fence.isJson) { fence.body.push(line); return; }
    } else {
      const open = OPEN_FENCE.exec(line);
      if (open) {
        // a fence is closed by a line of the same character, at least as long as the opening one
        const [, ticks, lang] = open;
        fence = { isJson: lang.toLowerCase() === "json", closer: new RegExp(`^\\s*${ticks[0]}{${ticks.length},}\\s*$`), start: i + 1, body: [], tool: carry };
        return;
      }
    }
    if (!line.trim()) { carry = null; return; }
    // PowerShell-escaped JSON (`{\"a\":\"b\"}`) is read as the JSON it stands for.
    const code = /\{\s*\\"/.test(line) ? line.replace(/\\"/g, '"') : line;
    const mentions = [...code.matchAll(SNAKE)].filter((m) => tools[m[0]]).map((m) => ({ name: m[0], index: m.index }));
    // The tool an argument belongs to: the last tool named before it on the line, else the first one on the line, else the paragraph's.
    const toolFor = (index) => ([...mentions].reverse().find((m) => m.index < index) ?? mentions[0])?.name ?? carry;
    // 1. Backticked snake_case words must be a tool, an argument, an enum value or allow-listed. A backticked `key:"value"` is
    //    an inline argument: the argument must exist on the tool named before it, the value in ITS enum (bare prose is not parsed).
    for (const m of code.matchAll(/`([^`]+)`/g)) {
      const w = m[1];
      if (WORD.test(w) && !tools[w] && !allProps.has(w) && !allEnums.has(w) && !ALLOW.has(w)) {
        problems.push(`${at}: \`${w}\` is not a tool, argument or enum value of the live server`);
      }
      for (const kv of w.matchAll(/\b([a-z][a-z0-9_]*)\s*:\s*"([^"]*)"/g)) {
        const tool = toolFor(m.index);
        if (tool || allProps.has(kv[1])) problems.push(...checkArg(at, tool, kv[1], [kv[2]]));
      }
    }
    // 2. `st.mjs call|schema <name>` (the name may be quoted) must name a tool.
    for (const m of code.matchAll(/st\.mjs\s+(?:call|schema)\s+["']?([a-z][a-z0-9_]*)/g)) {
      if (!tools[m[1]]) problems.push(`${at}: st.mjs names \`${m[1]}\`, which is not a tool of the live server`);
    }
    // 3. JSON argument objects (quoted, backticked or bare): keys and enum values must be those of the tool named on the line
    //    or earlier in the paragraph; with no tool at all, of some tool.
    for (const { index, raw } of jsonObjects(code)) {
      let obj;
      try { obj = JSON.parse(raw); } catch { problems.push(`${at}: JSON example does not parse: ${raw}`); continue; }
      checkObject(at, toolFor(index), obj);
    }
    if (mentions.length) carry = mentions[mentions.length - 1].name;
  });
  if (fence) problems.push(`${file}:${fence.start}: code fence is never closed`);
  return problems;
}

export function checkAll(snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"))) {
  return DOCS.flatMap((f) => checkText(readFileSync(path.join(ROOT, f), "utf8"), snap, f));
}

/**
 * Rebuild the snapshot from the live server through the package's own client. Returns the number of tools. The agent-run
 * tools are listed only to an agent-runs token: with SPRINTREE_RUNS_TOKEN set they are read with it and added; without it
 * the ones the snapshot already has are kept, so a refresh never drops them.
 */
export async function refresh({ fetchImpl = globalThis.fetch, env = process.env, file = SNAPSHOT } = {}) {
  const list = async (e) => {
    const client = makeClient({ fetchImpl, env: e });
    await client.connect();
    return listTools(client);
  };
  const snap = buildSnapshot(await list(env));
  const runsToken = (env.SPRINTREE_RUNS_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
  const runs = runsToken ? buildSnapshot(await list({ ...env, SPRINTREE_TOKEN: runsToken })).tools : previousRunTools(file);
  const tools = Object.fromEntries(Object.entries({ ...snap.tools, ...runs }).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, JSON.stringify({ tools }, null, 1) + "\n");
  return Object.keys(tools).length;
}

export const RUN_TOOLS = ["start_run", "update_lane", "get_run", "close_run"];

function previousRunTools(file) {
  try {
    const old = JSON.parse(readFileSync(file, "utf8")).tools;
    return Object.fromEntries(RUN_TOOLS.filter((t) => old[t]).map((t) => [t, old[t]]));
  } catch {
    return {};
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  if (process.argv.includes("--refresh")) {
    refresh().then((n) => console.log(`snapshot refreshed: ${n} tools`), (e) => { console.error(`Error: ${e.message}`); process.exit(1); });
  } else {
    const p = checkAll();
    p.forEach((x) => console.error(x));
    console.log(p.length ? `${p.length} problem(s)` : "tools consistent");
    process.exit(p.length ? 1 : 0);
  }
}
