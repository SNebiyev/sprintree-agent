# Contributing

## Tests

`npm test` (Node >= 18.14, mocked `fetch`, no network) runs `node --test` over four files:

- `test/st.test.mjs` - the fallback client `skills/sprintree/scripts/st.mjs`.
- `test/tools.test.mjs` - every tool, argument and enum value named in the docs exists in `test/tools.snapshot.json`
  (`scripts/check-tools.mjs`).
- `test/version.test.mjs` - one version everywhere (`scripts/check-version.mjs`; on a tag build the tag is checked too).
- `test/lint-json.test.mjs` - every JSON manifest parses.

`npm run tools:refresh` rebuilds `test/tools.snapshot.json` from the live server (needs `SPRINTREE_TOKEN`, never runs in CI).
CI (`.github/workflows/test.yml`) runs `npm test` on ubuntu, macos and windows with Node 18, 22 and 24.

## The PCC gate

PCC ("pre commit check") is the checklist that has to be green before anything is pushed: the tests on the oldest
and newest supported Node, plugin manifest validation, the workflow linter, and a secret scan of the whole git history.
It is a superset of CI. The exact commands, and the review sweep that follows them, are in [.claude/pcc.md](.claude/pcc.md).
Nothing is pushed to the main branch before it is green, not a one-line fix and not docs.

## Release

Versioning rules are in [CHANGELOG.md](CHANGELOG.md). The version lives in `package.json`, `.claude-plugin/plugin.json`,
`gemini-extension.json`, `VERSION` in `skills/sprintree/scripts/st.mjs` and the newest released heading of `CHANGELOG.md`;
`npm test` fails if they differ.

1. Bump all of those, and move the `[Unreleased]` notes under `## [x.y.z] - YYYY-MM-DD` in `CHANGELOG.md`.
2. `npm test` and the rest of the PCC gate green, push, CI green.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` (CI re-checks the tag against the version).
4. Create the GitHub Release from the tag with the changelog section as notes.
