#!/usr/bin/env node
/**
 * Sprintree MCP over plain JSON-RPC (Streamable HTTP). Pure Node >= 18.7.0, no shell utilities,
 * works on Linux, macOS and Windows. Use it when the agent has no `sprintree` MCP server connected.
 *
 *   node st.mjs tools                      # tool names + argument names
 *   node st.mjs schema <tool>              # one tool's description and input schema
 *   node st.mjs call <tool> '<json-args>'  # call a tool, print its text result
 *   node st.mjs call <tool> @<abs path>    # same, arguments read from a JSON file (the only way to pass text you did not write)
 *   node st.mjs version                    # print the version of this script
 *   node st.mjs key [dir]                  # resolve the project key for a repo (default: cwd)
 *   node st.mjs config [dir]               # print the resolved project config (only the known keys)
 *
 * Auth: set SPRINTREE_TOKEN to a personal access token (itn_..., Settings -> API & MCP -> Personal access tokens).
 * "Bearer " is added when missing. The token is never printed. It must be made of letters, digits, _ and - (a real token is);
 * anything else is refused at load. SPRINTREE_MCP_URL overrides
 * the endpoint (default https://sprintree.com/mcp; must be https unless the host is
 * localhost, 127.0.0.1 or ::1; redirects are refused). SPRINTREE_TIMEOUT_MS sets the per-request
 * timeout (a whole number of ms from 1 to 600000, default 30000). An answer over 8 MiB is refused while it is read.
 *
 * Text from a card or a comment is never typed into the shell: write it with the agent's own file-writing tool
 * into a fresh temp directory outside the repo, pass `@<absolute path>`, delete it afterwards (SKILL.md, Step 0).
 *
 * `.sprintree.json` and the doc files (AGENTS.md, CLAUDE.md, .claude/CLAUDE.md, GEMINI.md) are read by one safe
 * reader, `readTextFile`. `config` prints only project, language, typography, statuses and section_titles (other
 * keys are named on stderr as ignored, their values are never printed); a key that looks like a token only warns,
 * it does not make the file safe to commit secrets in. Everything printed (server text, config, warnings, errors)
 * is stripped of terminal control sequences and invisible characters first (`stripControls`; what real text needs stays: one
 * ZWJ, ZWNJ, LRM or RLM between two visible characters (a combining mark belongs to the character before it), a variation selector after a base character, the three subdivision flags),
 * and Sprintree tokens (itn_, itnh_, itna_, itnr_, itns_, also percent-encoded or \u-escaped) are replaced by [token] wherever they stand, a token glued to a word
 * included (stricter than .gitleaks.toml, which skips one: hiding a superset costs nothing).
 *
 * OAuth: this fallback client is PAT-only on purpose. When an agent connects the Sprintree MCP
 * server with OAuth, that session (access/refresh tokens) lives in the agent's own keychain and
 * this script cannot reach it. No token means: use the connected MCP tools, or set a PAT.
 *
 * Windows: PowerShell 5.1 strips the inner double quotes of a native-command argument, so
 * inline JSON breaks there. Use `call <tool> @<absolute path>` (the documented Windows path).
 *
 * A refusal (HTTP error, JSON-RPC error, isError, or a text answer starting with "Error:")
 * exits 1, so a failed write is never read as success.
 */
import { existsSync, statSync, lstatSync, realpathSync, readlinkSync, readSync, openSync, fstatSync, closeSync, constants as FS_CONSTANTS } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One version source. A constant (not a read of ../../../package.json) so it keeps working when
// the skill folder is copied alone. A test (and scripts/check-version.mjs) keeps it equal to package.json.
export const VERSION = "0.12.0";
// The one minimum Node version: the runtime check, its message and package.json `engines.node` are built from
// or tested against it, and so is the CI matrix. A test fails when a doc states another one.
export const MIN_NODE = "18.7.0";
const DEFAULT_URL = "https://sprintree.com/mcp";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 600000;
const PROTOCOL_VERSION = "2025-06-18";
// realpathSync.native: on Windows it also expands 8.3 short names, so two spellings of one directory compare equal.
const REAL_FS = { existsSync, statSync, lstatSync, realpathSync: realpathSync.native, readlinkSync, readSync, openSync, fstatSync, closeSync, constants: FS_CONSTANTS };
const MAX_TEXT_BYTES = 1024 * 1024; // config and doc files are small; anything bigger is not one
// An answer is read into memory, cleaned (several copies and index arrays) and printed: 8 MiB is far more than a paged tool answer needs,
// and the cleaning of 8 MiB stays under a few hundred MiB. A bigger one is refused while it is read, not after.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
// The server's project key rule. Doc links and `.sprintree.json` are both checked against it.
const KEY_CHARS = "[A-Za-z][A-Za-z0-9]{0,9}";
export const KEY_RE = new RegExp(`sprintree\\.com/p/(${KEY_CHARS})\\b`, "g");
const PROJECT_RE = new RegExp(`^${KEY_CHARS}$`);
export const PLACEHOLDER_KEY = "KEY"; // the template link is https://sprintree.com/p/KEY
export const KNOWN_CONFIG_KEYS = ["project", "language", "typography", "statuses", "section_titles"];
const DOC_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", path.join(".claude", "CLAUDE.md")];
export const DOC_NAMES = DOC_FILES.map((f) => f.split(path.sep).join("/"));
const PAT_HINT = "tokens start with itn_; create one under Settings -> API & MCP -> Personal access tokens";

/** Decode a text file: strips a UTF-8 BOM, reads UTF-16LE (FF FE), refuses UTF-16BE (FE FF). */
function decodeText(b, label) {
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  if (b[0] === 0xfe && b[1] === 0xff) throw new Error(`${label}: UTF-16BE is not supported; save it as UTF-8`);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString("utf8");
  return b.toString("utf8");
}

