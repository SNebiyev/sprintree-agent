// Parses every JSON manifest in the repo; exits 1 on the first syntax error.
import { readFileSync } from "node:fs";
const files = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".mcp.json",
  "gemini-extension.json",
  ".sprintree.example.json",
];
let bad = 0;
for (const f of files) {
  try {
    JSON.parse(readFileSync(f, "utf8"));
    console.log(`ok   ${f}`);
  } catch (e) {
    bad++;
    console.error(`FAIL ${f}: ${e.message}`);
  }
}
process.exit(bad ? 1 : 0);
