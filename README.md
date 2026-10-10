# sprintree-agent

> Status: early preview. The install commands below are being verified client by client; expect changes.

Teach your AI coding agent to work with [Sprintree](https://sprintree.com): after a session the board
tells the truth. Work is recorded as epic/story/task, statuses match reality, and every deferred finding
becomes a To do card another session can pick up.

Works with Claude Code, Codex CLI, Gemini CLI and any agent that speaks MCP. Linux, macOS, Windows.
Model-independent. Status: **local draft, not published.**

## What you get

1. **The Sprintree MCP server** (`https://sprintree.com/mcp`) connected to your agent.
2. **The `sprintree` skill** (`skills/sprintree/SKILL.md`), the working rules on top of the MCP tools:
   - `sync` (default): record what the session did, fix statuses, file deferred findings. Never takes new work.
   - `task`: sync, then claim and start the next To do card.
   - rule zero (nothing unverified on the board), never duplicate, epic > story > task, status by category,
     a card template, and the API traps.
3. **`scripts/st.mjs`**, a dependency-free Node >= 18 MCP client for sessions where MCP is not connected.

## Install (one command per client)

| Client | Command |
|---|---|
| Claude Code | `claude plugin marketplace add SNebiyev/sprintree-agent && claude plugin install sprintree@sprintree` |
| Codex CLI | `codex mcp add sprintree --url https://sprintree.com/mcp` then copy `skills/sprintree` to `~/.agents/skills/` (see below) |
| Gemini CLI | `gemini extensions install https://github.com/SNebiyev/sprintree-agent` |
| Any other MCP agent | add `https://sprintree.com/mcp` as a Streamable HTTP server, paste `AGENTS.md` into your repo |

### Claude Code

The plugin bundles the skill and `.mcp.json` (the MCP server). After install, run `/mcp`, choose
`sprintree`, Authenticate. The skill is `/sprintree:sprintree`. Without the plugin:
`claude mcp add --transport http --scope user sprintree https://sprintree.com/mcp`.

### Codex CLI

```bash
codex mcp add sprintree --url https://sprintree.com/mcp      # opens the browser for OAuth
mkdir -p ~/.agents/skills && cp -r skills/sprintree ~/.agents/skills/   # Windows: copy the folder to %USERPROFILE%\.agents\skills
```

Per repo, use `.agents/skills/sprintree` instead, and add the `AGENTS.md` snippet from this repo to the
repo's own `AGENTS.md`. Codex plugin packaging is documented by OpenAI but not verified here; see `docs/RESEARCH.md`.

### Gemini CLI

```bash
gemini extensions install https://github.com/SNebiyev/sprintree-agent
```

The extension registers the MCP server, loads `GEMINI.md` and exposes the skill. Then run `/mcp auth sprintree`.
For development: `gemini extensions link <path-to-this-repo>`.

### Generic

Add `https://sprintree.com/mcp` as a remote (Streamable HTTP) MCP server in your agent, then put `AGENTS.md`
from this repo (or its contents) into your repo or custom instructions.

## Auth

- **OAuth (recommended):** the client signs in through the browser, you choose read or read and write. No token to copy.
- **Personal access token:** create one in Sprintree under Settings -> API & MCP -> Personal access tokens (tokens start with `itn_`). Pass it as `Authorization: Bearer <token>`
  (for example `claude mcp add --transport http sprintree https://sprintree.com/mcp --header "Authorization: Bearer $SPRINTREE_TOKEN"`),
  and export `SPRINTREE_TOKEN` for `st.mjs`. The token is never printed by the client.

## Configure (optional)

Link the board in your repo's `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` as `https://sprintree.com/p/<KEY>`, or add a
`.sprintree.json` (see `.sprintree.example.json`): `project`, `language`, `typography`, and `statuses` (an optional override: the category names `todo`, `in_progress`, `review`, `done` work in every project).

## The fallback client

```bash
export SPRINTREE_TOKEN=...            # PowerShell: $env:SPRINTREE_TOKEN="..."
node skills/sprintree/scripts/st.mjs tools
node skills/sprintree/scripts/st.mjs call search_issues '{"project":"KEY","query":"cache","format":"text"}'
```

## Develop

`npm test` (Node >= 18, mocked fetch, no network, includes the tool-consistency check) and `npm run lint:json`. `npm run tools:refresh` rebuilds `test/tools.snapshot.json` from the live server (needs `SPRINTREE_TOKEN`, never runs in CI); `node scripts/check-tools.mjs` checks the docs against it offline. CI draft: `.github/workflows/test.yml`
(ubuntu, macos, windows).

## License

MIT - see LICENSE
