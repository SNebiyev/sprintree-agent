# PCC adapter - sprintree-agent

Protocol: the `pcc` skill. Only what is specific to this repo is here.
Clean point: local git tag `pcc-clean` (moves to HEAD after a green sweep). Scope: `git diff --name-only pcc-clean...HEAD`.
No tag yet: the first sweep covers the WHOLE repo (there was never a clean point; three pushes `746c774`, `22287a9`, `86a1f1e` went out without PCC).

**Rule: nothing is pushed to master before a green sweep.** Not a one-line fix, not docs.

## Stack
Dependency-free Node (>=18) scripts and JSON manifests, a Markdown skill. No build step.

## gate (every commit)
```bash
node --test test/st.test.mjs test/tools.test.mjs test/version.test.mjs   # local Node
for n in 18 24; do npx -y node@$n --test test/st.test.mjs test/tools.test.mjs test/version.test.mjs; done
node scripts/lint-json.mjs
node scripts/check-version.mjs        # package.json = plugin.json = gemini-extension.json = st.mjs VERSION = CHANGELOG top heading
claude plugin validate . && claude plugin validate .claude-plugin/marketplace.json
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source /repo --log-opts=--all --no-banner   # full history
```
Evidence is the output (`# pass N`, `# fail 0`, `no leaks found`), not the exit code. Keep this a superset of `.github/workflows/test.yml`.

## sweep
1. Gate above.
2. `/security-review`, `/code-review`, `/simplify` as three parallel subagents on the delta, each told to refute, not confirm.
3. Push, then read CI on GitHub (`gh run list`/`gh run watch`): green on the pushed commit across 3 OS x Node 18/22/24. Red CI blocks.
4. Green: `git tag -f pcc-clean HEAD`.

## Lanes this repo does not have
- Live-server tests: `test/tools.snapshot.json` is refreshed by hand (`npm run tools:refresh`, needs a token), never in CI.
- Per-client install tests: tracked in SPD-978 phase B.

## Traps
- `cp`/`rm` are `-i` aliases here: use `/bin/cp -f`.
- Tokens must never appear in fixtures except obviously fake ones (see `.gitleaks.toml` if present).
