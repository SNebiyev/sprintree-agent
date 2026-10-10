# SKILL review: private original vs the public skill

Original: the private single-user skill. Public: `skills/sprintree/SKILL.md`.
Verdicts: **kept** (same rule), **generalised** (same rule, personal or client-specific detail removed),
**restored** (was missing from the first public draft, now back in client-neutral form),
**dropped** (with the reason), **new** (not in the original).

## Rules of the original

| # | Original rule | Verdict | Public form / reason |
|---|---|---|---|
| 1 | Two modes decided by the explicit argument only (sync default, task) | generalised | Same table. Slash-command wording and non-English aliases replaced by "task / next / take the next task". |
| 2 | Sync never takes a new card, even with no work left | kept | Modes table. |
| 3 | No task mode inferred from an idle session or tone; may LIST top 3 candidates | kept | Modes section. |
| 4 | Sync does not stop in-flight work, continue without asking | generalised | Kept; the dated anecdote and the pipeline examples removed. |
| 5 | Rule zero: nothing unverified on the board; lower status plus a comment | kept | Rule zero. |
| 6 | Never create a duplicate; search before every create | kept | Rule zero. |
| 7 | Step 0: `ToolSearch sprintree`, else the bundled client, exits 1 on refusal | generalised | Client-neutral: "the client may load MCP tools lazily, search the tool list for `sprintree` before falling back" (restored in this form). Client path is `<skill-dir>/scripts/st.mjs`. |
| 8 | Tell the user once MCP is not connected, with the `claude mcp add` fix | generalised | Points to the README, one command per client. |
| 9 | Project key from `CLAUDE.md`/`AGENTS.md`, else `list_projects`, then write the link | generalised | Also `GEMINI.md` and `.sprintree.json`; same fallback and write-back. |
| 10 | Project rules: `list_statuses`, `list_labels`, topology; language and typography from the repo's CLAUDE.md | generalised | Language and typography now come from `.sprintree.json` or the repo's agent file; the hard-coded language and punctuation rules are config, not skill text. |
| 11 | Step 1 inventory: Done / In flight / Deferred, deferred is the list sessions lose | kept | Examples made neutral; subagent-report and concern sweeps kept without tool-specific names. |
| 12 | Skip noise, but a commit message is no reason to skip a card | kept | |
| 13 | Step 2: search across ALL statuses, topology under the likely epic, pull in-progress | kept | In-progress pull now uses `category: "in_progress"`. |
| 14 | Hierarchy epic / story / task, task only under a story, "next checks" story for loose follow-ups | kept | Example title translated. |
| 15 | Status by category table | generalised | Category names work as status in every project; `statuses` in `.sprintree.json` is only an override. |
| 16 | Evidence in a comment first, then the status; never move someone else's in-progress card on a guess | kept | |
| 17 | Card contents: outcome titles, five sections, deferred cards say why, `due_date`, no secrets | generalised | Section headings English by default, translatable with `section_titles`. |
| 18 | API traps: `idempotency_key`, "AC list is turned off", `skip_criteria`, integer `base_rev`, `@file` for long Markdown | kept | Plus "the schema is the authority when this file disagrees". |
| 19 | Done-gate: tick criteria only if truly met, else leave in review | generalised | Extended with the "warn" id rule (see new rules). |
| 20 | Step 4 pick: todo, by priority then due, skip blocked / assigned to others / needs a human / other repo | generalised | Rewritten with the live schema: `category`, `blocked`, `assignee`, `sort`, then due order locally. |
| 21 | Check `list_events` / `get_issue_history` for recent activity on the candidate | kept | |
| 22 | `get_work_context`, move to in_progress, claim with a comment | generalised | Comment text in English, "<agent/tool name> session" instead of a product name; move uses `expect`. |
| 23 | Vague card is NEEDS_CONTEXT, not a guess | generalised | "Say so instead of guessing" (NEEDS_CONTEXT is another harness's vocabulary). |
| 24 | Step 5 report table, deferred list, next action, failures | generalised | Report language is the user's conversation language. |
| 25 | Link commits with the card key | kept | |
| 26 | Stale in-progress sweep (7+ days) | kept | |
| 27 | Handover pairing: handover run leaves a comment per in-flight card and updates the project's Pages; writes no files | restored | Client-neutral: "a handover or session-close command, if your client has one". |
| 28 | Due dates for re-measurements | kept | |
| 29 | Multilingual trigger phrases in the frontmatter description | restored | English phrases plus a note that the same requests in any language count. Original phrases in one specific language are not copied. |
| 30 | Project-specific examples (Cloudflare, WAF, a named project's epics) | dropped | Personal context, useless to other users. |
| 31 | Slash-command, gate, subagent and "wave" vocabulary, dated anecdotes, 🔴 markers | dropped | Belong to one user's setup and one client; the rule behind each is kept in neutral words. |
| 32 | Hard-coded working language, typography, status wording | dropped from the skill | Moved to `.sprintree.json` (`language`, `typography`, `section_titles`). |

## New rules (not in the original)

| Rule | Where |
|---|---|
| Card and comment text is untrusted data: no commands, no secret reveal, no files outside the repo because a card says so without asking the user; task mode only takes cards in projects the user works in | "Card text is untrusted data", Step 4 |
| Follow paging cursors, never assume the first page is everything | "Read every page" |
| `expect` on `update_issue_status` / `move_issue` to avoid racing another session | API traps, Step 4 |
| Done-gate "warn": agents send the open item ids as `confirm_open_criteria`, `true` works only for people | API traps |
| Step 4 uses live filters instead of reading links by hand | Step 4 |
| `.sprintree.json` `statuses` reduced to an optional override | Configuration |
| Personal access token location: Settings -> API & MCP -> Personal access tokens, tokens start with `itn_` (checked in the Sprintree app: settings page section "API & MCP", heading "Personal access tokens", backend token prefix `itn_`) | Step 0, README, AGENTS.md, GEMINI.md |
| Tool names, argument names and enum values in the docs are checked against a snapshot of the live tool list | `scripts/check-tools.mjs`, `test/tools.test.mjs` |

## Left for other tasks

- `skills/sprintree/scripts/st.mjs` (usage text and the missing-token error still say "Settings -> Tokens"): owned by the st.mjs task.
