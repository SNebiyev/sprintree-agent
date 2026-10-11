# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).
While 0.x, a skill rule change is a minor bump and a fix is a patch. `scripts/check-version.mjs` keeps every
version in the repo equal to the newest released heading below (`## [Unreleased]` is skipped).

## [Unreleased]

## [0.1.0] - TBD

- Generalised `sprintree` skill (sync and task modes, configurable language, typography, status mapping).
- Cross-platform `st.mjs` client (Node >= 18.8.0, token from `SPRINTREE_TOKEN`).
- Packaging: Claude Code plugin + marketplace, Gemini CLI extension, Codex and generic `AGENTS.md`.
- Fallback client hardening: timeouts (`SPRINTREE_TIMEOUT_MS`), https-only `SPRINTREE_MCP_URL` (a host other than sprintree.com is named on stderr),
  `call <tool> -` (JSON on stdin), `version`.
- Config hardening: `.sprintree.json` and the doc files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) are read by one safe reader (regular file, at most 1 MB,
  no symlink, no hard link, inside the repo root); `config` prints only the known keys; terminal escape sequences, bidi and zero-width characters
  are stripped from everything printed and `itn_`, `itna_`, `itnr_` tokens are redacted.
- `templates/AGENTS.md`: instructions for any MCP agent, with the install location of the skill per client and the file-based way to pass text to `st.mjs`.
- `.gitleaks.toml`: a rule for Sprintree tokens (`itn_`, `itna_`, `itnr_`).
- Skill rules: untrusted card text, paging, `expect`, done gate, live-schema task pick.
- Repo hygiene: CI matrix on Node 18.8.0/22/24, version check, SECURITY.md, PCC adapter, gitleaks.
