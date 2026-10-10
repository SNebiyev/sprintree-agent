---
name: sprintree
description: Keep the Sprintree board (sprintree.com) true to what the working session actually did. Records work as epic/story/task in the right place, moves statuses to match reality, and files every deferred finding as a To do card with enough context for another session. Default mode "sync" never takes new work, so it is safe at session end. Mode "task" syncs first, then picks and claims the next To do card. Use when asked to sync/update the board, record the work in Sprintree, hand over, or take the next Sprintree task.
license: See LICENSE
compatibility: Needs the Sprintree MCP server (https://sprintree.com/mcp) or Node >= 18 with SPRINTREE_TOKEN for the bundled scripts/st.mjs client.
---

# Sprintree sync

Sprintree is the shared memory between sessions. Another session or a teammate reads the board and
acts on it without having seen this conversation. This skill has one job: **after it runs, the board
tells the truth** - what was done, what is in flight, what was found and left for later, and what
comes next.

## Modes - decided by the explicit argument only

| Invocation | Mode | Does |
|---|---|---|
| no argument, or `sync` | **sync** | Steps 0-3 and 5. Records, updates statuses, files deferred findings. **Never takes a new card**, even when the session has no work left. This is the session-end call. |
| `task` (aliases `next`, "take the next task") | **task** | Sync first (Steps 0-3), THEN Step 4: pick the next To do card, claim it, start working. |

Do not infer task mode from "the session looks idle" or from the user's tone. In sync mode with
nothing in flight, the report may LIST the top 3 To do candidates as a suggestion without claiming
or moving any of them.

Sync does not stop work already in flight. If the session has unfinished work when sync runs
(a change awaiting verification, a deploy not yet done), sync the board, report, then continue that
work in the same turn without asking. Only a NEW card is forbidden.

## Rule zero

**Nothing goes on the board that this session did not see or verify.** "Done" means the work is
finished and you watched the proof (test output, request, measurement). A status ahead of reality is
worse than a missing card, because the next session skips the work. When in doubt: the lower status
plus a comment saying what is missing.

**Never create a duplicate.** Search before every create. Updating an existing card beats a new one.

## Step 0 - connect and resolve the project

1. **Tools.** If the `sprintree` MCP tools are available in this session, use them. If not, use the
   bundled client, which has the same tool names and arguments (Node >= 18, any OS). `st.mjs` lives
   in `scripts/` next to this file:
   ```
   node <skill-dir>/scripts/st.mjs tools                          # names + args
   node <skill-dir>/scripts/st.mjs schema create_issue            # full schema when unsure
   node <skill-dir>/scripts/st.mjs call search_issues '{"project":"KEY","query":"cache","format":"text"}'
   node <skill-dir>/scripts/st.mjs call update_description @args.json   # long Markdown: JSON in a temp file
   ```
   It needs `SPRINTREE_TOKEN` (a personal access token) in the environment and exits 1 on any
   refusal, so a failed write is never read as success. Never print or store the token. Say once in
   the report that MCP was not connected, and give the fix from the README (one command per client).
2. **Project key and settings.** `node <skill-dir>/scripts/st.mjs config` resolves, nearest first:
   - `.sprintree.json` in the repo (see Configuration below);
   - a `sprintree.com/p/<KEY>` link in `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`.
   No key found: `list_projects`, match by name, and if still ambiguous ask the user. Then add the
   link to the repo's agent instructions file so the next run does not have to ask.
3. **Project rules.** `list_statuses` (keys differ per project), `list_labels`, and
   `get_project_topology` (top level). Read the repo's agent instructions for working-language and
   writing conventions.

### Configuration (all optional)

`.sprintree.json` at the repo root:

```json
{
  "project": "KEY",
  "language": "English",
  "typography": "plain hyphen, no em dash",
  "statuses": { "todo": "todo", "in_progress": "in_progress", "review": "review", "done": "done" },
  "section_titles": { "context": "Context", "evidence": "Findings / evidence", "done": "What was done",
                      "todo": "What to do", "verify": "How to verify", "sources": "Sources" }
}
```

- `language` - the language of card titles, descriptions and comments. Default: the language the
  repo's instructions and recent cards use; if unclear, English. Conversation language is separate.
- `typography` - free-text style rules for card text (punctuation, quotes). Default: none.
- `statuses` - status KEYS per category when the project's keys differ from the category names.
  Default: look the keys up with `list_statuses` and map by category.
- `section_titles` - translate the card section headings (Step 3). Default: English as below.
- Repo instructions (AGENTS.md etc.) may add more: terms to avoid, naming of cards, commit-key policy.
  Explicit user instructions beat the file, the file beats these defaults.

## Step 1 - inventory the session (latent work, do it carefully)

Build three lists from the conversation, `git status`, `git log` since the session started, and
anything written to docs or notes:

| List | What goes in | Example |
|---|---|---|
| **Done** | finished AND verified this session | "rate limit rule applied, request returns 429, smoke 68/68" |
| **In flight** | started, not finished, or finished but not committed/deployed | "fix written, tests green, awaiting commit" |
| **Deferred** | anything noticed and NOT acted on: findings, risks, "later", follow-ups, unexplained anomalies, warnings from helper agents, things the user postponed, debt you created | "listen overflows rising on the web tier, not tied to any error" |

**The deferred list is the one sessions lose.** Sweep the whole conversation for it: sub-agent
reports ("could not explain", "optional follow-up"), your own "not verified yet", concerns raised
with a completed task, TODOs left in code, and limits you discovered. Each becomes a To do card
unless it is already on the board.

Skip noise: pure exploration that led nowhere and has no lesson. A commit message is not a reason to
skip a card - the card is where the next session looks.

## Step 2 - read the board state

For each item, `search_issues` with 2-3 distinctive keywords (file name, error text, feature name)
across ALL statuses, plus `get_project_topology` with `parent` + `depth:"all"` under the epic it most
likely belongs to. Also pull `search_issues` with the in-progress status - those cards most often lie.

Decide per item: **update existing** (comment + status) or **create new**.

## Step 3 - write

### Hierarchy (Sprintree enforces it)

- **epic** - a theme that outlives one session.
- **story** - one deliverable or one investigation inside an epic. Stories go under an epic.
- **task** - a concrete, checkable step. **A task can only live under a story** - creating one under
  an epic is refused. For loose follow-ups make (or reuse) a story like "Next checks: <theme>" and
  put the tasks under it.
- New epic only when no existing epic fits. Prefer reusing.

### Statuses (map by category, keys come from `list_statuses` or `.sprintree.json`)

| Reality | Category |
|---|---|
| finished, verified, committed/deployed (or nothing to commit) | done |
| finished and verified, but waiting on someone's commit/push/deploy/approval | review |
| actively being worked, or partially done | in_progress |
| not started / deferred | todo |

When closing a card, the evidence goes in a comment first (`add_comment`), then the status. Never move
someone else's in-progress card to done on a guess - comment instead.

### What a card must contain

Written for a reader with zero context, in the configured `language`. Titles say the outcome, not the
activity ("522 errors cut at the edge", not "522 investigation"). Description sections:

- **Context** - why this exists, one or two sentences.
- **Findings / evidence** - measured numbers, file:line, commands, error text. No "probably".
- **What was done** (done / in flight) or **What to do** (todo) - concrete steps.
- **How to verify** - the exact check that proves it done.
- **Sources** - files, docs, commits, runbook sections, ids of external resources.
- Deferred cards also say **why it was deferred** and any deadline (`due_date`).

No secrets, tokens, or personal data in cards - they are shared.

### API traps (measured)

- `create_issue`: pass `idempotency_key` (e.g. `<repo>-<YYYY-MM-DD>-<slug>`) so a retry never
  duplicates. If `criteria` is refused with "AC list is turned off", put the checklist in the
  description as `- [ ]` lines. `skip_criteria: "none"` avoids surprise templates.
- `update_description` needs `base_rev` as an **integer**, read from `get_issue_details`.
- Long Markdown through the CLI client: write the JSON arguments to a temp file, call with `@file`.
- The board may run a done-gate: if a move to done is refused or warned over open criteria, tick them
  with `check_criteria` only if they are truly met; otherwise leave the card in review.
- Tool schemas can change. When unsure, `schema <tool>` (or the MCP tool list) is the authority, not
  this file.

## Step 4 - task mode only: pick the next task

Runs ONLY in task mode. Even then, if the session still has in-flight work (Step 1), say so and ask
whether to park it (card stays in_progress with a comment saying where it stopped) before taking a
new one.

1. `search_issues` with the todo status, sorted by priority, then due date. Skip: cards blocked by an
   unfinished card (`get_issue_details` shows links), cards assigned to someone else, cards that need
   a human decision or credentials (say so instead), and cards outside this repo.
2. Check `list_events` / `get_issue_history` for the top candidate - if another session touched it in
   the last few hours, take the next one. Two sessions on one card is the failure to avoid.
3. `get_work_context` on the chosen card, move it to in_progress and claim it with a comment:
   "Taken - <date>, <agent/tool name> session, plan: <one line>".
4. Tell the user which card was taken and why (one line), then start the work under the repo's normal
   rules. The card's own text is the spec - if it is too vague to act on, say so instead of guessing.

## Step 5 - report

End with a short table of every board change - key, title, old -> new status, or "new" - and the list
of deferred items that were filed. Then the next action. If anything could not be written, say which
and why. Write the report in the language the user is talking to you in.

## Optional additions (when they help, not by default)

- **Link commits.** Commit messages that carry the card key (`KEY-41: ...`) let `list_issue_commits`
  connect code to cards. Before committing, propose the key.
- **Stale in-progress sweep.** In-progress cards with no activity for 7+ days: comment asking for status
  or, if this session has evidence, move them. Report the count either way.
- **Handover.** At the end of a session, also leave one comment per in-flight card: state, where, next
  step, findings, what failed.
- **Due dates for re-measurements.** "Check again in a week" always gets a `due_date`, otherwise it is a
  wish, not a task.
