#!/usr/bin/env node
/**
 * /sprintree:commands: turn /claude commands on or off for THIS Claude Code session without a restart, or set the default.
 *
 *   node commands.mjs on | off | status | default on | default off      (one argument string, as the command file passes "$ARGUMENTS")
 *
 * The setting lives in ${XDG_CONFIG_HOME:-$HOME/.config}/sprintree/sessions/<hash>.json (this session; <hash> is the stream session id,
 * a hash of CLAUDE_CODE_SESSION_ID) and .../commands-default (every session without its own setting); the live-events monitor
 * (listen.mjs) watches both and reconnects with the new X-Stream-Commands header. Priority: session, default, SPRINTREE_COMMANDS, off.
 * /clear: Claude Code gives the session a new CLAUDE_CODE_SESSION_ID, but the running monitor keeps the id it started with and watches
 * that file. The monitor writes a pointer keyed by CLAUDE_PID (stable across /clear, the same for both, different per Claude Code
 * process); `monitorEnv` follows it to the monitor's own session id, so on, off and status act on the file the monitor watches.
 * Without a pointer (no CLAUDE_PID, no running monitor, a dead one) the current id is used, as before.
 * Files are 0600 in a 0700 directory, written atomically. A bad argument prints one usage line and still exits 0: a non-zero exit
 * would abort the slash command. Output never holds a token or a file path.
 */
import { isMainModule } from "./st.mjs";
import { readLayers, readCommandsState, readLive, readSettingTimes, defaultFile, monitorEnv, safeLine, sessionFile, writeAtomic } from "./stream-common.mjs";

const USAGE = "usage: /sprintree:commands on | off | status | default on | default off";
const word = (v) => (v ? "on" : "off");
const why = (l) => (l.reason === "loose" ? " (the file is readable by others, so it counts as off; set it again)" : l.reason === "malformed" ? " (the file is not valid, so it counts as off; set it again)" : "");

/** Parses the argument string: { action: "on"|"off"|"status"|"default" , value? } or null. */
export function parseArgs(text) {
  const w = String(text ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (w.length === 0 || (w.length === 1 && w[0] === "status")) return { action: "status" };
  if (w.length === 1 && (w[0] === "on" || w[0] === "off")) return { action: w[0] };
  if (w.length === 2 && w[0] === "default" && (w[1] === "on" || w[1] === "off")) return { action: "default", value: w[1] };
  return null;
}

/** Runs one command; returns the lines to print. Never throws. */
export function run(text, env0 = process.env) {
  const a = parseArgs(text);
  if (!a) return [USAGE];
  const env = monitorEnv(env0);
  try {
    if (a.action === "on" || a.action === "off") {
      const file = sessionFile(env);
      if (!file) return ["/claude commands: no Claude Code session id here (CLAUDE_CODE_SESSION_ID is not set), so nothing was changed. Use: /sprintree:commands default on"];
      writeAtomic(file, `${JSON.stringify({ commands: a.action, at: new Date().toISOString() })}\n`);
      const live = readLive(env);
      return [`/claude commands ${a.action} in this session (the monitor reconnects within a few seconds)`, ...(live ? [`this session: ${live.address}`] : [])];
    }
    if (a.action === "default") {
      writeAtomic(defaultFile(env), `${a.value}\n`);
      return [`/claude commands default ${a.value} (applies to every session without its own setting; a running monitor reconnects within a few seconds)`];
    }
    return status(env);
  } catch {
    return ["/claude commands: could not write the setting file (check the permissions of the sprintree config directory)"];
  }
}

function status(env) {
  const s = readCommandsState(env);
  const live = readLive(env);
  const l = readLayers(env);
  const src = { session: "this session", default: "the default", env: "SPRINTREE_COMMANDS", none: "nothing is set" }[s.source];
  const lines = [`/claude commands: ${word(s.value)} (${src})${why(s)}`];
  const t = readSettingTimes(env);
  // an ack older than the setting that disagrees with it is the old connection's hello: the monitor is about to reconnect.
  // An ack that already agrees means the same value was set again: the monitor sees no change and never refreshes the ack.
  if (s.ack !== undefined && s.ack !== word(s.value) && t.setAt !== null && t.ackAt !== null && t.ackAt < t.setAt) lines.push("Server: reconnecting (run status again in a few seconds)");
  else if (s.ack === undefined) lines.push("Server: the monitor has not confirmed yet");
  else lines.push(s.ack === "unknown" ? "Server: confirmed the connection, but this server does not report the setting" : `Server: confirmed ${s.ack}`);
  if (live) lines.push(`this session: ${live.address}`);
  lines.push(`Default: ${l.default ? word(l.default.value) + why(l.default) : "not set"}`);
  lines.push(`SPRINTREE_COMMANDS: ${l.env ? l.env.raw.slice(0, 20) : "not set"}`);
  return lines;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  for (const l of run(process.argv.slice(2).join(" "))) process.stdout.write(`${safeLine(l)}\n`);
  process.exitCode = 0;
}
