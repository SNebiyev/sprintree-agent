// Preload (node --require) for a script that must stay offline: any use of fetch, a socket, http(s) or a DNS lookup throws.
// CommonJS on purpose: --require works on the minimum Node (--import does not).
"use strict";
const boom = (what) => () => {
  throw new Error(`network use: ${what}`);
};
globalThis.fetch = boom("fetch");
for (const [mod, names] of [
  ["net", ["connect", "createConnection"]],
  ["tls", ["connect"]],
  ["http", ["request", "get"]],
  ["https", ["request", "get"]],
  ["dns", ["lookup", "resolve"]],
  ["dgram", ["createSocket"]],
]) {
  const m = require(mod);
  for (const n of names) m[n] = boom(`${mod}.${n}`);
}
require("net").Socket.prototype.connect = boom("net.Socket.connect");
