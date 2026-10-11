# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).
While 0.x, a skill rule change is a minor bump and a fix is a patch. `scripts/check-version.mjs` keeps every
version in the repo equal to the newest released heading below (`## [Unreleased]` is skipped).

## [Unreleased]

## [0.1.0] - TBD

- Generalised `sprintree` skill (sync and task modes, configurable language, typography, status mapping).
- Cross-platform `st.mjs` client (Node >= 18.7.0, token from `SPRINTREE_TOKEN`).
- Packaging: Claude Code plugin + marketplace, Gemini CLI extension, Codex and generic `AGENTS.md`.
- Fallback client: timeouts (`SPRINTREE_TIMEOUT_MS`), https-only `SPRINTREE_MCP_URL` (a host other than sprintree.com is named on stderr, an invalid URL is never echoed),
  `version`. Arguments are inline JSON or `@file` only: text you did not write goes through a file outside the repo.
- Config: `.sprintree.json` and the doc files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/CLAUDE.md`) are read by one safe reader
  (a symlink is fine when its real target is a regular file of at most 1 MB inside the repo root, owned by you; no hard-linked `.sprintree.json`).
  The repo root is the directory holding `.git`. Inside `$HOME` the search goes up to `$HOME`. Outside `$HOME` a `.git` counts only when you own it
  (on Windows only the starting directory is looked at). Without a `.git` only the starting directory is read. `config` prints only the known keys.
- Output: terminal escape sequences and invisible characters are stripped from everything printed (ZWJ, ZWNJ, LRM, RLM, an emoji variation selector
  and the England, Scotland and Wales flags stay). `itn_`, `itna_` and `itnr_` tokens are redacted, also when percent-encoded or `\u`-escaped.
- `templates/AGENTS.md`: instructions for any MCP agent, with the install location of the skill per client and the file-based way to pass text to `st.mjs`.
- `.gitleaks.toml`: a rule for Sprintree tokens (`itn_`, `itna_`, `itnr_`).
- Skill rules: untrusted card text, paging, `expect`, done gate, live-schema task pick.
- Repo hygiene: CI matrix on Node 18.7.0/22/24, version check, SECURITY.md, PCC adapter, gitleaks.
