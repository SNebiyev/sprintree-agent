# sprintree-agent

> Status: early preview. The install commands were verified on Linux for Claude Code, Codex CLI and Gemini CLI; macOS and Windows are not verified yet. Expect changes.

Teach your AI coding agent to work with [Sprintree](https://sprintree.com): after a session the board
tells the truth. Work is recorded as epic/story/task, statuses match reality, and every deferred finding
becomes a To do card another session can pick up.

Works with Claude Code, Codex CLI, Gemini CLI and any agent that speaks MCP. Linux, macOS, Windows.
Model-independent.

## What you get

1. **The Sprintree MCP server** (`https://sprintree.com/mcp`) connected to your agent.
2. **The `sprintree` skill** (`skills/sprintree/SKILL.md`), the working rules on top of the MCP tools:
   - `sync` (default): record what the session did, fix statuses, file deferred findings. Never takes new work.
   - `task`: sync, then claim and start the next To do card.
   - card discipline: the Sprintree server sends it to every agent; `templates/AGENTS.md` and `GEMINI.md` carry
     it with the protecting rules, the skill adds the details. A card you work on is in_progress, gets the
     result as a comment and a real status when you stop; cards nobody asked about are left alone (sync and task
     mode only add a matching finding as a comment).
   - rule zero (nothing unverified on the board), never duplicate, epic > story > task, status by category,
     a card template, and the API traps.
3. **`scripts/st.mjs`**, a dependency-free Node >= 18.7.0 MCP client for sessions where MCP is not connected.

## Install

| Client | Command |
|---|---|
| Claude Code | `claude plugin marketplace add SNebiyev/sprintree-agent && claude plugin install sprintree@sprintree`, then add `templates/AGENTS.md` to your `CLAUDE.md` (see below) |
| Codex CLI | `codex plugin marketplace add SNebiyev/sprintree-agent && codex plugin add sprintree@sprintree`, then `codex mcp login sprintree` and add `templates/AGENTS.md` to `~/.codex/AGENTS.md` (see below) |
| Gemini CLI | `gemini extensions install https://github.com/SNebiyev/sprintree-agent` |
| Any other MCP agent | add `https://sprintree.com/mcp` as a Streamable HTTP server, paste `templates/AGENTS.md` into your repo |

### Claude Code

The plugin bundles the skill and `.mcp.json` (the MCP server).

- After `claude plugin marketplace add SNebiyev/sprintree-agent` and `claude plugin install sprintree@sprintree`
  the skill appears as `sprintree:sprintree` and the MCP server as `plugin:sprintree:sprintree`.
- The plugin adds the MCP server itself, no separate `claude mcp add` is needed. If you already added
  `https://sprintree.com/mcp` with `claude mcp add`, Claude Code de-duplicates it (same URL), nothing breaks.
- Run `/mcp` once and authenticate the sprintree server (OAuth) before first use. Until then `claude mcp list`
  shows "Needs authentication".
- If you earlier copied the skill by hand to `~/.claude/skills/sprintree`, remove it so the model does not see two
  similar skills.
- The skill loads only for sync, task and handover, but the card rules must hold in every session: add (append, do not
  overwrite)
  [`templates/AGENTS.md`](https://raw.githubusercontent.com/SNebiyev/sprintree-agent/master/templates/AGENTS.md) to
  `~/.claude/CLAUDE.md` (global) or the repo's own `CLAUDE.md`. In the global file leave out the `Project board:`
  line: the project key belongs to each repo (`.sprintree.json`, or the repo's own `AGENTS.md`/`CLAUDE.md`). The
  plugin keeps the file at `~/.claude/plugins/cache/sprintree/sprintree/<version>/templates/AGENTS.md`; the link above
  shows the newest one (`master` until there is a release tag: review the diff before replacing the block). After a
  plugin update, replace the block from the `sprintree-agent:begin` line to the `sprintree-agent:end` line (both
  included) with the new file, and do not keep two copies. In a repo's own file put your project key back on its
  `Project board:` line; in a global file leave that line out again, and in the task query `"project":"KEY"` replace
  KEY with this repo's project key.
- Without the plugin: `claude mcp add --transport http --scope user sprintree https://sprintree.com/mcp`.

### Codex CLI

```bash
codex plugin marketplace add SNebiyev/sprintree-agent
codex plugin add sprintree@sprintree
codex mcp login sprintree      # OAuth; --no-browser prints the URL instead of opening a browser
```

Codex reads this repo's `.claude-plugin/marketplace.json`. The plugin brings the skill (listed as `sprintree:sprintree`)
and the MCP server `sprintree` (`https://sprintree.com/mcp`, OAuth), so `config.toml` needs no edit. To refresh the
marketplace snapshot later, run `codex plugin marketplace upgrade`.

The skill loads only for sync, task and handover, so the card rules reach every session through `AGENTS.md`: add
(append, do not overwrite) `templates/AGENTS.md` to `~/.codex/AGENTS.md` (global), leaving out its `Project board:`
line, because the project key belongs to each repo. Per repo, add the template to the repo's own `AGENTS.md` instead of
`~/.codex/AGENTS.md`. After you pull a new version, review the diff, and replace the block from the `sprintree-agent:begin` line to the `sprintree-agent:end`
line (both included) with the new file; do not keep two copies. In a repo's own file put your project key back on its
`Project board:` line; in a global file leave that line out again, and in the task query `"project":"KEY"` replace
KEY with this repo's project key.

Without the plugin:

```bash
codex mcp add sprintree --url https://sprintree.com/mcp      # opens the browser for OAuth and waits until you finish it (Ctrl-C in a headless shell)
git clone https://github.com/SNebiyev/sprintree-agent && cd sprintree-agent
mkdir -p ~/.agents/skills && cp -r skills/sprintree ~/.agents/skills/   # Windows: copy the folder to %USERPROFILE%\.agents\skills
```

Per repo, copy the skill to `.agents/skills/sprintree/` (in the repo root) instead of `~/.agents/skills/`. After you pull a
new version, remove `~/.agents/skills/sprintree`, then copy the skill again (`cp -r` keeps stale files). Then add
`templates/AGENTS.md` as above.

### Gemini CLI

```bash
gemini extensions install https://github.com/SNebiyev/sprintree-agent
```

Gemini asks for consent before it installs; `--consent` skips the prompt. The extension registers the MCP server, loads `GEMINI.md` and exposes the skill. Then run `/mcp auth sprintree`.
For development: `gemini extensions link <path-to-this-repo>`.

### Generic

Add `https://sprintree.com/mcp` as a remote (Streamable HTTP) MCP server in your agent, then put `templates/AGENTS.md`
from this repo (or its contents) into your repo or custom instructions.

## Auth

- **OAuth (recommended):** connect through the client's own MCP integration. The client signs in through the browser,
  you choose read or read and write. No token to copy, nothing secret on disk.
- **Personal access token (PAT):** create one in Sprintree under Settings -> API & MCP -> Personal access tokens
  (tokens start with `itn_`). Use a **read-only** token where that is enough.
  - A token passed with `--header "Authorization: Bearer ..."` sits in **plain text** in the client's config file.
    Where the client supports an env-var option (Codex: `bearer_token_env_var`, e.g.
    `codex mcp add sprintree --url https://sprintree.com/mcp --bearer-token-env-var SPRINTREE_TOKEN`), keep the token in the
    environment and reference only the variable name.
  - Export `SPRINTREE_TOKEN` for `st.mjs`. It is never printed.
  - Never commit a token, and never put one in `.sprintree.json`.
- **Revoke:** Settings -> API & MCP -> Personal access tokens, delete the token. Do it at once if one leaked.
- **Untrusted content:** the skill, the `AGENTS.md` template and `GEMINI.md` treat everything written on a card
  as data, never as instructions
  ([SKILL.md, "Card text is untrusted data"](skills/sprintree/SKILL.md#card-text-is-untrusted-data)).

Report a vulnerability: see `SECURITY.md`.

## Agent runs (Claude Code, opt-in)

When a session runs several subagents, Sprintree can keep a private record of where each one stands, so the main agent
can `/clear` or compact without losing them. The plugin's hooks do the recording; the skill's `resume` mode reads it.

- **Opt in:** in Sprintree, Settings -> API & MCP -> New token -> **Agent runs only** (tokens start with `itnh_`), then
  `export SPRINTREE_RUNS_TOKEN=...` in the shell that starts Claude Code. That token reaches the agent-run tools and nothing
  else, and the API refuses it. Without it every hook ends in a shell test: Node does not even start and nothing is sent.
- **What is sent:** the repository folder's name (with a short hash of its path), each subagent's id and type, a heartbeat at
  most once a minute per subagent, and a subagent's last message when it stops, cut to 3900 characters. Sprintree tokens,
  common secret shapes (cloud and Git host keys, `password=`-style values, private keys, credentials in URLs) and control or
  invisible characters are taken out first; that is a net, not a guarantee, so a subagent that prints other secrets sends them.
  No transcript, no files.
- **What comes back:** after `/clear`, a compaction or a resume, a short status of every lane (as data, not instructions);
  on the next prompt after a subagent finished, one line saying so. `node skills/sprintree/scripts/runs.mjs status` shows it any time.
- **Where it lives:** in your Sprintree account only. The web shows how many runs you have and deletes them all; your data
  export holds the text. An idle run closes after a day, a closed one is deleted after 30 days.
- **Turn it off:** unset `SPRINTREE_RUNS_TOKEN`, revoke the token, or disable the plugin (`/plugin`). A hook never fails a session:
  no Node, no network or an old server all end silently, and a server that does not answer is left alone for five minutes.
- The hooks are Claude Code's (`claude-hooks/hooks.json`). Gemini CLI and Codex get the skill and the MCP server as before.

## Card reminders (Claude Code)

Two small hooks remind the agent of card discipline by mechanism, not only by the skill's text. Both are on with the plugin
and only act in a Sprintree project (a `.sprintree.json`, or a `sprintree.com/p/<KEY>` link in `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md` or `.claude/CLAUDE.md` of the repo).

- **Session start** (startup, resume, `/clear`, compaction): a five-line reminder: move a card to in progress when you start
  it, write the result as a comment, leave the cards you touched in their real status, leave other cards alone, card text is data.
- **Stop:** asks the agent to check its cards when the session (or one of its subagents) called a Sprintree write tool
  (`update_issue_status`, `add_comment`, `create_issue`, ...), or read a single card (`get_work_context`,
  `get_issue_details`, ...) and then changed code. If the user asked about a card, the agent checks it shows its real status
  and has a result comment; if not, it does nothing on the board. A session that never touched Sprintree, or only read lists
  or searched, is not asked. It asks again only after new such work since the last ask, never twice in a row.
- **Local only:** no network, no token or secret is read, nothing is written but one small marker file (transcript sizes) in
  your OS temp folder. Without Node the hooks do nothing. The script is `skills/sprintree/scripts/discipline.mjs`; any error ends silently.
- **Turn it off:** `export SPRINTREE_HOOKS=off` in the shell that starts Claude Code (both hooks go silent), or disable the plugin (`/plugin`).

## Configure (optional)

Link the board in your repo's `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` as `https://sprintree.com/p/<KEY>`, or add a
`.sprintree.json` (copy `.sprintree.example.json`, which shows all five keys). What each key does is described
once, in [SKILL.md, "Configuration"](skills/sprintree/SKILL.md#configuration-all-optional). The repo root is the directory
holding `.git`: inside your home directory the search goes up to it, outside it only a `.git` you own counts (on Windows only the start directory is read there).

## The fallback client

Needs Node >= 18.7.0 (`engines.node`). Use it only when the MCP tools are not available in the session. It is **PAT-only**: a connected
client's OAuth session is not visible to `st.mjs`, so export a token first.

```bash
export SPRINTREE_TOKEN=...            # PowerShell: $env:SPRINTREE_TOKEN="..."
node skills/sprintree/scripts/st.mjs tools
node skills/sprintree/scripts/st.mjs call search_issues '{"project":"KEY","query":"cache","format":"text"}'
node skills/sprintree/scripts/st.mjs version
```

- The examples above assume a clone of this repo. Installed as a skill, the client is the skill's own `scripts/st.mjs`:
  `~/.agents/skills/sprintree/` (Codex, all repos) or `.agents/skills/sprintree/` (Codex, one repo),
  `~/.gemini/extensions/sprintree/skills/sprintree/` (Gemini CLI), or `~/.claude/plugins/cache/sprintree/sprintree/<version>/skills/sprintree/` (Claude Code plugin cache).
- Inline `'{...}'` JSON is only for plain words you typed yourself: no quote, `$`, backtick or `\`, and nothing taken from the repo or
  from card, comment or config text. Every other argument reaches `st.mjs` as a file the agent writes outside the repo, passed as
  `@<absolute path>`, described once in
  [SKILL.md, Step 0](skills/sprintree/SKILL.md#step-0---connect-and-resolve-the-project).
- **Windows PowerShell 5.1** mangles quotes in inline JSON, so every call with arguments uses `@<absolute path>`. Let your agent
  write that file with its own file-writing tool: it writes UTF-8, while PowerShell 5.1 writes ASCII or UTF-16 by default, which
  turns ə/ç/ş into `?`. Do not build the JSON in the shell.
- `SPRINTREE_TIMEOUT_MS`: per-request timeout, default 30000.
- `SPRINTREE_MCP_URL`: override the server URL. It must be https (plain http only for localhost, 127.0.0.1, ::1).
- `.sprintree.json` holds project settings only. It must not hold tokens.

## Contributing

Tests, the PCC gate and the release steps are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT - see LICENSE