/** True when the relative path `rel` (from `path.relative`) leaves its base: it goes up, or it is on another drive. */
const leaves = (p, rel) => rel === ".." || rel.startsWith(".." + p.sep) || p.isAbsolute(rel);
/** The uid of this process, or null where there is none (Windows). */
const currentUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/** The real path of `x` (links followed, on Windows 8.3 names expanded); a part that does not exist is kept as it is. */
function realOr(fs, x, p) {
  try {
    return fs.realpathSync(x);
  } catch {
    const up = p.dirname(x);
    return up === x ? x : p.join(realOr(fs, up, p), p.basename(x));
  }
}

/**
 * The directory holding .git at or above `dir` (the repo root), or null. The walk climbs the REAL path of `dir` (links
 * followed), so a start directory reached through a link or junction never climbs out of where it really is. Inside $HOME
 * it goes up to $HOME (the home directory itself is looked at). Outside $HOME a .git counts only when the current user
 * owns it (POSIX): a .git that is a symlink only when the link and its target are both owned by the current user (the
 * ends of the chain; a link in between is not followed one by one: the config and doc files are read with their own
 * ownership and containment checks), so a .git planted in /tmp or a shared folder is no repo root; where there is no uid
 * (Windows) only `dir` itself is looked at there. With no usable $HOME (empty, relative, or a filesystem root such as `/`)
 * nothing is inside it: ownership is always required. An UNSET HOME is not "no home": `os.homedir()` then falls back to the
 * passwd entry. Paths are compared as real paths (on Windows without regard to case).
 */
export function repoRoot(dir, opts = {}) {
  return climb(realOr(opts.fs ?? REAL_FS, (opts.path ?? path).resolve(dir), opts.path ?? path), opts);
}

/** `repoRoot` for a start that already is a real path. */
function climb(start, { path: p = path, fs = REAL_FS, home = homedir() } = {}) {
  const same = (a, b) => p.relative(a, b) === "";
  const homeReal = home && p.isAbsolute(home) ? realOr(fs, p.resolve(home), p) : null;
  const inHome = homeReal !== null && p.dirname(homeReal) !== homeReal && !leaves(p, p.relative(homeReal, start));
  const uid = currentUid();
  const owned = (git) => {
    const link = fs.lstatSync(git);
    return link.uid === uid && (!link.isSymbolicLink() || fs.statSync(git).uid === uid);
  };
  for (let cur = start; ; ) {
    const git = p.join(cur, ".git");
    if (fs.existsSync(git) && (inHome || uid === null || owned(git))) return cur;
    const up = p.dirname(cur);
    if (up === cur || (inHome ? same(cur, homeReal) : uid === null)) return null;
    cur = up;
  }
}

/**
 * `dir` (a real path, as `climb` and `resolveConfig` have it) and its parents up to `root` (what `repoRoot` returned for it:
 * a real path, or null). Without a repo root only `dir` itself is yielded: a config in some parent directory (another user's
 * /tmp, a shared folder) is never picked up.
 */
export function* ancestors(dir, root, p = path) {
  let cur = dir;
  yield cur;
  while (root !== null && cur !== root) {
    const up = p.dirname(cur);
    if (up === cur) return;
    cur = up;
    yield cur;
  }
}

const SECRET_KEY_RE = /token|secret|password|(^|[^a-z])pat($|[^a-z])/i;
// Sprintree tokens: personal access tokens (itn_) and OAuth access/refresh tokens (itna_, itnr_), followed by at least 20 body
// characters. They are hidden wherever they stand, whatever comes before the head (a word, a digit, a removed character): no exception,
// so st.mjs hides a superset of what the gitleaks rule in .gitleaks.toml reports (that rule skips a token that continues a word).
const TOKEN_BODY = "[A-Za-z0-9_-]";
const TOKEN_HEAD = "itn[ahrs]?_";
const MASK = "[token]";
// What the first pass of `scrub` writes in front of every mask: U+FDD0, a noncharacter (not meant for interchange, rare in real text, unlike a private-use character
// such as U+E000, which Nerd Fonts and EUDC text use), which cleaning does not remove (a NUL is gone after it). The second pass merges a
// mask WITH this sentinel and the token characters behind it, so a literal `[token]` in server text (`[token]s`, `[token]-based`, a chunk name
// `[token]_page_actions_0kpicgu`) is left as it is. `scrub` turns any U+FDD0 of the input into U+FFFD before the first pass, so input
// cannot fake the sentinel, and removes what is left of it at the end. Not in HIDDEN, not a control, and outside every byte class an escape
// sequence is made of (`[ -/]`, `[0-?]`, `[@-~]`).
const MASK_TAG = "\ufdd0";
const MASK_TAG_UNIT = MASK_TAG.charCodeAt(0);
const MASK_TAG_RE = /\ufdd0/g;
// The head with 20 body characters ahead; `maskRuns` reads the body on by hand. Not `${TOKEN_HEAD}${TOKEN_BODY}{20,}`: on a body of 8 MiB that
// regex overflows the regex stack (RangeError).
const TOKEN_HEAD_SRC = String.raw`${TOKEN_HEAD}(?=${TOKEN_BODY}{20})`;
const TOKEN_RE = new RegExp(TOKEN_HEAD_SRC);
const isTokenBody = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2d;
const TOKEN_CHARS_RE = new RegExp(`^${TOKEN_BODY}+$`);
const TOKEN_PREFIX_RE = new RegExp(String.raw`^(Bearer\s+)?${TOKEN_HEAD}`, "i");

/** Dotted paths of keys/values in a parsed config that look like a credential. Values are never returned. */
function suspiciousPaths(obj, prefix = "") {
  const found = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const here = prefix + k;
    if (SECRET_KEY_RE.test(k) || TOKEN_RE.test(k) || (typeof v === "string" && TOKEN_PREFIX_RE.test(v.trim()))) found.push(here);
    else if (v && typeof v === "object" && !Array.isArray(v)) found.push(...suspiciousPaths(v, here + "."));
  }
  return found;
}

function checkProjectKey(key, where) {
  if (typeof key !== "string" || !PROJECT_RE.test(key)) {
    throw new Error(`${where}: invalid project key (1 to 10 letters or digits, starting with a letter, like the key in a Sprintree URL)`);
  }
  if (key.toUpperCase() === PLACEHOLDER_KEY) {
    throw new Error(`${where}: the project key is still the placeholder ${PLACEHOLDER_KEY}; replace it with your project's key (list_projects shows it)`);
  }
}

