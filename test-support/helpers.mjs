// Shared test helpers. Lives outside test/ on purpose: `node --test` runs every file inside a test directory, and this one defines no tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const made = [];

/** A new temp directory, removed again when the test process exits (MIN_NODE has no `node:test` `after`). */
export function tmpDir(prefix = "sa-") {
  if (!made.length) process.on("exit", () => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(d);
  return d;
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

const BODY = "Ab1-_".repeat(6);
/**
 * Token shapes, run against the redaction of st.mjs and against the gitleaks rule (.gitleaks.toml), which must agree:
 * [name, text, the token the rule reports in the decoded text (null: not a token), the text after st.mjs redacted it].
 */
export const TOKEN_CASES = [
  ["PAT", `leak itn_${BODY} end`, `itn_${BODY}`, "leak [token] end"],
  ["OAuth access token", `leak itna_${BODY} end`, `itna_${BODY}`, "leak [token] end"],
  ["OAuth refresh token", `leak itnr_${BODY} end`, `itnr_${BODY}`, "leak [token] end"],
  ["at the start of the text", `itn_${BODY}`, `itn_${BODY}`, "[token]"],
  ["after = and before ;", `token=itn_${BODY};`, `itn_${BODY}`, "token=[token];"],
  ["after an underscore", `SPRINTREE_TOKEN_itn_${BODY}`, `itn_${BODY}`, "SPRINTREE_TOKEN_[token]"],
  ["between underscores", `_itn_${BODY}_`, `itn_${BODY}_`, "_[token]"],
  ["glued to a word", `keyitn_${BODY}`, null, `keyitn_${BODY}`],
  ["glued to a digit", `9itna_${BODY}`, null, `9itna_${BODY}`],
  ["another prefix", `itnx_${BODY}`, null, `itnx_${BODY}`],
  ["too short", "itn_short", null, "itn_short"],
  ["19 characters are too few", `itn_${"a".repeat(19)}`, null, `itn_${"a".repeat(19)}`],
  ["20 characters are enough", `itn_${"a".repeat(20)}`, `itn_${"a".repeat(20)}`, "[token]"],
  ["authorization code", `itnac_${BODY}`, null, `itnac_${BODY}`],
  ["upper case", `ITN_${BODY}`, null, `ITN_${BODY}`],
  ["percent-encoded space before it", `Bearer%20itna_${BODY}`, `itna_${BODY}`, "Bearer%20[token]"],
  ["percent-encoded = before it", `x%3Fa%3Ditnr_${BODY}`, `itnr_${BODY}`, "x%3Fa%3D[token]"],
  ["percent-encoded underscore", `itn%5F${BODY}`, `itn_${BODY}`, "[token]"],
  ["percent-encoded, lower-case hex", `itn%5f${BODY}`, `itn_${BODY}`, "[token]"],
  ["encoded twice", `itn%255F${BODY}`, `itn_${BODY}`, "[token]"],
  ["\\u escape", `itna\\u005f${BODY}`, `itna_${BODY}`, "[token]"],
  ["\\\\u escape (escaped backslash)", `itna\\\\u005f${BODY}`, `itna_${BODY}`, "[token]"],
  ["\\U escape, upper-case hex", `itna\\U005F${BODY}`, `itna_${BODY}`, "[token]"],
  ["escape inside the body", `itn_${BODY.slice(0, 10)}\\u002d${BODY.slice(10)}`, `itn_${BODY.slice(0, 10)}-${BODY.slice(10)}`, "[token]"],
  ["a non-ASCII escape is no token character", `itn%C3%A9_${BODY}`, null, `itn%C3%A9_${BODY}`],
];

/** What gitleaks sees of `text`: %XX and \uXXXX escapes decoded, again and again up to its default depth of 5. */
export function decodeEscapes(text) {
  let t = text;
  for (let i = 0; i < 5; i++) {
    const next = t.replace(/%([0-9a-fA-F]{2})|\\{1,2}[uU]([0-9a-fA-F]{4})/g, (m, a, b) => String.fromCharCode(parseInt(a ?? b, 16)));
    if (next === t) break;
    t = next;
  }
  return t;
}
