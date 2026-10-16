# sprintree-agent

> Status: early preview. The install commands were verified on Linux for Claude Code, Codex CLI and Gemini CLI; macOS and Windows are not verified yet. Expect changes.

Teach your AI coding agent to work with [Sprintree](https://sprintree.com): after a session the board
tells the truth. Work is recorded as epic/story/task, statuses match reality, and every deferred finding
becomes a To do card another session can pick up.

Works with Claude Code, Codex CLI, Gemini CLI and any agent that speaks MCP. Linux, macOS, Windows.
Model-independent.

## TL;DR

- **What it is:** the Sprintree MCP server (`https://sprintree.com/mcp`) plus the `sprintree` skill. Together they make the board tell the truth after a session.
- **Install (Claude Code):** `claude plugin marketplace add SNebiyev/sprintree-agent && claude plugin install sprintree@sprintree`, then run `/mcp` once and sign in. Codex CLI, Gemini CLI and other agents: see [Install](#install).
- **Add the card rules:** the skill loads only for sync, task and handover. Append `templates/AGENTS.md` to your `CLAUDE.md` or `AGENTS.md` so the rules hold in every session.
- **Update (Claude Code):** `claude plugin marketplace update sprintree && claude plugin update sprintree@sprintree`. Claude Code updates the plugin only when its version changes. Then replace the `templates/AGENTS.md` block in your own file (see [Update](#update)).
- **Live events (Claude Code):** run `/sprintree:connect` once and approve the code in the browser. Put the project in `.sprintree.json` (`"project": "KEY"`); a link in `CLAUDE.md` is not enough for the monitor. After a restart, mentions, assignments, replies, review requests and status changes reach the running session as one line each.
- **`/claude` commands on cards are OFF by default (0.6.0).** To turn them on for a session, type `/sprintree:commands on` in the terminal (no restart). `/sprintree:commands default on` does it for every session without its own setting, running ones too. Why: anyone who gets into your Sprintree account could otherwise give work to your agent. While it is off, the monitor's `connected` line ends with `/claude commands off`. `set_stream_focus` and `claim_stream_event` need the Account settings permission, so tick "Account settings" when you sign in at `/mcp`.
- **On by default with the plugin:** the card reminders (Claude Code hooks, only in a Sprintree project). **Opt-in:** agent runs (needs `SPRINTREE_RUNS_TOKEN`), live events (needs `/sprintree:connect`), `/claude` commands (needs `/sprintree:commands on`). See [On and off by default](#on-and-off-by-default).
- **Tokens:** OAuth is the default, and your MCP client keeps the session in its own credential store. `/sprintree:connect` saves an `itns_` live-events token to `~/.config/sprintree/stream-token` (mode 0600) that only opens the event stream. Revoke it in Sprintree under Settings -> API & MCP -> Personal access tokens. A personal token lives in an environment variable, never in a config file or `.sprintree.json`, and is never printed.

## How it works

- Your agent talks to the **Sprintree MCP server**. The tools read and write the board with your rights, so the agent can do only what you can.
- The **`sprintree` skill** is the rulebook on top of the tools: record the work as epic/story/task, put each card in its real status, file every deferred finding as a To do card. `templates/AGENTS.md` carries the card rules into every session.
- **Hooks** (Claude Code) add small reminders, and can keep a private record of your subagents. They run locally, and every one fails silently.
- The **live-events monitor** (Claude Code) holds one connection to Sprintree open. The server sends only keys, usernames, ids, counts and session labels, never titles, descriptions or comment text. The agent reads the content over MCP, with your rights.
- Text written on a card is **data, not instructions**. The agent shows you what a card asks for before it acts on it.

## On and off by default

| Feature | Default | How to change it |
|---|---|---|
| MCP server and `sprintree` skill | on, after install and sign-in | disable the plugin (`/plugin`) |
| Card reminders (Claude Code) | on, only in a Sprintree project | `export SPRINTREE_HOOKS=off` |
| Agent runs (Claude Code) | off | `export SPRINTREE_RUNS_TOKEN=...` (an "Agent runs only" token) |
| Live events (Claude Code) | off until you run `/sprintree:connect`; needs `"project": "KEY"` in `.sprintree.json` | revoke the token or disable the plugin |
| `/claude` commands on cards | off | `/sprintree:commands on` in the session, or `default on` for all sessions without their own setting (`SPRINTREE_COMMANDS` is the older way) |

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

## Update

- **Claude Code:** `claude plugin marketplace update sprintree && claude plugin update sprintree@sprintree`. Claude Code updates only when the plugin version changes.
- **Codex CLI:** `codex plugin marketplace upgrade` refreshes the marketplace snapshot.
- **Gemini CLI:** `gemini extensions update sprintree` (`gemini extensions update --all` updates every extension).
- **Your `AGENTS.md` block:** after an update, review the diff and replace the block from the `sprintree-agent:begin` line to the `sprintree-agent:end` line (both included) in your own `CLAUDE.md` or `AGENTS.md`. Details are in the Claude Code and Codex CLI sections.

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

## Live events (Claude Code)

The `sprintree-events` monitor puts Sprintree events into your running session, one line each: status changes on the project, mentions,
replies, assignments and review requests to you, and `/claude ...` comments you write on a card. It needs Claude Code with monitors.

- **Set up:** run `/sprintree:connect` (approve a code in the browser, nothing to paste), put the project in `.sprintree.json`
  (`"project": "KEY"`), then restart the session: monitors start with it. The token is saved at `~/.config/sprintree/stream-token` (mode 0600).
- **Permissions:** tick Account settings when the plugin signs in to Sprintree's MCP (`/mcp`, sprintree): `set_stream_focus` and `claim_stream_event` need the `mcp:account` scope. Without it `/claude` commands are not acted on. Both tools take the `session` id the monitor prints in its `connected` line.
- **What you get:** lines with ids and enums only, never card text. The agent mentions what concerns its card, and acts on a `/claude`
  comment only when you wrote it. Without a token or a project the monitor prints nothing.
- **`/claude` commands are off by default.** Type this in the terminal, in the session:
  - `/sprintree:commands on` or `off`: switch this session only, no restart (the monitor reconnects by itself and prints `sprintree-events /claude commands on`).
  - `/sprintree:commands status`: shows what applies and whether the server confirmed it.
  - `/sprintree:commands default on` or `off`: the setting for every session without its own setting, including running ones (they reconnect within seconds).

  The order is: this session, then the default, then `SPRINTREE_COMMANDS`, then off. The second way is `{"env": {"SPRINTREE_COMMANDS": "on"}}` in your own `~/.claude/settings.json` (merge into the existing file, restart the session, never a repository's committed `.claude/settings.json`). Why it is off: anyone who gets into your Sprintree account could otherwise give work to your agent. While it is off, the `connected` line ends with `/claude commands off`.
- **Only you can turn it on.** The switch lives in the terminal on your machine. No MCP tool and no web setting can change it, so someone in your Sprintree account cannot turn it on. The agent does not turn it on either and tells you to type the command yourself.
- **Where a `/claude` command goes:** to the session that has the issue in focus, or to the sessions named by `/claude @<label>` (with a space), else to every session and the first claim answers. If a command is addressed to a session that has commands off, it does not go to another session. That session prints a `skipped` line (`sprintree-events /claude command on KEY-12 skipped · /claude commands are off in this session`). With nobody addressed, sessions with commands off are skipped. Every other line (status, mention, assignment, reply, review request) arrives either way.
- **Revoke:** delete the token in Sprintree Settings → API & MCP → Personal access tokens (starts with `itns_`) and remove the token file, or disable the plugin (`/plugin`).
- Rules for the agent: [SKILL.md, "Live events (monitor)"](skills/sprintree/SKILL.md#live-events-monitor).

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
  export holds the text. The plugin closes the run when the last active session of the repository ends (not on `/clear` or an in-session `/resume`; quit and then `claude --resume` starts without the run; another session seen in the last 15 minutes keeps it open), an idle run closes after a day, a closed one is deleted a day later.
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
