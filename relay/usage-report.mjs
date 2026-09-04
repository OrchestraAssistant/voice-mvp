#!/usr/bin/env node
/**
 * Compare what sessions cost.
 *
 *   node relay/usage-report.mjs                     every session in relay/logs
 *   node relay/usage-report.mjs --by-model          one row per model
 *   node relay/usage-report.mjs --prices mine.json  a different price table
 *   node relay/usage-report.mjs --dir other/logs    a different log directory
 *   node relay/usage-report.mjs --json              machine-readable
 *
 * Reads the logs a session already writes, so a provider only has to produce
 * events in the same shape to be comparable. Nothing here is shipped in the
 * package: it is a bench instrument.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRICES, priceSession, tallySession } from "./usage.js";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const dir = path.resolve(flag("--dir", path.join(path.dirname(fileURLToPath(import.meta.url)), "logs")));
const prices = flag("--prices") ? JSON.parse(fs.readFileSync(flag("--prices"), "utf8")) : PRICES;

const sessions = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
  const events = [];
  for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A log is appended to while it is being written; a torn last line is
      // normal and is not a reason to abandon the session in front of it.
    }
  }
  const tally = tallySession(events);
  if (tally.responses === 0) continue; // warm connections nobody spoke to
  sessions.push({ file, tally, cost: priceSession(tally, prices) });
}

if (has("--json")) {
  console.log(JSON.stringify(sessions, null, 2));
  process.exit(0);
}

if (sessions.length === 0) {
  console.log(`No sessions with any responses in ${dir}`);
  process.exit(0);
}

const usd = (n) => `$${n.toFixed(4)}`;
const pad = (s, n, left = false) => (left ? String(s).padStart(n) : String(s).padEnd(n));

if (has("--by-model")) {
  const byModel = new Map();
  for (const s of sessions) {
    const key = s.tally.model ?? "unknown";
    const g = byModel.get(key) ?? { sessions: 0, turns: 0, tools: 0, inAudio: 0, outAudio: 0, cost: 0, priced: true };
    g.sessions += 1;
    g.turns += s.tally.turns;
    g.tools += s.tally.toolCalls;
    g.inAudio += s.tally.input.audio;
    g.outAudio += s.tally.output.audio;
    g.cost += s.cost.total;
    g.priced = g.priced && s.cost.priced;
    byModel.set(key, g);
  }
  console.log(`${pad("model", 24)}${pad("sessions", 9, true)}${pad("turns", 7, true)}${pad("tools", 7, true)}${pad("audio in", 10, true)}${pad("audio out", 11, true)}${pad("cost", 11, true)}${pad("per session", 13, true)}`);
  for (const [model, g] of [...byModel].sort((a, b) => b[1].cost - a[1].cost)) {
    const cost = g.priced ? usd(g.cost) : "unpriced";
    const each = g.priced ? usd(g.cost / g.sessions) : "-";
    console.log(`${pad(model, 24)}${pad(g.sessions, 9, true)}${pad(g.turns, 7, true)}${pad(g.tools, 7, true)}${pad(g.inAudio, 10, true)}${pad(g.outAudio, 11, true)}${pad(cost, 11, true)}${pad(each, 13, true)}`);
  }
  process.exit(0);
}

console.log(`${pad("session", 26)}${pad("model", 22)}${pad("turns", 7, true)}${pad("resp", 6, true)}${pad("input", 9, true)}${pad("cached", 9, true)}${pad("output", 8, true)}${pad("audio out", 11, true)}${pad("cost", 11, true)}`);
let total = 0;
let anyUnpriced = false;
for (const { file, tally, cost } of sessions) {
  total += cost.total;
  anyUnpriced = anyUnpriced || !cost.priced;
  const cached = tally.input.cachedText + tally.input.cachedAudio;
  console.log(
    pad(file.replace(".jsonl", "").slice(0, 25), 26) +
      pad(tally.model ?? "unknown", 22) +
      pad(tally.turns, 7, true) +
      pad(tally.responses, 6, true) +
      pad(tally.input.total, 9, true) +
      pad(cached, 9, true) +
      pad(tally.output.total, 8, true) +
      pad(tally.output.audio, 11, true) +
      pad(cost.priced ? usd(cost.total) : "unpriced", 11, true),
  );
}
console.log(`\n${sessions.length} sessions, ${usd(total)} total`);
if (anyUnpriced) console.log("Some sessions have no price entry for their model, and count as $0 in that total.");
console.log("Rates are list prices and go stale -- check them before believing a comparison.");
