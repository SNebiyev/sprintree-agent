// Shared test helpers. Lives outside test/ on purpose: `node --test` runs every file inside a test directory, and this one defines no tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Temp directories that one `cleanup()` (call it from `after`) removes again. */
export function tmpDirs() {
  const made = [];
  return {
    make(prefix = "sa-") {
      const d = mkdtempSync(path.join(tmpdir(), prefix));
      made.push(d);
      return d;
    },
    cleanup() {
      made.forEach((d) => rmSync(d, { recursive: true, force: true }));
    },
  };
}

/** A JSON-RPC success answer to request `b`. */
export const reply = (b, result) => ({ json: { jsonrpc: "2.0", id: b.id, result } });

/**
 * A mock `fetch`. `handler(body)` returns { json | text | sse, status }. Records every call in `fn.calls`.
 */
export function mockFetch(handler, { session = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, headers: init.headers, body });
    const r = handler(body);
    const text = r.sse ? `event: message\ndata: ${JSON.stringify(r.json)}\n\n` : r.text ?? JSON.stringify(r.json ?? {});
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status ?? 200,
      headers: new Map(session ? [["mcp-session-id", "sess-1"]] : []),
      text: async () => text,
    };
  };
  fn.calls = calls;
  return fn;
}

/** A child-process environment: the real one (Windows needs SystemRoot and friends) plus overrides. */
export const childEnv = (extra = {}) => ({ ...process.env, SPRINTREE_TOKEN: "", ...extra });