/**
 * Read one local text file safely and decode it (UTF-8 BOM, UTF-16LE). Returns null when it does not exist.
 * The real path (a symlink is followed) must be a regular file, checked before anything is opened. The file is opened
 * by that real path (O_NOFOLLOW and O_NONBLOCK where the OS has them, so a swapped-in symlink or FIFO is not followed or
 * waited on). Then the place of the opened file is checked again (on Linux from the descriptor itself, elsewhere by
 * resolving the path again) and must be the same file (dev and ino), so a parent directory swapped for a link between
 * the check and the open is caught (best effort where the OS cannot name an open file's path). At most 1 MiB is read:
 * a longer file is refused, whatever size it reports (a procfs file reports 0).
 * With `contain` (a real path, as the repo walk yields it: config and doc files) both places must lie inside it and, on
 * POSIX, the file must belong to the current user; `noHardLink` refuses a file with several hard links. Without `contain`
 * (the explicit `@file` argument) any regular file is fine.
 */
function readTextFile(f, fs, { contain = null, noHardLink = false, path: p = path } = {}) {
  const inside = (real) => {
    if (contain && leaves(p, p.relative(contain, real))) throw new Error(`${f}: resolves outside the repo it was found in`);
    return real;
  };
  let real;
  try {
    real = inside(fs.realpathSync(f));
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
  if (!fs.statSync(real).isFile()) throw new Error(`${f}: not a regular file`);
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const fd = fs.openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    let where = null;
    if (process.platform === "linux") {
      try {
        where = fs.readlinkSync(`/proc/self/fd/${fd}`);
      } catch (e) {
        if (!e?.code) throw e; // no procfs: resolve the path again below
      }
    }
    const at = fs.statSync(inside(where ?? fs.realpathSync(f)));
    if (!st.isFile()) throw new Error(`${f}: not a regular file`);
    if (st.dev !== at.dev || st.ino !== at.ino) throw new Error(`${f}: changed while it was being opened`);
    if (noHardLink && st.nlink > 1) throw new Error(`${f}: more than one hard link`);
    const uid = currentUid();
    if (contain && uid !== null && st.uid !== uid) throw new Error(`${f}: not owned by the current user`);
    const buf = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let n = 0;
    let got;
    while (n < buf.length && (got = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += got;
    if (n > MAX_TEXT_BYTES) throw new Error(`${f}: larger than 1 MiB`);
    return decodeText(buf.subarray(0, n), f);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read and parse one `.sprintree.json`: stays inside the repo, never echoes file content. */
function readConfigFile(f, root, dir, fs, p) {
  const text = readTextFile(f, fs, { contain: root ?? dir, noHardLink: true, path: p });
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${f}: not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${f}: must contain a JSON object`);
  return parsed;
}

/**
 * The project key from a `sprintree.com/p/<KEY>` link in a doc file, nearest directory first: every link of a file is
 * looked at, the template placeholder (`.../p/KEY`) is skipped. Returns { key (upper-case), file } or null. A doc file
 * that is refused (outside the repo, not a regular file, too large, UTF-16BE) is skipped with a warning, never read.
 * Throws only when the placeholder is the sole link found. opts: { path, fs, home, warn(line) }.
 */
export function findDocKey(dir, opts = {}) {
  const p = opts.path ?? path;
  const start = realOr(opts.fs ?? REAL_FS, p.resolve(dir), p);
  return docKey(start, climb(start, opts), opts);
}

/** `findDocKey` for a start that already is a real path and its repo root (what `climb` returned, or null): `resolveConfig` has both. */
function docKey(start, root, { path: p = path, fs = REAL_FS, warn } = {}) {
  let placeholderIn = null;
  for (const d of ancestors(start, root, p)) {
    for (const name of DOC_FILES) {
      const f = p.join(d, name);
      let text;
      try {
        text = readTextFile(f, fs, { contain: root ?? d, path: p });
      } catch (e) {
        warn?.(`Warning: skipped ${e.message}`);
        continue;
      }
      if (text === null) continue;
      for (const m of text.matchAll(KEY_RE)) {
        if (m[1].toUpperCase() === PLACEHOLDER_KEY) {
          placeholderIn ??= f;
          continue;
        }
        return { key: m[1].toUpperCase(), file: f };
      }
    }
  }
  if (placeholderIn) checkProjectKey(PLACEHOLDER_KEY, placeholderIn);
  return null;
}

/**
 * Project config: `.sprintree.json` (nearest wins), then a `sprintree.com/p/<KEY>` link in a doc file.
 * Only the known keys are returned. opts: { path (default node:path, pass path.win32 to test Windows
 * paths), fs, home (default: the home directory), warn(line) }. warn gets the lines as they are: the caller makes them printable.
 */
export function resolveConfig(dir, opts = {}) {
  const p = opts.path ?? path;
  const fs = opts.fs ?? REAL_FS;
  const warn = opts.warn ?? null;
  const start = realOr(fs, p.resolve(dir), p);
  const root = climb(start, opts);
  const config = {};
  let source = null;
  for (const d of ancestors(start, root, p)) {
    const f = p.join(d, ".sprintree.json");
    const parsed = readConfigFile(f, root, d, fs, p);
    if (!parsed) continue;
    for (const k of KNOWN_CONFIG_KEYS) if (Object.hasOwn(parsed, k)) config[k] = parsed[k];
    if (Object.hasOwn(parsed, "project")) {
      checkProjectKey(parsed.project, f);
      config.project = parsed.project.toUpperCase();
    }
    source = f;
    const bad = suspiciousPaths(parsed);
    const ignored = Object.keys(parsed).filter((k) => !KNOWN_CONFIG_KEYS.includes(k) && !bad.includes(k));
    if (warn) {
      if (ignored.length) warn(`Warning: ${f}: ignored unknown keys: ${ignored.join(", ")} (only ${KNOWN_CONFIG_KEYS.join(", ")} are used)`);
      if (bad.length) {
        warn(
          `Warning: ${f} has ${bad.length === 1 ? "a key that looks like a token" : "keys that look like tokens"} (${bad.join(", ")}). ` +
            "Never commit tokens: keep them in the SPRINTREE_TOKEN environment variable and remove them from this file."
        );
      }
    }
    break;
  }
  if (!config.project) {
    const found = docKey(start, root, { path: p, fs, warn });
    if (found) {
      config.project = found.key;
      source = source ?? found.file;
    }
  }
  return source ? { ...config, _source: source } : config;
}

/** Refuse a plain-http endpoint unless it is local, so the token never crosses the network in clear. */
export function checkMcpUrl(raw) {
  // Not shown at all: the text may hold a password (user:password@host or a key in the query).
  const invalid = () => new Error("SPRINTREE_MCP_URL is not a valid URL: [invalid URL] (the value is not echoed, it may hold a password)");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw invalid();
  }
  // `bob:hunter2@sprintree.com/mcp` has no authority: it parses as the scheme `bob:` with the password in the path
  if (u.host === "") throw invalid();
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.href;
  // scheme://host/path only: no user:password@ and no query
  throw new Error(
    `SPRINTREE_MCP_URL must be https (plain http is only allowed for localhost, 127.0.0.1 and ::1), got ${u.protocol}//${u.host}${u.pathname}`
  );
}

/**
 * True when this module is the process entry point. Compares realpaths, so a symlink (for example a
 * node_modules/.bin link) and a different Windows drive-letter case still count. Shared by the scripts.
 */
export function isMainModule(argv1, metaUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Pick the JSON-RPC message answering request `id` from a JSON or SSE body (multi-line data frames joined). */
function pickMessage(text, id) {
  const trimmed = text.trim();
  let candidates = [];
  if (/^(event:|data:|id:|retry:|:)/.test(trimmed)) {
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data.trim()) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        /* ignore an unreadable frame, a later one may match */
      }
    }
  } else {
    const parsed = JSON.parse(trimmed);
    candidates = Array.isArray(parsed) ? parsed : [parsed];
  }
  return candidates.find((m) => m && m.id === id);
}

/** SPRINTREE_TOKEN as `redact` reads it: trimmed, without a leading "Bearer ". */
const tokenOf = (env) => (env.SPRINTREE_TOKEN || "").trim().replace(/^Bearer\s+/i, "");

/** The configured token ("" when unset). A real token is letters, digits, _ and - only: anything else is refused (and never echoed). */
function ownToken(env) {
  const t = tokenOf(env);
  if (t !== "" && !TOKEN_CHARS_RE.test(t)) {
    throw new Error("SPRINTREE_TOKEN must be letters, digits, _ and - only, like a Sprintree token (the value is not echoed); look for a stray quote, space, newline or other character");
  }
  return t;
}

function authHeader(env) {
  const t = ownToken(env);
  if (!t) {
    throw new Error(
      `No token. Set SPRINTREE_TOKEN to a Sprintree personal access token (${PAT_HINT}), ` +
        "or connect the Sprintree MCP server in your agent (OAuth) and use its tools directly."
    );
  }
  return `Bearer ${t}`;
}

// Terminal control sequences a hostile server (or a hostile config file name) could send. Every ESC sequence loses
// its introducer (OSC 52 writes the clipboard, and so do the C1 forms, which CONTROL_RE removes), and the payload
// of a string sequence stays visible as plain text: an unterminated OSC/DCS/APC/PM/SOS must never swallow the text
// after it. Every other C0/C1 control except \n and \t goes too, and so do the characters that make text read
// differently from what it is (HIDDEN): the format characters (Cf: bidi controls, zero-width space, word joiner, BOM,
// soft hyphen), every Default_Ignorable_Code_Point (also the unassigned ones in that set, tag characters and variation
// selectors among them) and the Mongolian selectors, and the fillers that print as nothing. U+2028, U+2029 and U+2800
// become a space, and a lone surrogate becomes U+FFFD first (stripping a format character between a high and a low
// surrogate would join them into a tag character). Default_Ignorable_Code_Point covers U+180B-180F; of the hieroglyph
// format controls U+13430-13438 are Cf since Unicode 12 and U+13439-1343F only since Unicode 15 (Node 18.7.0 has 14), so
// those seven are listed. What real text needs stays:
//   - ZWJ U+200D (emoji sequences), ZWNJ U+200C (Persian), LRM U+200E, RLM U+200F: ONE of them between two visible
//     characters, the first of a run (a run would carry two bits per character). A combining mark (Mn, Mc) belongs to the
//     visible character before it, so a joiner after a virama or an accent is after a visible character (Indic scripts:
//     U+0915 U+094D ZWJ U+0937). At the start or end of the text or of a line, next to a space, before a mark, after a mark
//     that has no visible character before it, or with no visible character on one side it goes. Hidden characters between
//     do not count: they are removed first, then runs are looked at;
//   - ONE variation selector VS1-16 (U+FE00-FE0F) directly after a visible base character (an emoji presentation
//     selector), and one VS17-256 (U+E0100-E01EF) directly after a CJK ideograph; a run, a leading one or one after
//     another format character is removed;
//   - the tag characters of the three subdivision flags (England, Scotland, Wales): U+1F3F4, a tag code, U+E007F.
// Every other tag character is removed: a fake flag can spell a command with them.
const VS = String.raw`\ufe00-\ufe0f\u{e0100}-\u{e01ef}`;
const HIDDEN = String.raw`\p{Cf}\p{Default_Ignorable_Code_Point}\u{13439}-\u{1343f}`;
const CJK = String.raw`\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u{2f800}-\u{2fa1f}\u{30000}-\u{323af}`;
// England, Scotland, Wales: a black flag, the tag letters of the region code, a cancel tag
const FLAG = `\\u{1f3f4}(?:${"gbeng|gbsct|gbwls".replace(/[a-z]/g, (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))})\\u{e007f}`;
// A visible character: not a space, a control, a mark, a format character, or a code point with no character
const BASE = String.raw`[^\p{Z}\p{Cc}\p{Cn}\p{Co}\p{M}${HIDDEN}]`;
const ESC_SEQ_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]?|[ -/]*[0-~]?)/g;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE_RE = /[\ud800-\udfff]/gu; // in `u` mode only a half that has no partner
// What is kept is group 1; any other match is removed (the joiners U+200C-200F too: dropInvisible decides on those)
const INVISIBLE_RE = new RegExp(`(${FLAG}|(?<=${BASE})[\\ufe00-\\ufe0f](?![${VS}])|(?<=[${CJK}])[\\u{e0100}-\\u{e01ef}](?![${VS}]))|[${HIDDEN}]`, "gu");
const HIDDEN_RE = new RegExp(`[${HIDDEN}]`, "gu");
const BASE_RE = new RegExp(BASE, "u");
const MARK_RE = /^[\p{Mn}\p{Mc}]$/u;

