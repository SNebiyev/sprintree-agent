# PCC adapter - sprintree-agent

Protocol: the `pcc` skill. Only what is specific to this repo is here.
Clean point: local git tag `pcc-clean` (moves to HEAD after a green sweep). Scope: `git diff --no-renames --name-only pcc-clean...HEAD`. One range everywhere: `pcc-clean...HEAD` (three dots) for the review `range`, for `changedLines` (`git diff --numstat`) and for `security`, so security is computed from the same files the reviewer sees.
low_risk_paths: ^(CHANGELOG|CONTRIBUTING)\.md$|^docs/maintainers/RESEARCH\.md$|^test/(lint-json|version)\.test\.mjs$
<!-- security = true unless EVERY changed file matches low_risk_paths: `git diff --no-renames --name-only <range> | command grep -Evq '<regex>'` (`command grep`: Claude Code's grep shell function (ugrep) exits 1 on `-vq` over stdin, which would make security false) (exit 0 = some file is not low-risk = security=true). A missing line means security=true. An EMPTY changed-file list means the range is wrong (`printf '' | command grep -Evq RE` exits 1, i.e. security=false): stop and fix the range, never treat it as security=false. -->
<!-- Not low-risk on purpose (SPD-1212): README.md is the install and token-handling surface users copy from (install source, read-only token, env var not plain-text config, revoke); test/st.test.mjs, runs.test.mjs and tools.test.mjs are the regression net for token hiding, terminal-control stripping and token separation, and test/docs.test.mjs keeps the gitleaks rule equal to st.mjs redaction and bans pipe/stdin forms for untrusted text, so a large delta that weakens them must still get the security lens. lint-json and version tests stay low-risk: they read manifests and version strings, and spawn check-version.mjs with the token blanked. Listed by name: a new test file is not low-risk until it is added here. -->
No tag yet: the first sweep covers the WHOLE repo (there was never a clean point; three pushes `746c774`, `22287a9`, `86a1f1e` went out without PCC).

**Rule: nothing is pushed to master before a green sweep.** Not a one-line fix, not docs.

## Stack
Dependency-free Node (>=18.7.0) scripts and JSON manifests, a Markdown skill. No build step.

## gate (every commit)
```bash
npm test                                                              # local Node; `node --test` discovers test/*.test.mjs: client, tool check, version check, JSON lint, docs
# MIN_NODE (18.7.0, the CI matrix pins the same) and the newest LTS (24.21.0): the suite under that exact Node binary directly; a failure in ANY iteration fails the gate
rc=0; for n in 18.7.0 24.21.0; do timeout 300 "$(npx -y node@$n -p process.execPath)" --test || { echo "FAILED on Node $n"; rc=1; }; done; test $rc = 0
claude plugin validate . --strict && claude plugin validate .claude-plugin/plugin.json --strict && claude plugin validate .claude-plugin/marketplace.json --strict
docker run --rm --network none -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
# gitleaks needs a real .git dir: in a worktree (.git is a file) it scans 0 commits, so scan a clone (check "N commits scanned" > 0)
rm -rf "$SCRATCH/gl" && git clone -q --no-local . "$SCRATCH/gl" && docker run --rm --network none -v "$SCRATCH/gl:/repo" zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f detect --source /repo --config /repo/.gitleaks.toml --log-opts=--all --no-banner
```
Negative control (must FAIL and name the sprintree-token rule for each of these): in a throwaway git repo outside the worktree, commit a file with a fake
`itn_`, `itnh_`, `itna_` and `itnr_` token (one of them bare in prose), a token between underscores (`_itn_...._`), one after an underscore
(`SPRINTREE_TOKEN_itn_....`), a percent-encoded one (`Bearer%20itn_....`, `token%3Ditnr_....`) and a `\u005f`-escaped one (`itna\u005f....`), plus a line of plain prose,
`keyitn_....` and `itnac_....` that must NOT be flagged (that is the gitleaks rule only: it skips a token glued to a word, while st.mjs hides that one too). Run the same gitleaks command
with `--config /repo/.gitleaks.toml` copied there and read the findings (rule, line), not just the exit code.
The tools are pinned (actionlint 1.7.12, gitleaks v8.30.1, Node 18.7.0 and 24.21.0): bump them on purpose, in a commit of their own, and re-run the negative control.
Evidence is the output (`# pass N`, `# fail 0`, `no leaks found`), not the exit code. Keep this a superset of `.github/workflows/test.yml`.

## sweep
1. Gate above.
2. Review (PCC v2, once per batch): `Workflow({name: "pcc:pcc-review", args: {repo, range: "pcc-clean...HEAD", changedLines, security, tier?, fix?, lanes?}})`.
   `security` comes from `low_risk_paths:` at the top of this file (true unless every changed file is low-risk). Agents: `tier: 'docs'` (prose-only delta) = one agent; under 100 changed
   lines = one Opus agent; 100+ lines = three (security, correctness, simplify) when security=true (some changed file is outside low_risk_paths), else two (correctness + simplify).
   Severity gate: HIGH blocks; MEDIUM inside the delta is fixed in the same fix commit; out-of-delta MEDIUM, LOW and nits become cards/debt and are NOT
   fixed in this run. Mechanical gates (lint, typecheck, tests) stay fix-everything. With `fix: true` one sonnet fixer makes one commit, then ONE Opus
   fix-check reads only that fix diff; at most 2 fix cycles, then `structural`. There are no review rounds. `blocked` or `uncovered` is not a ship.
   This repo has no packages and no e2e: after a fix run `npm test` (seconds); the full gate (both Node versions, plugin validate, actionlint, gitleaks over a clone) runs ONCE before the push.
   Cost line in the report: `python3 -I /home/sn/Documents/Projects/claude-pcc/scripts/pcc-cost.py --project-dir ~/.claude/projects/<key> --since <batch start ISO>`
   (target for a 10-15 file delta: <= 600k tokens, <= 2 h).
   Lanes for pcc-review are the `## gate` block only (step 1); steps 2-4 (review, push/CI, tag) are orchestrator-only and are never run as lanes.
3. Push, then read CI on GitHub (`gh run list`/`gh run watch`): green on the pushed commit across 3 OS x Node 18.7.0/22/24. Red CI blocks.
4. Green: `git tag -f pcc-clean HEAD`.

## Lanes this repo does not have
- Live-server tests: `test/tools.snapshot.json` is refreshed by hand (`npm run tools:refresh`, needs a token), never in CI.
- Per-client install tests: tracked in SPD-978 phase B.

## Traps
- `cp`/`rm` are `-i` aliases here: use `/bin/cp -f`.
- Tokens must never appear in fixtures except obviously fake ones (`.gitleaks.toml` has a rule for `itn_`, `itnh_`, `itna_` and `itnr_` tokens).
