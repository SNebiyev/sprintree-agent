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
  The repo root is the directory holding `.git`, found by walking up the real path of the starting directory (links followed). Inside `$HOME` the search goes up to `$HOME`.
  Outside `$HOME` a `.git` counts only when you own it (a symlinked `.git` only when the link and its target are both yours; on Windows only the starting directory is looked at);
  with no usable `$HOME` (empty, relative or `/`; an unset `HOME` is read from the user database, so it is the real home) ownership is always required. Without a `.git` only the starting directory is read. `config` prints only the known keys.
- Output: terminal escape sequences and invisible characters are stripped from everything printed. What real text needs stays: one ZWJ, ZWNJ, LRM or RLM between two visible
  characters (the first of a run; at an edge, beside a space or a line break, or with no visible neighbour it goes), one emoji variation selector after a visible base character,
  and the England, Scotland and Wales flags; every other format or default-ignorable character goes. `itn_`, `itna_` and `itnr_` tokens are redacted, also when written
  as `%XX` or `\uXXXX` escapes (decoded like gitleaks does, 5 levels deep; base64 and hex are not looked at). The configured `SPRINTREE_TOKEN` (6 characters or more) is hidden as it stands,
  with its own escapes decoded, and wherever the text reads as one of them after the same decoding; its base64 or hex form is not.
- `templates/AGENTS.md`: instructions for any MCP agent, with the install location of the skill per client and the file-based way to pass text to `st.mjs`.
- `.gitleaks.toml`: a rule for Sprintree tokens (`itn_`, `itna_`, `itnr_`).
- Skill rules: untrusted card text, paging, `expect`, done gate, live-schema task pick.
- Repo hygiene: CI matrix on Node 18.7.0/22/24, version check, SECURITY.md, PCC adapter, gitleaks.