/** A visible character, `cp` a code point (-1: none, which is not). The sentinel in front of a mask (MASK_TAG) counts as one: the mask behind it is visible. */
const isBase = (cp) => (cp < 0x80 ? cp > 0x20 && cp < 0x7f : cp === MASK_TAG_UNIT || BASE_RE.test(String.fromCodePoint(cp)));
/** A combining mark that belongs to the character before it (Mn, Mc: a virama, an accent, a vowel sign). */
const isMark = (cp) => cp >= 0x300 && MARK_RE.test(String.fromCodePoint(cp));
/** The code point that ends `s` before index `i`. */
const codePointBefore = (s, i) => {
  const low = s.charCodeAt(i - 1);
  const high = low >= 0xdc00 && low <= 0xdfff ? s.charCodeAt(i - 2) : 0;
  return high >= 0xd800 && high <= 0xdbff ? s.codePointAt(i - 2) : low;
};

/**
 * Whether a visible character ends `s[from, to)`: a visible character, possibly followed by combining marks (a mark is part of
 * the character before it). A chunk of nothing but marks has no character of its own: `before` (the same question for the
 * text before the chunk) decides.
 */
function endsVisible(s, from, to, before) {
  for (let i = to; i > from; ) {
    const cp = codePointBefore(s, i);
    if (isBase(cp)) return true;
    if (!isMark(cp)) return false;
    i -= cp > 0xffff ? 2 : 1;
  }
  return before;
}

