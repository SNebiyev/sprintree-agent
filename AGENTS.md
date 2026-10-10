# Sprintree - agent instructions (generic, any MCP-capable agent)

Copy this file into your repo's `AGENTS.md` (or paste it into your agent's custom instructions),
set the project key below, and connect the Sprintree MCP server (see README.md).

Project board: https://sprintree.com/p/KEY   <!-- replace KEY with your project key -->

## When to use Sprintree

When the user asks to sync, update or record work on the board, to hand over, or to take the next
task, follow the full workflow in `skills/sprintree/SKILL.md` if it is installed. The short version:

1. **Sync (default)**: record what this session did, move statuses to match reality, and file every
   deferred finding as a To do card. Never take a new card in sync mode.
2. **Task (only when asked)**: sync first, then pick the highest-priority unblocked To do card that
   nobody else is working on, claim it with a comment and start.

## Rules

- Nothing goes on the board that you did not see or verify. When in doubt use the lower status and
  say what is missing.
- Search before every create. Never duplicate a card. Pass an `idempotency_key` on `create_issue`.
- Hierarchy: epic > story > task. A task can only live under a story.
- Status by category: done = verified and shipped, review = verified but waiting on someone,
  in_progress = being worked, todo = not started or deferred. Read the project's real keys with
  `list_statuses`.
- Evidence goes in a comment first, then the status changes.
- Cards are written for a reader with no context: Context, Findings/evidence, What was done or
  What to do, How to verify, Sources. No secrets or personal data.
- `update_description` needs an integer `base_rev` from `get_issue_details`.
- Card language and typography: follow this repo's conventions (or `.sprintree.json`).

## No MCP connection?

`node skills/sprintree/scripts/st.mjs tools | schema <tool> | call <tool> '<json>' | key | config`
(Node >= 18, any OS, token in `SPRINTREE_TOKEN`).
