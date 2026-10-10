#!/usr/bin/env node
// Checks that every tool name, argument name and enum value the docs mention exists in the committed
// snapshot of the live Sprintree tool list (test/tools.snapshot.json). Offline by default.
//
//   node scripts/check-tools.mjs            check SKILL.md and AGENTS.md against the snapshot
//   node scripts/check-tools.mjs --refresh  rebuild the snapshot from the live server
//                                           (needs SPRINTREE_TOKEN; never runs in CI)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT = path.join(ROOT, "test", "tools.snapshot.json");
export const DOCS = ["skills/sprintree/SKILL.md", "AGENTS.md"];

// Backticked snake_case words that are not tools, arguments or enum values of the live server.
const ALLOW = new Set([
  "sprintree_token", "section_titles", "due_date_local", "st_mjs", "base_rev_int",
]);

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

/** Returns a list of problems (strings). Empty list = consistent. */
export function checkText(text, snap, file = "text") {
  const problems = [];
  const tools = snap.tools;
  const allProps = new Map(); // arg name -> Set of enum values across tools ("" = no enum)
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
    // 1. Backticked snake_case words must be a tool, an argument, an enum value or allow-listed.
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const w = m[1];
      if (WORD.test(w) && !tools[w] && !allProps.has(w) && !allEnums.has(w) && !ALLOW.has(w)) {
        problems.push(`${at}: \`${w}\` is not a tool, argument or enum value of the live server`);
      }
    }
    // 2. Inline args like `category:"todo"` or `skip_criteria: "none"`: argument exists, value in its enum.
    for (const m of line.matchAll(/\b([a-z][a-z0-9_]*)\s*:\s*"([^"]*)"/g)) {
      const [, k, v] = m;
      if (!allProps.has(k)) continue; // prose such as `statuses: ...` is covered by rule 1 only
      const en = allProps.get(k);
      if (en.size && !en.has(v)) problems.push(`${at}: ${k}:"${v}" is not one of [${[...en].join(", ")}]`);
    }
    // 3. JSON args examples on a line that names a tool: keys must be that tool's arguments.
    const named = [...line.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g)].map((x) => x[0]).filter((n) => tools[n]);
    for (const m of line.matchAll(/'(\{.*?\})'|`(\{.*?\})`/g)) {
      const raw = m[1] ?? m[2];
      let obj;
      try { obj = JSON.parse(raw); } catch { problems.push(`${at}: JSON example does not parse: ${raw}`); continue; }
      const tool = named.length ? named[named.length - 1] : null;
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

/** Rebuild the snapshot through the package's own client (reads tools/list off its HTTP traffic). */
export async function refresh() {
  const { run } = await import("../skills/sprintree/scripts/st.mjs");
  let list = null;
  const base = globalThis.fetch;
  const spy = async (url, init) => {
    const res = await base(url, init);
    if (JSON.parse(init.body).method === "tools/list") {
      const t = await res.clone().text();
      const data = t.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? t;
      list = JSON.parse(data).result?.tools ?? null;
    }
    return res;
  };
  const code = await run(["tools"], { fetch: spy, out: () => {} });
  if (code !== 0 || !list) throw new Error("could not read the live tool list (is SPRINTREE_TOKEN set?)");
  writeFileSync(SNAPSHOT, JSON.stringify(buildSnapshot(list), null, 1) + "\n");
  return list.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