/**
 * A growing string made of UTF-16 code units. `replace` with a callback (or `$1`) on a global regex first collects every
 * match: 64 MiB of nothing but matches ran the process out of memory. The passes below read the matches one at a time
 * (`exec`) and write here instead; a match costs two array slots, not an object.
 */
class Units {
  constructor(size) {
    this.buf = new Uint16Array(size);
    this.n = 0;
  }
  /** Append `s[from, to)`. */
  add(s, from, to) {
    const { buf } = this;
    let n = this.n;
    for (let i = from; i < to; i++) buf[n++] = s.charCodeAt(i);
    this.n = n;
  }
  /** Append one code unit. */
  unit(c) {
    this.buf[this.n++] = c;
  }
  toString() {
    return unitsToString(this.buf, this.n);
  }
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** The string made of the first `n` code units of `buf` (one copy; the chunked fallback is for a big-endian machine, where the bytes are not UTF-16LE). */
function unitsToString(buf, n) {
  if (LITTLE_ENDIAN) return Buffer.from(buf.buffer, buf.byteOffset, 2 * n).toString("utf16le");
  const CHUNK = 8192;
  const parts = [];
  for (let i = 0; i < n; i += CHUNK) parts.push(String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + CHUNK, n))));
  return parts.join("");
}

/** `text` with every match of the global regex `re` replaced by what `put(units, match)` writes (nothing without `put`). `size`: the most code units the result can have. */
function rewrite(text, re, put = null, size = text.length) {
  re.lastIndex = 0;
  let m = re.exec(text);
  if (m === null) return text;
  const out = new Units(size);
  let at = 0;
  do {
    out.add(text, at, m.index);
    if (put) put(out, m);
    at = m.index + m[0].length;
  } while ((m = re.exec(text)) !== null);
  out.add(text, at, text.length);
  return out.toString();
}

/** INVISIBLE_RE applied: what it keeps stays, everything else goes, and of the joiners U+200C-200F only the first of a run between two visible characters stays. */
function dropInvisible(text) {
  INVISIBLE_RE.lastIndex = 0;
  let m = INVISIBLE_RE.exec(text);
  if (m === null) return text;
  const out = new Units(text.length);
  let at = 0;
  let visible = false; // a visible character (with its marks) ends what has been written
  let joiner = -1; // the first joiner of the run being read, not written yet
  let leftSeen = false; // a visible character stood before that run
  // the run is over: `next` is the code point that follows it
  const settle = (next) => {
    if (joiner >= 0 && leftSeen && isBase(next)) {
      out.unit(joiner);
    }
    joiner = -1;
  };
  do {
    if (m.index > at) {
      settle(text.codePointAt(at));
      out.add(text, at, m.index);
      visible = endsVisible(text, at, m.index, visible);
    }
    if (m[1] !== undefined) {
      settle(m[1].codePointAt(0));
      out.add(m[1], 0, m[1].length);
      visible = endsVisible(m[1], 0, m[1].length, visible);
    } else if (joiner < 0 && m[0] >= "\u200c" && m[0] <= "\u200f") {
      joiner = m[0].charCodeAt(0);
      leftSeen = visible;
    }
    at = m.index + m[0].length;
  } while ((m = INVISIBLE_RE.exec(text)) !== null);
  if (at < text.length) {
    settle(text.codePointAt(at));
    out.add(text, at, text.length);
  }
  return out.toString();
}

/** Text made safe to print on a terminal: control sequences and invisible characters removed (ESC sequences first, so one cannot be split). */
export function stripControls(text) {
  let s = String(text);
  s = rewrite(s, LONE_SURROGATE_RE, (out) => out.unit(0xfffd));
  s = rewrite(s, ESC_SEQ_RE);
  s = rewrite(s, CONTROL_RE);
  s = rewrite(s, /[\u2028\u2029\u2800]/g, (out) => out.unit(0x20));
  return dropInvisible(s);
}

