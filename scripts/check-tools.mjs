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
import { makeClient, isMainModule } from "../skills/sprintree/scripts/st.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT = path.join(ROOT, "test", "tools.snapshot.json");
export const DOCS = ["skills/sprintree/SKILL.md", "templates/AGENTS.md", "README.md", "GEMINI.md"];

// Backticked snake_case words that are not tools, arguments or enum values of the live server:
// `.sprintree.json` keys and a Codex config option.
export const ALLOW = new Set(["section_titles", "bearer_token_env_var"]);

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

const WORD = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const SNAKE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;

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
  const allProps = new Map(); // arg name -> Set of enum values across all tools (only for words that are not tool-specific)
  const allEnums = new Set();
  for (const t of Object.values(tools)) {
    for (const [p, d] of Object.entries(t.properties)) {
      if (!allProps.has(p)) allProps.set(p, new Set());
      (d.enum ?? []).forEach((v) => { allProps.get(p).add(String(v)); allEnums.add(String(v)); });
    }
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    // The tool an argument belongs to: the last tool named before it on the line, else the first one on the line.
    const mentions = [...line.matchAll(SNAKE)].filter((m) => tools[m[0]]).map((m) => ({ name: m[0], index: m.index }));
    const toolFor = (index) => ([...mentions].reverse().find((m) => m.index < index) ?? mentions[0])?.name ?? null;
    // 1. Backticked snake_case words must be a tool, an argument, an enum value or allow-listed.
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const w = m[1];
      if (WORD.test(w) && !tools[w] && !allProps.has(w) && !allEnums.has(w) && !ALLOW.has(w)) {
        problems.push(`${at}: \`${w}\` is not a tool, argument or enum value of the live server`);
      }
    }
    // 2. Inline args like `category:"todo"`: the argument must exist on the tool named before it, the value in ITS enum.
    for (const m of line.matchAll(/\b([a-z][a-z0-9_]*)\s*:\s*"([^"]*)"/g)) {
      const [, k, v] = m;
      if (!allProps.has(k)) continue; // prose such as `statuses: ...` is covered by rule 1 only
      const tool = toolFor(m.index);
      if (tool && !tools[tool].properties[k]) { problems.push(`${at}: ${tool} has no argument "${k}"`); continue; }
      const en = tool ? new Set((tools[tool].properties[k].enum ?? []).map(String)) : allProps.get(k);
      if (en.size && !en.has(v)) problems.push(`${at}: ${tool ? `${tool}.` : ""}${k}:"${v}" is not one of [${[...en].join(", ")}]`);
    }
    // 3. JSON argument objects (quoted, backticked or bare) on a line that names a tool: keys and enum values must be that tool's.
    for (const { index, raw } of jsonObjects(line)) {
      let obj;
      try { obj = JSON.parse(raw); } catch { problems.push(`${at}: JSON example does not parse: ${raw}`); continue; }
      const tool = toolFor(index);
      if (!tool) continue;
      for (const [k, v] of Object.entries(obj)) {
        const def = tools[tool].properties[k];
        if (!def) { problems.push(`${at}: ${tool} has no argument "${k}"`); continue; }
        const vals = [].concat(v).filter((x) => typeof x === "string");
        if (def.enum) for (const x of vals) if (!def.enum.map(String).includes(x)) {
          problems.push(`${at}: ${tool}.${k} "${x}" is not one of [${def.enum.join(", ")}]`);
        }
      }
    }
  });
  return problems;
}

export function checkAll(snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"))) {
  return DOCS.flatMap((f) => checkText(readFileSync(path.join(ROOT, f), "utf8"), snap, f));
}

/** Rebuild the snapshot from the live server through the package's own client. Returns the number of tools. */
export async function refresh({ fetchImpl = globalThis.fetch, env = process.env, file = SNAPSHOT } = {}) {
  const client = makeClient({ fetchImpl, env });
  await client.connect();
  const answer = await client.rpc("tools/list", {});
  if (!Array.isArray(answer?.tools)) throw new Error("the live tools/list answer has no `tools` array");
  writeFileSync(file, JSON.stringify(buildSnapshot(answer.tools), null, 1) + "\n");
  return answer.tools.length;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  if (process.argv.includes("--refresh")) {
    if (!process.env.SPRINTREE_TOKEN) {
      console.error("Set SPRINTREE_TOKEN (a Sprintree personal access token) to refresh the snapshot.");
      process.exit(1);
    }
    refresh().then((n) => console.log(`snapshot refreshed: ${n} tools`), (e) => { console.error(`Error: ${e.message}`); process.exit(1); });
  } else {
    const p = checkAll();
    p.forEach((x) => console.error(x));
    console.log(p.length ? `${p.length} problem(s)` : "tools consistent");
    process.exit(p.length ? 1 : 0);
  }
}
