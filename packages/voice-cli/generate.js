#!/usr/bin/env node
/**
 * Turns an app's source into .voice/manifest.json.
 *
 * A set of DETECTORS, not one analyser. Each knows one pattern -- a router, a
 * data layer, a schema library -- and contributes what it can. The manifest is
 * the union, and a detector finding nothing is normal rather than a failure.
 *
 * It used to be three hardcoded readings of three hardcoded filenames, which
 * worked for the app it was written against and produced literally nothing for
 * the first real app it met. Adding a framework is now additive.
 */
import fs from "node:fs";
import path from "node:path";

import { DETECTORS } from "./registry.js";
import { runDetectors, activeExcludes } from "./core/run.js";
import { merge } from "./core/merge.js";
import { OVERLAY_FILE, applyOverlay } from "./core/overlay.js";
import { excludeInfrastructure } from "./core/exclude.js";
import { countCallSites } from "./core/callsites.js";

const USAGE = `voice-cli -- turn a React app's source into .voice/manifest.json

  npx @yourco/voice-cli [srcDir] [outDir]

  srcDir   where the app's source lives   (default: ./src, falling back to .)
  outDir   where the manifest is written  (default: ./.voice)

Run it from your app's root. Every detector that fired is listed in the output,
along with every one that found nothing and why.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

// Relative to the CALLER. These used to resolve relative to this file, to a
// sibling demo-app that exists in one repo and nowhere else, so `npx` worked
// for us and for nobody who installed it.
const explicitSrc = process.argv[2];
// Falling back to `.` rather than insisting on `src`, because plenty of apps
// do not have one. An explicitly passed path that does not exist is still an
// error -- that is a typo, not a layout.
const SRC_DIR = path.resolve(explicitSrc || (fs.existsSync("src") ? "src" : "."));
const OUT_DIR = path.resolve(process.argv[3] || ".voice");
/**
 * The app root, which is where framework conventions are rooted: `app/` and
 * `pages/` sit beside `src/` as often as inside it, and `next.config` sits
 * beside both.
 *
 * Found by walking up to the nearest package.json rather than assuming the
 * parent of srcDir. Running `voice-cli .` from an app directory made the
 * parent the root, which in a monorepo is the workspace folder -- no
 * package.json, no next.config, so a Next.js app reported that the Next
 * detectors did not apply to it.
 */
function findRoot(from) {
  let dir = from;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}
const ROOT = findRoot(SRC_DIR);

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`No source directory at ${SRC_DIR}\n\n${USAGE}`);
    process.exit(1);
  }

  const { results } = runDetectors(DETECTORS, { srcDir: SRC_DIR, root: ROOT });
  for (const r of results) if (r.failed) console.warn(`  ${r.detector} failed: ${r.failed}`);

  const { manifest, conflicts, notes, sources } = merge(results);
  manifest.actions.forEach((a) => delete a._hookName);
  // Internal, carried between detectors and never shipped: a file path in the
  // manifest would be a path from someone else's machine in the model's prompt.
  manifest.routes.forEach((r) => delete r._file);
  manifest.actions.forEach((a) => delete a._inputSchema);

  // Policy, not detection: what was found is one question, what a voice agent
  // should be handed is another. Anything named in the overlay is kept, since
  // naming it there is a deliberate act.
  const overlaid = applyOverlay(manifest, path.join(OUT_DIR, OVERLAY_FILE));
  // Only the frameworks that actually applied get a say in what counts as
  // infrastructure, so a React app is never filtered by Next.js conventions.
  const excluded = excludeInfrastructure(manifest, activeExcludes(DETECTORS, results), overlaid.named);

  // How often the app's own code calls each operation. Recorded rather than
  // acted on: zero is a strong signal and still only a signal, since an
  // endpoint added last week for a page shipping next week counts zero and is
  // perfectly real. Whoever writes the include list should see it.
  const counts = countCallSites([...manifest.queries, ...manifest.actions], [SRC_DIR, ROOT]);
  const uncalled = [];
  for (const op of [...manifest.queries, ...manifest.actions]) {
    const count = counts.get(op.name);
    if (count === null || count === undefined) continue;
    op.callSites = count;
    if (count === 0) uncalled.push(op.name);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "manifest.json");
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: "static-analysis", ...manifest }, null, 2));

  console.log(`Wrote manifest: ${outFile}`);
  console.log(`  routes:  ${manifest.routes.length}`);
  console.log(`  queries: ${manifest.queries.length}`);
  console.log(`  actions: ${manifest.actions.length} (${manifest.actions.filter((a) => a.requiresConfirmation).length} require confirmation)`);

  console.log("\nDetectors:");
  for (const { detector, found, skipped, failed } of results) {
    const counts = ["routes", "queries", "actions"].map((k) => (found[k] ?? []).length);
    const total = counts.reduce((a, b) => a + b, 0);
    const which = DETECTORS.find((d) => d.name === detector);
    if (failed) console.log(`  ${detector.padEnd(20)} failed: ${failed}`);
    else if (skipped) console.log(`  ${detector.padEnd(20)} does not apply to this app`);
    else if (total || (found.notes ?? []).length) console.log(`  ${detector.padEnd(20)} ${counts[0]} routes, ${counts[1]} queries, ${counts[2]} actions`);
    else console.log(`  ${detector.padEnd(20)} nothing -- looked for ${which.describe}`);
  }
  for (const note of notes) console.log(`  ${note}`);
  if (overlaid.applied.length) {
    console.log(`\n${OVERLAY_FILE}: ${overlaid.applied.length} correction(s) applied -- ${overlaid.applied.join(", ")}`);
  }
  if (excluded.length) {
    const byReason = new Map();
    for (const e of excluded) byReason.set(e.why, (byReason.get(e.why) ?? 0) + 1);
    console.log(`\n${excluded.length} endpoint(s) left out as infrastructure:`);
    for (const [why, count] of byReason) console.log(`  ${String(count).padStart(3)}  ${why}`);
    console.log(`  Name one in ${OVERLAY_FILE} to keep it.`);
  }
  for (const miss of overlaid.unmatched) {
    console.warn(`  ${OVERLAY_FILE} describes ${miss}, which no detector found. Stale, or a name that changed.`);
  }

  // An action with no body fields can be addressed but carries nothing, which
  // is the failure mode most likely to look like it worked.
  const bodyless = manifest.actions.filter((a) => !a.bodyFields?.length && a.method !== "DELETE");
  if (bodyless.length) {
    console.warn(`\n${bodyless.length} write action(s) have no body fields: ${bodyless.map((a) => a.name).join(", ")}`);
    console.warn("  They can be called but cannot change anything. Add a schema, or fill in bodyFields by hand.");
  }

  if (uncalled.length) {
    console.log(`\n${uncalled.length} operation(s) the app's own code never calls:`);
    console.log(`  ${uncalled.slice(0, 12).join(", ")}${uncalled.length > 12 ? `, and ${uncalled.length - 12} more` : ""}`);
    console.log(`  Schedulers, webhooks, public API endpoints and dead code look like this.`);
    console.log(`  A strong hint about what to leave out of "include", not a verdict.`);
  }

  const toolCount = manifest.queries.length + manifest.actions.length;
  if (toolCount > 40 && !overlaid.include) {
    // The tool list rides in the session prompt, so this is a real bill and a
    // real ask of the model, not a tidiness concern.
    const tokens = Math.round(JSON.stringify(manifest).length / 4);
    console.warn(`\n${toolCount} tools is a lot: roughly ${tokens} tokens of prompt prefix, paid on the first`);
    console.warn(`  response of EVERY session, and ${toolCount} choices for the model on every turn.`);
    console.warn(`  Add an "include": ["name", ...] array to ${OVERLAY_FILE} to choose which ones ship.`);
  }

  if (conflicts.length) {
    console.warn(`\n${conflicts.length} disagreement(s) between detectors:`);
    for (const c of conflicts) console.warn(`  ${c.kind} ${c.key} (${c.between.join(" vs ")}): ${c.differences.join("; ")}`);
    console.warn("  Nothing was silently picked. Check which reading is right.");
  }

  if (manifest.routes.length + manifest.queries.length + manifest.actions.length === 0) {
    console.warn(`\nNothing was extracted. Every detector and what it looks for is listed above;` +
      ` an app matching none of them still has the widget's DOM tools.`);
  }
  return sources;
}

main();
