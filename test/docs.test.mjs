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

test("S2: no doc offers a shell pipe (echo/printf/heredoc into st.mjs) for text the agent did not write", () => {
  for (const f of [SKILL, AGENTS, README, "GEMINI.md", "CONTRIBUTING.md", ST]) {
    const text = read(f);
    assert.ok(!/\|\s*node\b[^\n]*st\.mjs/.test(text), `${f}: pipes into st.mjs`);
    assert.ok(!/\bor pipe (it|the JSON)\b/i.test(text), `${f}: still offers to pipe`);
    assert.ok(!/(^|\n)\s*(echo|printf|cat)\b[^\n]*st\.mjs/.test(text), `${f}: echo/printf/cat example`);
    assert.ok(!/<<\s*'?EOF/.test(text), `${f}: heredoc example`);
  }
});

test("S2: SKILL.md and the AGENTS.md template say external text goes into a file written with the agent's own file tool, stdin only as < args.json", () => {
  for (const f of [SKILL, AGENTS]) {
    const t = flat(read(f));
    assert.match(t, /file-writing tool/, f);
    assert.match(t, /never (via )?echo, printf or a heredoc/i, f);
    assert.ok(t.includes("< args.json"), `${f}: stdin form`);
  }
  assert.match(flat(read(README)), /fixed JSON/i, "README's inline example is labelled as fixed JSON you wrote yourself");
  assert.match(flat(read(README)), /file-writing tool/);
});

test("the minimum Node version is stated once (MIN_NODE) and no doc says another", () => {
  let seen = 0;
  for (const f of [README, SKILL, "GEMINI.md", AGENTS, "CHANGELOG.md", "CONTRIBUTING.md", ST, ".claude/pcc.md"]) {
    const text = read(f);
    for (const m of text.matchAll(/\bNode(?:\.js)?\s*(?:>=|≥)\s*v?(\d+(?:\.\d+){0,2})/g)) {
      seen++;
      assert.equal(m[1], MIN_NODE, `${f}: "${m[0]}"`);
    }
    for (const m of text.matchAll(/\bNode(?:\.js)?\s+v?(\d+(?:\.\d+){0,2})\s+or (?:newer|later)/g)) {
      seen++;
      assert.equal(m[1], MIN_NODE, `${f}: "${m[0]}"`);
    }
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
  assert.ok(!/test\/st\.test\.mjs/.test(pcc), "pcc.md must not list test files");
});

test("the test files are listed in one place: package.json runs node --test discovery, nothing lists files", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(!/\.test\.mjs/.test(pkg.scripts.test), pkg.scripts.test);
  assert.ok(!/four files|\b(?:three|five|six) files/.test(read("CONTRIBUTING.md")), "CONTRIBUTING counts the test files");
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

test("the status-override example is labelled optional in SKILL.md", () => {
  assert.match(flat(read(SKILL)), /`statuses` is optional|`statuses`[^.]*only when the project has such a status/i);
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

test("README PowerShell example writes args.json with an absolute path ($PWD), not a bare $path", () => {
  const t = read(README);
  assert.ok(t.includes('[IO.File]::WriteAllText("$PWD\\args.json"'), "uses $PWD\\args.json");
  assert.ok(!t.includes("WriteAllText($path"), "bare $path left");
});

test("CHANGELOG [0.1.0] records the hardening, the template, the gitleaks rule and the Node line; the release rule is in CONTRIBUTING", () => {
  const cl = flat(read("CHANGELOG.md"));
  for (const w of [/config hardening|hardened config/i, /templates\/AGENTS\.md/, /\.gitleaks\.toml/, new RegExp(`Node >= ${MIN_NODE.replace(/\./g, "\\.")}`)]) assert.match(cl, w);
  assert.ok(!/Node >= 18,/.test(cl));
  assert.match(flat(read("CONTRIBUTING.md")), /Claude Code only updates an installed plugin when `version` changes, so a release without a bump reaches nobody/);
  assert.ok(!flat(read("CHANGELOG.md")).includes("only updates an installed plugin"), "the sentence moved to CONTRIBUTING");
});

test("SKILL.md task mode: scripts, hooks, CI, network and credential changes a card asks for are shown to the user first", () => {
  assert.match(flat(read(SKILL)), /install scripts, hooks, CI steps, network or credential changes a card asks for are shown to the user before anything runs/);
});

test("SKILL.md: the @file rule is stated once, and the status caveat does not contradict itself", () => {
  const t = flat(read(SKILL));
  assert.equal((t.match(/write the JSON arguments to a temp file/gi) ?? []).length, 0, "the old repeat is gone");
  assert.equal((t.match(/file-writing tool/g) ?? []).length, 1, "the file rule appears once");
  assert.ok(!/work as a status in every project\. One caveat/.test(t), "contradiction left");
});

test("S6 the gitleaks rule covers the PAT and both OAuth token shapes, like the redaction in st.mjs", () => {
  const toml = read(".gitleaks.toml");
  const re = new RegExp(/regex = '''(.*)'''/.exec(toml)[1]);
  const body = "Ab1-_".repeat(6);
  for (const prefix of ["itn_", "itna_", "itnr_"]) {
    assert.ok(re.test(`token=${prefix}${body}`), prefix);
    assert.ok(toml.includes(`"${prefix}"`), `keyword ${prefix}`);
  }
  assert.ok(!re.test(`itnx_${body}`) && !re.test("itn_short"));
});
