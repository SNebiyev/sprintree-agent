# Sprintree

This extension connects the Sprintree MCP server (`sprintree`) and ships the `sprintree` skill
(`skills/sprintree/SKILL.md`). When the user asks to sync, update or record work on the Sprintree
board, to hand over, or to take the next Sprintree task, follow that skill. Never create a card
without searching for a duplicate first, and never mark work done that you did not verify.

If the `sprintree` MCP tools are not available, use `node skills/sprintree/scripts/st.mjs` (needs the
`SPRINTREE_TOKEN` environment variable).
