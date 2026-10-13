// Asserts one version everywhere: package.json, plugin.json, gemini-extension.json, st.mjs VERSION, the
// `<!-- sprintree-agent:begin x.y.z -->` marker of templates/AGENTS.md and the
// newest released heading of CHANGELOG.md (`## [x.y.z]`; `## [Unreleased]` is skipped). On a tag build
// (GITHUB_REF_TYPE=tag) the tag without a leading `v` must match too.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, VERSION } from "../skills/sprintree/scripts/st.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
const versionOf = (f) => JSON.parse(read(f)).version;

export function collect(env = process.env) {
  const found = {
    "package.json": versionOf("package.json"),
    ".claude-plugin/plugin.json": versionOf(".claude-plugin/plugin.json"),
    "gemini-extension.json": versionOf("gemini-extension.json"),
    "st.mjs VERSION": VERSION,
    "templates/AGENTS.md marker": read("templates/AGENTS.md").match(/^<!-- sprintree-agent:begin (\S+) -->/)?.[1],
    "CHANGELOG.md": read("CHANGELOG.md").match(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/m)?.[1],
  };
  if (env.GITHUB_REF_TYPE === "tag") found[`tag ${env.GITHUB_REF_NAME}`] = (env.GITHUB_REF_NAME || "").replace(/^v/, "");
  return found;
}

export function check(found) {
  const want = found["package.json"];
  return Object.entries(found).filter(([, v]) => v !== want).map(([k, v]) => `${k}: ${v ?? "missing"} (package.json says ${want})`);
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const found = collect();
  const bad = check(found);
  for (const [k, v] of Object.entries(found)) console.log(`${v === found["package.json"] ? "ok  " : "FAIL"} ${k} = ${v}`);
  if (bad.length) {
    console.error(`version mismatch:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
}
