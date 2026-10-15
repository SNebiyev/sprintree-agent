---
description: Connect live Sprintree events to Claude Code (approve a code in the browser, no token to paste)
allowed-tools: Bash(node:*)
---

Run the connect script and show its output to the user. It prints a link and a code, opens the browser, waits for the approval (up to about 9.5 minutes) and saves a live-events token on this machine. Run it in the foreground with a Bash timeout of 600000 ms.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/sprintree/scripts/connect.mjs"
```

Tell the user to check that the page shows the same code, then approve. When it ends with "Connected", tell them to restart this Claude Code session: monitors start with the session. Never ask for, print or look for the token. If the script fails, show its one-line message and stop.
