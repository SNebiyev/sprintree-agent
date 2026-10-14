// Shared test helpers. Lives outside test/ on purpose: `node --test` runs every file inside a test directory, and this one defines no tests.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const made = [];

/** A new temp directory (its real path: /tmp may be a link, a Windows temp path may be an 8.3 name), removed again when the test process exits (MIN_NODE has no `node:test` `after`). */
export function tmpDir(prefix = "sa-") {
  if (!made.length) process.on("exit", () => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const d = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
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

/** A 30-character token body (every body character class). */
export const BODY = "Ab1-_".repeat(6);
/**
 * Token shapes, run against the redaction of st.mjs and against the gitleaks rule (.gitleaks.toml). st.mjs hides a superset of what gitleaks flags:
 * [name, text, the token the gitleaks rule reports in the decoded text (null: it reports nothing), the text after st.mjs redacted it].
 * Wherever the rule reports a token st.mjs redacts it; a token glued to a word is hidden by st.mjs only (the rule skips it).
 */
export const TOKEN_CASES = [
  ["PAT", `leak itn_${BODY} end`, `itn_${BODY}`, "leak [token] end"],
  ["OAuth access token", `leak itna_${BODY} end`, `itna_${BODY}`, "leak [token] end"],
  ["OAuth refresh token", `leak itnr_${BODY} end`, `itnr_${BODY}`, "leak [token] end"],
  ["agent-runs token", `leak itnh_${BODY} end`, `itnh_${BODY}`, "leak [token] end"],
  ["at the start of the text", `itn_${BODY}`, `itn_${BODY}`, "[token]"],
  ["after = and before ;", `token=itn_${BODY};`, `itn_${BODY}`, "token=[token];"],
  ["after an underscore", `SPRINTREE_TOKEN_itn_${BODY}`, `itn_${BODY}`, "SPRINTREE_TOKEN_[token]"],
  ["between underscores", `_itn_${BODY}_`, `itn_${BODY}_`, "_[token]"],
  ["a letter, a kept joiner, then the token (the joiner ends the word)", `a\u200ditn_${BODY}`, `itn_${BODY}`, "a\u200d[token]"],
  ["a digit, a kept LRM, then the token", `9\u200eitna_${BODY}`, `itna_${BODY}`, "9\u200e[token]"],
  ["a letter, a zero-width space (removed), then the token", `a\u200bitn_${BODY}`, `itn_${BODY}`, "a[token]"],
  ["a letter, a C0 control (removed), then the token", `a\u0001itn_${BODY}`, `itn_${BODY}`, "a[token]"],
  ["a letter, a soft hyphen (removed), then the token", `a\u00aditn_${BODY}`, `itn_${BODY}`, "a[token]"],
  ["a letter, a C1 control (removed), then the token", `a\u0085itn_${BODY}`, `itn_${BODY}`, "a[token]"],
  ["a letter, a tag character (removed), then the token", `a\u{e0041}itn_${BODY}`, `itn_${BODY}`, "a[token]"],
  ["glued to a word (st.mjs only: gitleaks skips it)", `keyitn_${BODY}`, null, "key[token]"],
  ["glued to a digit (st.mjs only)", `9itna_${BODY}`, null, "9[token]"],
  ["glued to a single letter (st.mjs only)", `aitn_${BODY}`, null, "a[token]"],
  ["glued to a word, then an escaped underscore (st.mjs only)", `keyitnr%5F${BODY}`, null, "key[token]"],
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
  ["encoded 5 times (the decoding depth)", `itn%252525255F${BODY}`, `itn_${BODY}`, "[token]"],
  ["encoded 6 times is one level too deep", `itn%25252525255F${BODY}`, null, `itn%25252525255F${BODY}`],
  ["\\u escape", `itna\\u005f${BODY}`, `itna_${BODY}`, "[token]"],
  ["\\\\u escape (escaped backslash)", `itna\\\\u005f${BODY}`, `itna_${BODY}`, "[token]"],
  ["\\U escape, upper-case hex", `itna\\U005F${BODY}`, `itna_${BODY}`, "[token]"],
  ["escape inside the body", `itn_${BODY.slice(0, 10)}\\u002d${BODY.slice(10)}`, `itn_${BODY.slice(0, 10)}-${BODY.slice(10)}`, "[token]"],
  ["a non-ASCII escape is no token character", `itn%C3%A9_${BODY}`, null, `itn%C3%A9_${BODY}`],
  ["a non-ASCII letter before it ends the word", `\u{e9}itn_${BODY}`, `itn_${BODY}`, "\u{e9}[token]"],
  ["a CJK character before it", `\u{4e2d}itn_${BODY}`, `itn_${BODY}`, "\u{4e2d}[token]"],
  ["a \\u escape of a non-ASCII letter before it", `x\\u00e9itn_${BODY}`, `itn_${BODY}`, `x\\u00e9[token]`],
  ["a quote written as \\u201c before it", `x\\u201citn_${BODY}`, `itn_${BODY}`, `x\\u201c[token]`],
  ["a \\u escape decodes any code unit, U+0000 too", `x\\u0000itn_${BODY}`, `itn_${BODY}`, `x\\u0000[token]`],
  ["one byte of a multi-byte character is not decoded: glued to a digit or letter, st.mjs hides it, gitleaks does not", `x%C3itn_${BODY}`, null, "x%C3[token]"],
  ["a byte above DEL is not decoded: glued to a digit or letter, st.mjs hides it, gitleaks does not", `x%C1itn_${BODY}`, null, "x%C1[token]"],
  ["the controls U+0000-0008 are not decoded: glued to a digit or letter, st.mjs hides it, gitleaks does not", `x%01itn_${BODY}`, null, "x%01[token]"],
  ["DEL is not decoded: glued to a digit or letter, st.mjs hides it, gitleaks does not", `x%7Fitn_${BODY}`, null, "x%7F[token]"],
  ["a decoded escape earlier in the text does not shift a later one", `x %41 %69tn_${BODY} y`, `itn_${BODY}`, "x %41 [token] y"],
  ["a tab is decoded", `x%09itn_${BODY}`, `itn_${BODY}`, `x%09[token]`],
  ["~ is decoded", `x%7Eitn_${BODY}`, `itn_${BODY}`, `x%7E[token]`],
];

/**
 * What gitleaks sees of `text` (v8.30.1, measured on every `%XX` and every `\uXXXX`): `%XX` decoded for the ASCII characters from tab to `~`
 * (not U+0000-0008, not DEL, not a byte of a multi-byte character), `\uXXXX` and `\\uXXXX` (also with a capital U) for any code unit, again and
 * again up to its default depth of 5. (Where gitleaks gives up on a whole line because one of its `%XX` is not decodable, this model and st.mjs decode
 * the others: st.mjs is stricter there, see the test "stricter than gitleaks".)
 */
export function decodeEscapes(text) {
  let t = text;
  for (let i = 0; i < 5; i++) {
    const next = t.replace(/%(0[9a-fA-F]|[1-6][0-9a-fA-F]|7[0-9a-eA-E])|\\{1,2}[uU]([0-9a-fA-F]{4})/g, (m, a, b) => String.fromCharCode(parseInt(a ?? b, 16)));
    if (next === t) break;
    t = next;
  }
  return t;
}
