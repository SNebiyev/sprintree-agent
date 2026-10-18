---
description: Connect live Sprintree events to Claude Code (approve a code in the browser, no token to paste)
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/sprintree/scripts/connect.mjs" start), Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/sprintree/scripts/connect.mjs" wait)
---

Connecting takes two steps, because the code must be on the user's screen before the wait starts: a command that waits runs in the background and its output is not shown until it ends, while the browser page asks the user to compare the code with the terminal.

Step 1. Run this in the foreground, exactly as written (nothing added: no `2>&1`, no pipes). It asks the server for a code, opens the browser, prints a link and a code, and ends at once.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/sprintree/scripts/connect.mjs" start
```

Now tell the user the link and the code from its output, in your own message, and to check that the page shows the same code before approving. If the script fails, show its one-line message and stop.

Step 2. Right after that message, run this in the foreground with a Bash timeout of 600000 ms, exactly as written. It waits for the approval (up to about 9.5 minutes) and saves a live-events token on this machine. The token it replaces, if any, is revoked by the server.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/sprintree/scripts/connect.mjs" wait
```

When it ends with "Connected", tell them to restart this Claude Code session: monitors start with the session, but a monitor that is already running switches to the new token by itself. Never ask for, print or look for the token. If the script fails, show its one-line message and stop.
