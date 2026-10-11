# Research: packaging mechanisms (as of 2026-10-11)

Fetched live on 2026-10-11. Version numbers are mostly not stated on the doc pages; where unknown it says so.

## Cross-agent baseline: Agent Skills open standard

Source: https://agentskills.io/specification

A skill is a directory with `SKILL.md` (YAML frontmatter `name` = directory name, lowercase, hyphens, max 64;
`description` max 1024; optional `license`, `compatibility`, `metadata`, `allowed-tools`) plus optional `scripts/`,
`references/`, `assets/`. Claude Code, Codex and Gemini CLI all load this format, so one `skills/sprintree/`
directory serves all three. Keep SKILL.md under about 500 lines.

## (a) Claude Code: plugins, marketplaces, skills

Sources: https://code.claude.com/docs/en/plugin-marketplaces, https://code.claude.com/docs/en/plugins/manifest-reference,
https://code.claude.com/docs/en/mcp

- Marketplace = repo with `.claude-plugin/marketplace.json` (required: `name`, `owner`, `plugins[]`; each entry `name` + `source`).
  `source` may be a relative path (`./...`, no `..`), `github`, `git-subdir`, `url`, `archive`, `npm`, `command`.
- Plugin manifest `.claude-plugin/plugin.json`, only `name` required (kebab-case; names starting `claude-`/`anthropic-` are reserved).
  Standard layout at plugin root: `skills/<name>/SKILL.md`, `.mcp.json`, `hooks/`, `agents/`, `commands/`.
  Skills are namespaced: `/sprintree:sprintree`.
- Install: `claude plugin marketplace add <owner>/<repo>`, `claude plugin install <plugin>@<marketplace>` (also `/plugin ...` in a session).
  Validate: `claude plugin validate <path>`. Verified locally: both manifests of this repo pass.
- `.mcp.json` HTTP server: `{"mcpServers":{"x":{"type":"http","url":"..."}}}` (an entry with `url` and no `type` is read as stdio, an error). `${VAR}` expansion works in `url`/`headers`.
- Auth: OAuth via `/mcp` then Authenticate, or `claude mcp login <name>`; a static `--header "Authorization: Bearer ..."` disables the OAuth fallback.
- Separate route: submit to Anthropic's official directory (https://code.claude.com/docs/en/plugins/publish). Not required: any git repo works as a marketplace.
- Uncertain: a marketplace entry with `source: "./"` (plugin = repo root) passed `validate`, but was not install-tested from a remote.

## (b) OpenAI Codex CLI

Sources: https://learn.chatgpt.com/docs/extend/mcp?surface=cli, https://learn.chatgpt.com/docs/agent-configuration/agents-md,
https://learn.chatgpt.com/docs/build-skills.md (old developers.openai.com/codex/* URLs 308-redirect here)

- MCP: `codex mcp add <name> --url <https-url>` (Streamable HTTP); config in `~/.codex/config.toml` (or trusted-project `.codex/config.toml`)
  `[mcp_servers.<name>] url = "..."`, optional `bearer_token_env_var = "SPRINTREE_TOKEN"`. OAuth: `codex mcp login <name>` (`auth` defaults to `oauth`).
- AGENTS.md: global `~/.codex/AGENTS.override.md` or `AGENTS.md`, then per directory from repo root to cwd, concatenated, default cap `project_doc_max_bytes` 32 KiB.
- Skills: same SKILL.md format. Discovered in `$CWD/.agents/skills`, parent dirs up to `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`.
  Installer: `$skill-installer <name>` (curated list or other repos).
- Plugins: the page says plugins bundle skills, optional MCP config and assets, with a universal directory shared by ChatGPT and Codex,
  and points to https://developers.openai.com/plugins/build/plugins. NOT fetched or verified here, so no Codex plugin manifest is shipped.
- Custom prompts: not covered by the fetched pages (the old `~/.codex/prompts` mechanism may be deprecated in favour of skills - unverified).
- Version: no CLI version stated on these pages. Local `codex` is installed but its version was not needed.

## (c) Gemini CLI extensions

Sources: https://geminicli.com/docs/extensions/, https://geminicli.com/docs/extensions/reference/, https://geminicli.com/docs/tools/mcp-server/

- Extension = directory/GitHub repo with `gemini-extension.json` (`name` lowercase-dashes matching the dir, `version`, `description`, `mcpServers`,
  `contextFileName` (default `GEMINI.md` in the extension root), `settings` (env vars, `sensitive` goes to keychain), `excludeTools`, `themes`...).
  Also `skills/<name>/SKILL.md`, `commands/*.toml`, `hooks/hooks.json`, `agents/*.md` (preview), `policies/*.toml`.
  Variables `${extensionPath}`, `${workspacePath}`, `${/}`.
- Install: `gemini extensions install <github-url> [--ref] [--auto-update]`, dev: `gemini extensions link <path>`; also list/update/enable/disable/uninstall.
- MCP: `httpUrl` = Streamable HTTP, `url` = SSE. OAuth discovered automatically on 401, sign in with `/mcp auth <server>`. CLI: `gemini mcp add --transport http [-H "Authorization: Bearer $T"] [-s user] <name> <url>`.
- Notice on the docs: for unpaid-tier and Google One users Gemini CLI was replaced by Antigravity CLI on 2026-06-18. Whether Antigravity reads `gemini-extension.json` is UNKNOWN.
- Uncertain: the extension reference page gave no formal schema, so the `httpUrl` use inside an extension manifest follows the generic MCP page (extensions "support all MCP options except trust").
  Not install-tested (no `gemini` binary here).

## (d) Generic fallback

- `AGENTS.md` is the shared convention (Codex reads it natively; Claude Code reads `CLAUDE.md`, which can import `@AGENTS.md`; Gemini reads `GEMINI.md`/`contextFileName`).
  This repo ships a self-contained template `templates/AGENTS.md` (short rules plus a pointer to the full skill) and the extension's `GEMINI.md`.
- Any MCP-capable agent: add `https://sprintree.com/mcp` as a Streamable HTTP server with OAuth, or a PAT bearer header.
- No MCP at all: `skills/sprintree/scripts/st.mjs` speaks the same JSON-RPC over HTTP using only Node >= 18.7.0.