/** True when `text` reads as a refusal ("Error:" first, whitespace and every HIDDEN character, the kept ones too, left out). Reads only as far as it needs: a 64 MiB answer is not copied for this. */
export function isRefusal(text) {
  let head = "";
  let at = 0;
  while (head.length < 6 && at < text.length) {
    const m = HIDDEN_RE.exec(text);
    const piece = text.slice(at, m ? m.index : text.length);
    head += head === "" ? piece.trimStart() : piece;
    at = m ? m.index + m[0].length : text.length;
  }
  HIDDEN_RE.lastIndex = 0;
  return head.startsWith("Error:");
}

// A token can be hidden in text by characters that print as nothing (the kept joiners, a variation selector, flag
// tags), percent-encoded (`Bearer%20itn%5F...`) or written with a `_` escape for the underscore. gitleaks decodes the last two, so
// redaction looks at a view of the text: HIDDEN characters left out, escapes decoded (recursively, up to 5 levels, as
// gitleaks does). Every match is mapped back to the text it came from and replaced there. What gitleaks decodes, and so
// does this: `%XX` for the ASCII characters from tab to `~` (not the controls U+0000-0008 and DEL, not a byte of a
// multi-byte character) and `\uXXXX` or `\\uXXXX` for any code unit. What it does on top: it also decodes base64 and hex
// segments, this does not.
const ESCAPE_RE = /%(0[9a-fA-F]|[1-6][0-9a-fA-F]|7[0-9a-eA-E])|\\{1,2}[uU]([0-9a-fA-F]{4})/g;
const MAX_DECODE_DEPTH = 5;
// Only text with a HIDDEN character or an escape in it needs the view; any other text is read as it is
const NEEDS_VIEW_RE = new RegExp(`[${HIDDEN}]|${ESCAPE_RE.source}`, "u");
const regexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with every run that `re` finds in `view` replaced by `masked`. A run is what `re` matches (the configured token, a mask, a token
 * head) and then every token character behind it, read by hand: the regex only says where a run starts, so the cost is linear. `view` is
 * `text` itself, or a view of it (hidden characters left out, escapes decoded); `spans[2i]`, `spans[2i+1]`: the part of `text` that unit i
 * of the view stands for. A run is at least 6 characters and becomes at most 8 (MASK_TAG and the mask): the result is longer by at most two characters per run.
 */
function maskRuns(text, view, re, spans, masked) {
  re.lastIndex = 0;
  let m = re.exec(view);
  if (m === null) return text;
  const out = new Units(text.length + 2 * Math.floor(text.length / 6) + 8);
  let at = 0;
  do {
    let end = m.index + m[0].length;
    while (end < view.length && isTokenBody(view.charCodeAt(end))) end++;
    out.add(text, at, spans ? spans[2 * m.index] : m.index);
    out.add(masked, 0, masked.length);
    at = spans ? spans[2 * (end - 1) + 1] : end;
    re.lastIndex = end;
  } while ((m = re.exec(view)) !== null);
  out.add(text, at, text.length);
  return out.toString();
}

/**
 * The configured token (at least 6 characters; a shorter one is no secret; `ownToken` has refused anything but token characters) and
 * anything shaped like a Sprintree token (itn_, itnh_, itna_, itnr_, itns_ and 20 body characters), whatever stands before it, replaced by [token],
 * each together with the token characters behind it. They are looked for in the text as it is and, when it holds a hidden character or an
 * escape, in the view described above (the configured token also as it was written: an escape that starts before it can take its first
 * characters, `%41abcdef` reads as `Aabcdef`).
 * `before`: the text is read before its control sequences and invisible characters go (see `scrub`), so a mask is written as MASK_TAG and
 * the mask (an unfinished sequence right before a mask would take its `[`; see MASK_TAG for why the sentinel stops it). Otherwise
 * (the second pass) MASK_TAG, the mask and the token characters behind them are one mask, written as the plain mask (the rest of a token
 * that an earlier pass cut short); a `[token]` without a MASK_TAG in front of it is text like any other.
 */
function redact(text, env, before = false) {
  text = String(text);
  const mine = tokenOf(env);
  const own = mine.length >= 6 ? regexEscape(mine) : null;
  const masked = before ? MASK_TAG + MASK : MASK;
  const re = new RegExp([own, before ? null : regexEscape(MASK_TAG + MASK), TOKEN_HEAD_SRC].filter(Boolean).join("|"), "g");
  if (!NEEDS_VIEW_RE.test(text)) return maskRuns(text, text, re, null, masked);
  // The configured token as it was written, before the view: an escape that STARTS before the token can take its first characters
  // (`%41abcdef` reads as `Aabcdef`), so the view alone would not find `abcdef`. It writes MASK_TAG too, also in the second pass: the view
  // below then merges this mask with the token characters behind it that the raw run could not reach (a kept character stood between).
  if (own) text = maskRuns(text, text, new RegExp(own, "g"), null, MASK_TAG + MASK);
  // The view is a code unit array `cur`; spans[2i], spans[2i+1]: the part of `text` that unit i stands for. Removing and
  // decoding shrink both in place (`move` keeps what lies between two edits).
  const n = text.length;
  const cur = new Uint16Array(n);
  const spans = new Int32Array(2 * n);
  for (let i = 0; i < n; i++) {
    cur[i] = text.charCodeAt(i);
    spans[2 * i] = i;
    spans[2 * i + 1] = i + 1;
  }
  let len = n;
  let from = 0; // next unread unit
  let to = 0; // next free unit
  const move = (end) => {
    if (from !== to) {
      cur.copyWithin(to, from, end);
      spans.copyWithin(2 * to, 2 * from, 2 * end);
    }
    to += end - from;
    from = end;
  };
  let view = text;
  // Every match of `rx` in the view goes: `unit(m)` is the code unit it becomes (none: it is removed). Returns whether there was a match.
  const compact = (rx, unit) => {
    rx.lastIndex = 0;
    let m = rx.exec(view);
    if (m === null) return false;
    from = 0;
    to = 0;
    do {
      move(m.index);
      if (unit) {
        const first = spans[2 * m.index];
        const end = spans[2 * (m.index + m[0].length - 1) + 1];
        cur[to] = unit(m);
        spans[2 * to] = first;
        spans[2 * to + 1] = end;
        to++;
      }
      from = m.index + m[0].length;
    } while ((m = rx.exec(view)) !== null);
    move(len);
    len = to;
    view = unitsToString(cur, len);
    return true;
  };
  compact(HIDDEN_RE, null);
  // an escape never decodes to the sentinel (`\ufdd0`): the view must not hold a sentinel that the text does not
  const decode = (m) => {
    const c = parseInt(m[1] ?? m[2], 16);
    return c === MASK_TAG_UNIT ? 0xfffd : c;
  };
  for (let depth = 0; depth < MAX_DECODE_DEPTH && compact(ESCAPE_RE, decode); depth++);
  return maskRuns(text, view, re, spans, masked);
}

