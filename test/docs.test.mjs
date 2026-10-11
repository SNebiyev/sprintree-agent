// The prose of the repo is part of the product: these tests keep the docs, the skill and the code saying the same thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MIN_NODE, KNOWN_CONFIG_KEYS, DOC_NAMES } from "../skills/sprintree/scripts/st.mjs";
import { DOCS } from "../scripts/check-tools.mjs";
import { ROOT, TOKEN_CASES, decodeEscapes } from "../test-support/helpers.mjs";

const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const SKILL = "skills/sprintree/SKILL.md";
const AGENTS = "templates/AGENTS.md";
const README = "README.md";
const ST = "skills/sprintree/scripts/st.mjs";

// The patterns the guards below use. Each one is run against lines it must catch and lines it must let through: a guard that cannot go red guards nothing.
const STDIN_DASH = /st\.mjs[^\n]* -(?=[\s`'")]|$)/m;
const HERE_STRING = /@['"][ \t]*$/m;
const NODE_18_X_Y = /(?<![\d.])18\.\d+\.\d+(?!\.?\d)/g;
const INLINE_JSON = /st\.mjs\s+call\s+\S+\s+(?:'([^'\n]*)'|"([^"\n]*)")/g;
const UNSAFE_INLINE = /[$`\\]/;

test("the guards fire on a violating line and stay quiet on a clean one", () => {
  const dash = ["`node st.mjs call x -`", "node st.mjs call x - ", "node st.mjs call x -", "(node st.mjs call x -)"];
  for (const line of dash) assert.ok(STDIN_DASH.test(line), line);
  for (const line of ["node st.mjs call x @f", "node st.mjs call x '{}'", "node st.mjs call a-b"]) assert.ok(!STDIN_DASH.test(line), line);
  for (const line of ["$a = @'", '$a = @"', "$a = @'  "]) assert.ok(HERE_STRING.test(line), line);
  for (const line of ["mail me@'x'", "@file"]) assert.ok(!HERE_STRING.test(line), line);
  for (const line of ["Tested on 18.19.0.", "18.19.0, then", "Node v18.20.1)", "18.0.0"]) assert.equal(line.match(NODE_18_X_Y)?.length, 1, line);
  for (const line of ["version 18.19.0.1", "1.18.19.0", "118.19.0", "18.19"]) assert.equal(line.match(NODE_18_X_Y), null, line);
  const inline = (line) => [...line.matchAll(INLINE_JSON)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(inline("`node st.mjs call search_issues '{\"query\":\"$x\"}'`"), ['{"query":"$x"}']);
  // in double quotes the first escaped quote ends what is read, but a backslash is already enough to be caught
  assert.ok(UNSAFE_INLINE.test(inline('`node st.mjs call search_issues "{\\"query\\":\\"$x\\"}"`')[0]));
  assert.deepEqual(inline('node st.mjs call x "$HOME"'), ["$HOME"]);
  for (const bad of ['{"q":"$x"}', '{"q":"`x`"}', '{"q":"a\\b"}', '{\\"q\\":1}']) assert.ok(UNSAFE_INLINE.test(bad), bad);
  assert.ok(!UNSAFE_INLINE.test('{"project":"KEY","category":"todo"}'));
});

test("no doc offers a shell pipe, a stdin form, a heredoc or a here-string for text the agent did not write", () => {
  for (const f of [SKILL, AGENTS, README, "GEMINI.md", "CONTRIBUTING.md", ST]) {
    const text = read(f);
    assert.ok(!/\|\s*node\b[^\n]*st\.mjs/.test(text), `${f}: pipes into st.mjs`);
    assert.ok(!/(^|\n)\s*(echo|printf|cat)\b[^\n]*st\.mjs/.test(text), `${f}: echo/printf/cat example`);
    assert.ok(!/<<\s*'?EOF/.test(text), `${f}: heredoc example`);
    assert.ok(!/<\s*args\.json/.test(text), `${f}: stdin redirect`);
    assert.ok(!STDIN_DASH.test(text), `${f}: stdin \`-\` form`);
    assert.ok(!HERE_STRING.test(text), `${f}: PowerShell here-string (@' or @" ending a line)`);
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

const NODE_FILES = [README, SKILL, "GEMINI.md", AGENTS, "CHANGELOG.md", "CONTRIBUTING.md", ST, ".claude/pcc.md", "docs/maintainers/RESEARCH.md"];

test("the minimum Node version is stated once (MIN_NODE) and no doc says another: not `Node 18`, `node 18.x` or another 18.y.z either", () => {
  let seen = 0;
  for (const f of NODE_FILES) {
    const text = read(f);
    for (const m of text.matchAll(/\bNode(?:\.js)?\s*(?:>=|≥)\s*v?(\d+(?:\.\d+){0,2})/g)) {
      seen++;
      assert.equal(m[1], MIN_NODE, `${f}: "${m[0]}"`);
    }
    for (const m of text.matchAll(/\bNode(?:\.js)?\s+v?(\d+(?:\.\d+){0,2})\s+or (?:newer|later)/g)) {
      seen++;
      assert.equal(m[1], MIN_NODE, `${f}: "${m[0]}"`);
    }
    for (const m of text.matchAll(/\b[Nn]ode(?:\.js)?\s+v?18(?!\.\d)/g)) assert.ok(false, `${f}: a bare "${m[0]}" (state ${MIN_NODE})`);
  }
  for (const f of [...NODE_FILES, ".github/workflows/test.yml", "package.json"]) {
    for (const m of read(f).matchAll(NODE_18_X_Y)) assert.equal(m[0], MIN_NODE, `${f}: "${m[0]}"`);
  }
  assert.ok(seen >= 4, "the docs should state the minimum somewhere");
});

test("CI runs the full suite on exactly MIN_NODE (not on a floating 18) and PCC runs it per Node version, MIN_NODE first", () => {
  const wf = read(".github/workflows/test.yml");
  assert.match(wf, new RegExp(`node:\\s*\\[[^\\]]*"${MIN_NODE.replace(/\./g, "\\.")}"`), "matrix entry");
  assert.ok(!/node:\s*\[[^\]]*\b18\b[^.]/.test(wf), "a floating 18 is still in the matrix");
  const pcc = read(".claude/pcc.md");
  assert.ok(pcc.includes(`for n in ${MIN_NODE} `), "the pcc.md loop starts with MIN_NODE");
  assert.match(pcc, /npm test/);
});

test("line endings are LF, so a Windows checkout reads the same files", () => {
  assert.match(read(".gitattributes"), /^\* text=auto eol=lf$/m);
});

test("SKILL.md lists the doc files in the order st.mjs reads them", () => {
  const names = DOC_NAMES.map((n) => `\`${n}\``);
  assert.ok(flat(read(SKILL)).includes(`${names.slice(0, -1).join(", ")} or ${names.at(-1)}`));
});

test("the token-location sentence is identical in SKILL.md and the AGENTS.md template", () => {
  const sentence =
    "Create a personal access token in Sprintree under Settings -> API & MCP -> Personal access tokens (tokens start with `itn_`) and export it as `SPRINTREE_TOKEN`.";
  for (const f of [SKILL, AGENTS]) assert.ok(flat(read(f)).includes(sentence), `${f} lacks the token sentence`);
});

test("SKILL.md's config JSON block equals .sprintree.example.json, and it names exactly the known keys", () => {
  const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(read(SKILL))[1];
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

test("the gitleaks rule reports what TOKEN_CASES says, in the decoded text, as group 1 (st.mjs redacts the same table), and it has the keywords", () => {
  const toml = read(".gitleaks.toml");
  const re = new RegExp(/regex = '''(.*)'''/.exec(toml)[1]);
  assert.match(toml, /secretGroup = 1/);
  for (const [name, text, token] of TOKEN_CASES) assert.equal(re.exec(decodeEscapes(text))?.[1] ?? null, token, name);
  for (const prefix of ["itn_", "itna_", "itnr_"]) assert.ok(toml.includes(`"${prefix}"`), `keyword ${prefix}`);
});

test("inline JSON is only for plain typed words: both docs that carry the rule state it, and no example breaks it", () => {
  for (const f of [SKILL, AGENTS]) assert.match(flat(read(f)), /no quote, `\$`, backtick or `\\`, and nothing (taken )?from the repo/, f);
  assert.ok(flat(read(SKILL)).includes("a keyword from the repo or a card goes through `@file`"), "SKILL.md Step 2 points back to the rule");
  for (const f of DOCS) {
    for (const m of read(f).matchAll(INLINE_JSON)) assert.ok(!UNSAFE_INLINE.test(m[1] ?? m[2]), `${f}: inline JSON with $, a backtick or a backslash: ${m[0]}`);
  }
});
