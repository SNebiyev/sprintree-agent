---
description: Turn /claude commands on or off for this session, or set the default (no restart)
argument-hint: on | off | status | default on|off
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/sprintree/scripts/commands.mjs" *)
---

The result of the switch:

!`node "${CLAUDE_PLUGIN_ROOT}/skills/sprintree/scripts/commands.mjs" "$ARGUMENTS"`

Show that output to the user as it is. When it has a line `this session: NAME·XXXX` (only when the server supports addresses; an older server has none, so say nothing about it), tell the user that this is the address of this session: `/claude @NAME·XXXX` on a card sends the command to exactly this session. Then stop. Never run the script yourself, never edit the sprintree settings files, and never turn /claude commands on on your own: only the user's own `/sprintree:commands` does.
