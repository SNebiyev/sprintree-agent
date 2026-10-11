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
import { makeClient, listTools, isMainModule } from "../skills/sprintree/scripts/st.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT = path.join(ROOT, "test", "tools.snapshot.json");
export const DOCS = ["skills/sprintree/SKILL.md", "templates/AGENTS.md", "README.md", "GEMINI.md"];

// Backticked snake_case words that are not tools, arguments or enum values of the live server:
// `.sprintree.json` keys and a Codex config option.
export const ALLOW = new Set(["section_titles", "bearer_token_env_var"]);

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
  let carry = null; // the last tool named earlier in this paragraph (a JSON example often sits on the line after its tool)
  let fence = false; // inside a ```json block: a config example, not tool arguments
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    if (!line.trim()) { carry = null; return; }
    if (/^\s*```/.test(line)) { fence = !fence && /^\s*```json\b/.test(line); return; }
    const mentions = [...line.matchAll(SNAKE)].filter((m) => tools[m[0]]).map((m) => ({ name: m[0], index: m.index }));
    // The tool an argument belongs to: the last tool named before it on the line, else the first one on the line, else the paragraph's.
    const toolFor = (index) => ([...mentions].reverse().find((m) => m.index < index) ?? mentions[0])?.name ?? carry;
    // 1. Backticked snake_case words must be a tool, an argument, an enum value or allow-listed.
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const w = m[1];
      if (WORD.test(w) && !tools[w] && !allProps.has(w) && !allEnums.has(w) && !ALLOW.has(w)) {
        problems.push(`${at}: \`${w}\` is not a tool, argument or enum value of the live server`);
      }
    }
    // 2. `st.mjs call|schema <name>` must name a tool.
    for (const m of line.matchAll(/st\.mjs\s+(?:call|schema)\s+([a-z][a-z0-9_]*)/g)) {
      if (!tools[m[1]]) problems.push(`${at}: st.mjs names \`${m[1]}\`, which is not a tool of the live server`);
    }
    if (!fence) {
      // 3. Inline args like `category:"todo"`: the argument must exist on the tool named before it, the value in ITS enum.
      for (const m of line.matchAll(/\b([a-z][a-z0-9_]*)\s*:\s*"([^"]*)"/g)) {
        const [, k, v] = m;
        const tool = toolFor(m.index);
        if (tool && !hasArg(tools, tool, k)) { problems.push(`${at}: ${tool} has no argument "${k}"`); continue; }
        const en = tool ? new Set((tools[tool].properties[k].enum ?? []).map(String)) : unionEnum(k);
        if (en?.size && !en.has(v)) problems.push(`${at}: ${tool ? `${tool}.` : ""}${k}:"${v}" is not one of [${[...en].join(", ")}]`);
      }
      // 4. JSON argument objects (quoted, backticked or bare): keys and enum values must be those of the tool named on the line
      //    or earlier in the paragraph; with no tool at all, of some tool.
      for (const { index, raw } of jsonObjects(line)) {
        let obj;
        try { obj = JSON.parse(raw); } catch { problems.push(`${at}: JSON example does not parse: ${raw}`); continue; }
        const tool = toolFor(index);
        for (const [k, v] of Object.entries(obj)) {
          if (tool ? !hasArg(tools, tool, k) : !allProps.has(k)) { problems.push(`${at}: ${tool ?? "no tool"} has no argument "${k}"`); continue; }
          const en = tool ? tools[tool].properties[k].enum?.map(String) : [...(unionEnum(k) ?? [])];
          const vals = [].concat(v).filter((x) => typeof x === "string");
          if (en?.length) for (const x of vals) if (!en.includes(x)) problems.push(`${at}: ${tool ?? "any tool"}.${k} "${x}" is not one of [${en.join(", ")}]`);
        }
      }
    }
    if (mentions.length) carry = mentions[mentions.length - 1].name;
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
  const tools = await listTools(client);
  writeFileSync(file, JSON.stringify(buildSnapshot(tools), null, 1) + "\n");
  return tools.length;
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
