# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).
While 0.x, a skill rule change is a minor bump and a fix is a patch. `scripts/check-version.mjs` keeps every
version in the repo equal to the newest released heading below (`## [Unreleased]` is skipped).

## [Unreleased]

## [0.1.0] - TBD

- Generalised `sprintree` skill (sync and task modes, configurable language, typography, status mapping).
- Cross-platform `st.mjs` client (Node >= 18, token from `SPRINTREE_TOKEN`).
- Packaging: Claude Code plugin + marketplace, Gemini CLI extension, Codex and generic `AGENTS.md`.
- Fallback client hardening: timeouts (`SPRINTREE_TIMEOUT_MS`), https-only `SPRINTREE_MCP_URL`, `call <tool> -` (JSON on stdin), `version`.
- Skill rules: untrusted card text, paging, `expect`, done gate, live-schema task pick.
- Repo hygiene: CI matrix on Node 18/22/24, version check, SECURITY.md, PCC adapter, gitleaks.