// An escape prefix (`ESC`, `ESC [ 1`, `ESC (`) right before a token head: cleaning would take the head's `i` as the sequence's final byte.
// ESC_SEQ_RE without its final byte - change together.
const HEAD_AFTER_ESC_RE = new RegExp(String.raw`(\u001b(?:\[[0-?]*[ -/]*|[ -/]*))(?=${TOKEN_HEAD})`, "g");

/**
 * Everything that is printed goes through this: redacted as it came, cleaned, redacted again. Each pass has a reason:
 * - as it came: an unfinished ESC sequence ("ESC" + one character, `ESC [ 1` + a letter) takes the first characters of a token behind it when it is cleaned,
 *   so the token is masked while it is still whole. A NUL is put between an escape prefix and a head that stands right behind it (the
 *   cleaning removes the NUL, but the sequence ends before the head), a mask is written with MASK_TAG in front;
 * - cleaned: control sequences, controls and invisible characters must not stay in the text, and what cleaning removes can join the pieces of a token
 *   (`itn_` + 10 characters, ESC [ 0 m, 20 more);
 * - again: so what cleaning joined is read as the token it is, and a mask with MASK_TAG in front followed by token characters is one mask (the rest of a
 *   token the first pass cut short).
 * A token is hidden wherever it stands: nothing before its head (a word, a digit, a sequence) makes it safe. Not covered: a deliberately
 * malformed escape sequence that takes a character from inside the head (`itn ESC _...`), like base64 and hex it takes someone who has the token.
 * A U+FDD0 in the input is U+FFFD in the output (it is MASK_TAG), and none is ever printed.
 */
export function scrub(text, env) {
  let s = String(text);
  s = rewrite(s, MASK_TAG_RE, (o) => o.unit(0xfffd));
  s = rewrite(s, HEAD_AFTER_ESC_RE, (o, m) => {
    o.add(m[1], 0, m[1].length);
    o.unit(0);
  }, 2 * s.length);
  s = redact(stripControls(redact(s, env, true)), env);
  // A safety net that should never fire: every sentinel a pass writes is merged into a mask by the view of the second pass.
  return rewrite(s, MASK_TAG_RE);
}

/** `v` ("20.1.0") >= `min` ("18.7.0"), compared part by part. */
function nodeAtLeast(v, min) {
  const a = String(v).split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

function timeoutMs(env) {
  const raw = env.SPRINTREE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= MAX_TIMEOUT_MS)) {
    throw new Error(`SPRINTREE_TIMEOUT_MS must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS} (default ${DEFAULT_TIMEOUT_MS})`);
  }
  return n;
}

/** What to tell the user about a failed fetch: the cause code (else a short cause text) and the host, never the path, query, userinfo or token. */
function networkMessage(e, url, host, env) {
  const cause = e?.cause;
  if (/redirect/i.test(String(cause?.message ?? e?.message ?? ""))) {
    return "server redirected; set SPRINTREE_MCP_URL to the final URL";
  }
  const code = String(cause?.code ?? e?.code ?? "").replace(/[^A-Za-z0-9_]/g, "");
  const text = cause?.message ? scrub(String(cause.message).split(url).join("[url]"), env).trim().slice(0, 80) : "";
  return `fetch failed: ${code || text || "unknown error"} ${host}`;
}

/** The refusal of a body over the limit (not a network error: its message is shown as it is). */
class BodyTooLarge extends Error {
  constructor(max) {
    super(`response is larger than ${max % (1024 * 1024) === 0 ? `${max / (1024 * 1024)} MiB` : `${max} bytes`}; refusing to read it`);
  }
}

/**
 * The text of a response, at most `max` bytes of it. The body is read chunk by chunk and the stream is cancelled at the limit, so
 * a server that never stops sending costs `max` bytes, not all of memory; a declared Content-Length over the limit is refused
 * before a byte is read. A client without a body stream (a mock) gives only `text()`: that is measured in bytes too.
 */
async function readBody(res, max) {
  if (Number(res.headers?.get?.("content-length")) > max) {
    await res.body?.cancel?.().catch(() => {});
    throw new BodyTooLarge(max);
  }
  if (typeof res.body?.getReader !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text) > max) throw new BodyTooLarge(max);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let got = 0;
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (done) break;
      got += chunk.value.byteLength;
      if (got > max) throw new BodyTooLarge(max);
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    if (!done) await reader.cancel().catch(() => {});
  }
}

/** The `tools/list` answer of a connected client: the array of tools (shared by `tools`, `schema` and the snapshot refresh). */
export async function listTools(client) {
  const answer = await client.rpc("tools/list", {});
  if (!Array.isArray(answer?.tools)) throw new Error("the tools/list answer has no `tools` array");
  return answer.tools;
}

