// The prose of the repo is part of the product: these tests keep the docs, the skill and the code saying the same thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MIN_NODE, KNOWN_CONFIG_KEYS } from "../skills/sprintree/scripts/st.mjs";
import { ROOT } from "../test-support/helpers.mjs";

const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const SKILL = "skills/sprintree/SKILL.md";
const AGENTS = "templates/AGENTS.md";
const README = "README.md";
const ST = "skills/sprintree/scripts/st.mjs";

test("no doc offers a shell pipe, a stdin form, a heredoc or a here-string for text the agent did not write", () => {
  for (const f of [SKILL, AGENTS, README, "GEMINI.md", "CONTRIBUTING.md", ST]) {
    const text = read(f);
    assert.ok(!/\|\s*node\b[^\n]*st\.mjs/.test(text), `${f}: pipes into st.mjs`);
    assert.ok(!/(^|\n)\s*(echo|printf|cat)\b[^\n]*st\.mjs/.test(text), `${f}: echo/printf/cat example`);
    assert.ok(!/<<\s*'?EOF/.test(text), `${f}: heredoc example`);
    assert.ok(!/<\s*args\.json/.test(text), `${f}: stdin redirect`);
    assert.ok(!/st\.mjs[^\n]* - (<|$|\s)/m.test(text), `${f}: stdin \`-\` form`);
    assert.ok(!/@'/.test(text), `${f}: PowerShell here-string`);
  }
});

test("the docs say external text goes through the agent's file-writing tool into a temp directory outside the repo, as @<absolute path>", () => {
  for (const f of [SKILL, AGENTS]) {
    const t = flat(read(f));
    assert.match(t, /file-writing tool/, f);
    assert.match(t, /outside the repo/, f);
    assert.match(t, /never via echo, printf, a heredoc or a PowerShell here-string/i, f);
    assert.ok(t.includes("@<absolute path>"), `${f}: @<absolute path>`);
  }
  assert.match(flat(read(README)), /@<absolute path>/);
  assert.ok(!/\$json/.test(read(README)), "README builds JSON in the shell");
});

test("the minimum Node version is stated once (MIN_NODE) and no doc says another, a bare `Node 18` included", () => {
  let seen = 0;
  for (const f of [README, SKILL, "GEMINI.md", AGENTS, "CHANGELOG.md", "CONTRIBUTING.md", ST, ".claude/pcc.md", "docs/maintainers/RESEARCH.md"]) {
    const text = read(f);
    for (const m of text.matchAll(/\bNode(?:\.js)?\s*(?:>=|≥)\s*v?(\d+(?:\.\d+){0,2})/g)) {
      seen++;
      assert.equal(m[1], MIN_NODE, `${f}: "${m[0]}"`);
    }
    for (const m of text.matchAll(/\bNode(?:\.js)?\s+v?(\d+(?:\.\d+){0,2})\s+or (?:newer|later)/g)) {
      seen++;
      assert.equal(m[1], MIN_NODE, `${f}: "${m[0]}"`);
    }
    for (const m of text.matchAll(/\bNode(?:\.js)?\s+v?18(?![\d.])/g)) assert.ok(false, `${f}: a bare "${m[0]}" (state ${MIN_NODE})`);
  }
  assert.ok(seen >= 4, "the docs should state the minimum somewhere");
});

test("CI runs the full suite on exactly MIN_NODE (not on a floating 18) and PCC runs it per Node version", () => {
  const wf = read(".github/workflows/test.yml");
  assert.match(wf, new RegExp(`node:\\s*\\[[^\\]]*"${MIN_NODE.replace(/\./g, "\\.")}"`), "matrix entry");
  assert.ok(!/node:\s*\[[^\]]*\b18\b[^.]/.test(wf), "a floating 18 is still in the matrix");
  const pcc = read(".claude/pcc.md");
  assert.ok(pcc.includes(MIN_NODE), "pcc.md names the MIN_NODE version");
  assert.match(pcc, /npm test/);
});

test("the token-location sentence is identical in SKILL.md and the AGENTS.md template", () => {
  const sentence =
    "Create a personal access token in Sprintree under Settings -> API & MCP -> Personal access tokens (tokens start with `itn_`) and export it as `SPRINTREE_TOKEN`.";
  for (const f of [SKILL, AGENTS]) assert.ok(flat(read(f)).includes(sentence), `${f} lacks the token sentence`);
});

test("SKILL.md's config JSON block equals .sprintree.example.json, and it names exactly the known keys", () => {
  const block = /```json\n([\s\S]*?)\n```/.exec(read(SKILL))[1];
  const example = JSON.parse(read(".sprintree.example.json"));
  assert.deepEqual(JSON.parse(block), example);
  assert.deepEqual(Object.keys(example).sort(), [...KNOWN_CONFIG_KEYS].sort());
});

test("the task query JSON is identical in SKILL.md and the AGENTS.md template", () => {
  const re = /`(\{"project":"KEY","category":"todo"[^`]*\})`/;
  const a = re.exec(flat(read(SKILL)));
  const b = re.exec(flat(read(AGENTS)));
  assert.ok(a && b, "both docs carry the task query");
  assert.equal(a[1], b[1]);
  assert.doesNotThrow(() => JSON.parse(a[1]));
});

test("the AGENTS.md template says where each client installs the skill, and the README names the Codex per-repo path", () => {
  const t = flat(read(AGENTS));
  for (const p of ["~/.agents/skills/sprintree/", ".agents/skills/sprintree/", "~/.gemini/extensions/sprintree/skills/sprintree/", "~/.claude/plugins/cache/"]) {
    assert.ok(t.includes(p), `${AGENTS} lacks ${p}`);
  }
  assert.ok(!t.includes("<skill-dir> ="), "no stray placeholder definition");
  assert.ok(flat(read(README)).includes(".agents/skills/sprintree/"), "README: Codex per-repo path");
});

test("the gitleaks rule covers the PAT and both OAuth token shapes like the redaction in st.mjs, and reports the token as group 1", () => {
  const toml = read(".gitleaks.toml");
  const re = new RegExp(/regex = '''(.*)'''/.exec(toml)[1]);
  assert.match(toml, /secretGroup = 1/);
  const body = "Ab1-_".repeat(6);
  for (const prefix of ["itn_", "itna_", "itnr_"]) {
    assert.equal(re.exec(`token=${prefix}${body}`)?.[1], prefix + body, prefix);
    assert.equal(re.exec(`${prefix}${body}`)?.[1], prefix + body, `${prefix} at the start of the text`);
    assert.ok(toml.includes(`"${prefix}"`), `keyword ${prefix}`);
  }
  assert.equal(re.exec(`SPRINTREE_TOKEN_itn_${body}`)?.[1], `itn_${body}`, "after an underscore");
  assert.equal(re.exec(`_itn_${body}_`)?.[1], `itn_${body}_`, "between underscores");
  assert.ok(!re.test(`itnx_${body}`) && !re.test("itn_short") && !re.test(`keyitn_${body}`), "not a token");
});