/** JSON-RPC client over Streamable HTTP. `connect()` runs the initialize handshake; `rpc(method, params)` returns the result. */
export function makeClient({ fetchImpl, env, warn, maxBody = MAX_BODY_BYTES }) {
  const url = checkMcpUrl(env.SPRINTREE_MCP_URL || DEFAULT_URL);
  const { host, hostname } = new URL(url);
  const auth = authHeader(env);
  const ms = timeoutMs(env);
  if (hostname !== "sprintree.com") warn?.(`Note: your SPRINTREE_TOKEN is sent to ${host} (SPRINTREE_MCP_URL), not to sprintree.com`);
  const excerpt = (text, n) => scrub(text, env).trim().slice(0, n);
  let sid = null;
  let protocol = null;
  let seq = 0;

  async function rpc(method, params, notify = false) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: auth,
    };
    if (sid) headers["Mcp-Session-Id"] = sid;
    if (protocol) headers["MCP-Protocol-Version"] = protocol;
    const body = { jsonrpc: "2.0", method, params };
    if (!notify) body.id = ++seq;
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(ms),
      });
      sid = res.headers.get("mcp-session-id") ?? sid;
      text = await readBody(res, maxBody);
    } catch (e) {
      if (e instanceof BodyTooLarge) throw e;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new Error(`request to ${host} timed out after ${ms} ms (set SPRINTREE_TIMEOUT_MS to change)`);
      }
      throw new Error(networkMessage(e, url, host, env));
    }
    if (notify) return null;
    const said = () => {
      const t = excerpt(text, 300);
      return t ? ` Server said: ${t}` : "";
    };
    if (res.status === 401) throw new Error(`HTTP 401: invalid, expired or revoked token (${PAT_HINT}).${said()}`);
    if (res.status === 403) throw new Error(`HTTP 403: the token cannot do this (read-only token on a write tool?) - ${PAT_HINT}.${said()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${excerpt(text, 300)}`);
    let msg;
    try {
      msg = pickMessage(text, body.id);
    } catch {
      throw new Error(`Unreadable answer to ${method}: ${excerpt(text, 200)}`);
    }
    if (!msg) throw new Error(`no answer with id ${body.id} to ${method} in the response`);
    if (msg.error) throw new Error(`RPC ${method}: ${excerpt(JSON.stringify(msg.error), 300)}`);
    return msg.result;
  }

  async function connect() {
    const init = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "sprintree-agent", version: VERSION },
    });
    const negotiated = init?.protocolVersion;
    protocol = typeof negotiated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(negotiated) ? negotiated : PROTOCOL_VERSION;
    await rpc("notifications/initialized", {}, true);
  }

  return { rpc, connect };
}

/**
 * Run one CLI invocation. Returns the exit code; all I/O goes through `deps` so tests can mock it.
 * deps: { fetch, env, cwd, out(line), err(line), nodeVersion, maxBody (bytes; a test lowers or lifts it) }
 */
export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const cwd = deps.cwd ?? process.cwd();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const [cmd, a1, a2] = argv;
  try {
    if (cmd === "version") {
      out(VERSION);
      return 0;
    }
    ownToken(env);
    const warn = (line) => err(scrub(line, env));
    if (cmd === "key" || cmd === "config") {
      const { _source, ...cfg } = resolveConfig(path.resolve(cwd, a1 || "."), { warn });
      if (cmd === "config") {
        // JSON.stringify escapes C0 but leaves DEL and C1 raw: escape them too, so the output is plain text and still valid JSON.
        const json = JSON.stringify(cfg, null, 2).replace(/[\u007f-\u009f]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`);
        out(scrub(json, env));
        return 0;
      }
      if (!cfg.project) {
        throw new Error(
          `No project key. Put a \`sprintree.com/p/<KEY>\` link in ${DOC_NAMES.slice(0, -1).join(", ")} or ${DOC_NAMES.at(-1)}, ` +
            'or `{"project":"KEY"}` in .sprintree.json. Otherwise find it with list_projects.'
        );
      }
      out(cfg.project);
      return 0;
    }
    if (!nodeAtLeast(nodeVersion, MIN_NODE) || typeof fetchImpl !== "function") {
      throw new Error(
        `st.mjs needs Node.js ${MIN_NODE} or newer (global fetch); this is Node ${nodeVersion}${typeof fetchImpl === "function" ? "" : " without fetch"}. Upgrade Node: https://nodejs.org`
      );
    }
    if (!["tools", "schema", "call"].includes(cmd)) {
      throw new Error("usage: st.mjs tools | schema <tool> | call <tool> <json|@file> | key [dir] | config [dir] | version");
    }
    if (cmd === "schema" && !a1) throw new Error("usage: st.mjs schema <tool>");
    if (cmd === "call" && !a1) throw new Error("usage: st.mjs call <tool> '<json>' | @file");
    let args = {};
    if (cmd === "call") {
      let raw = a2 ?? "{}";
      if (raw.startsWith("@")) {
        const f = path.resolve(cwd, raw.slice(1));
        raw = readTextFile(f, REAL_FS);
        if (raw === null) throw new Error(`argument file not found: ${f}`);
      }
      try {
        args = JSON.parse(raw);
      } catch (e) {
        // V8's message quotes the start of the text; the text may be a file the agent should not echo, so only the position is kept.
        const at = /position (\d+)/.exec(e?.message ?? "");
        throw new Error(`arguments are not valid JSON${at ? ` (at position ${at[1]})` : ""}`);
      }
    }
    const client = makeClient({ fetchImpl, env, warn, maxBody: deps.maxBody });
    await client.connect();
    if (cmd === "tools" || cmd === "schema") {
      const tools = await listTools(client);
      if (cmd === "tools") {
        for (const t of tools) out(scrub(`${t.name}(${Object.keys(t.inputSchema?.properties ?? {}).join(", ")})`, env));
      } else {
        const t = tools.find((x) => scrub(x?.name, env) === a1);
        if (!t) throw new Error(`no such tool: ${a1}`);
        out(scrub(t.description ?? "", env));
        out(scrub(JSON.stringify(t.inputSchema, null, 2), env));
      }
      return 0;
    }
    const result = await client.rpc("tools/call", { name: a1, arguments: args });
    // Each item is cleaned on its own, then joined. Sprintree reports refusals as normal content starting with "Error:", in any item.
    const texts = (Array.isArray(result?.content) ? result.content : []).map((c) => scrub(c?.text ?? "", env));
    out(texts.join("\n"));
    return result?.isError || texts.some(isRefusal) ? 1 : 0;
  } catch (e) {
    err(`Error: ${scrub(e?.message ?? e, env)}`);
    return 1;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
