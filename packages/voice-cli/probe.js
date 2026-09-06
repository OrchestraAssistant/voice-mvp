#!/usr/bin/env node
/**
 * Asks the running app whether the manifest is true.
 *
 *   node probe.js .voice/manifest.json http://localhost:3000 [options]
 *
 *   --cookie "<header>"   send a session cookie, so authenticated pages answer
 *   --header "K: V"       any other header, repeatable
 *   --writes              also probe write actions by omitting required fields
 *   --fix                 write what was learned into manifest.overlay.json
 *
 * Not part of `npm test`: it needs a live app, it makes real requests, and
 * with --writes it makes real writes. Run it deliberately, against an instance
 * you can throw away.
 */
import fs from "node:fs";
import path from "node:path";

import { describeShape, omissionProbes, readOmission, readOnlyPlan, readRoute } from "./core/probe.js";
import { OVERLAY_FILE } from "./core/overlay.js";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
// Flags that take a value, so their value is not mistaken for a positional.
const VALUED = new Set(["--cookie", "--header"]);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) i++;
  else if (!argv[i].startsWith("--")) positional.push(argv[i]);
}
const [manifestPath, baseUrl] = positional;
if (!manifestPath || !baseUrl) {
  console.error("usage: probe.js <manifest.json> <baseUrl> [--cookie ...] [--header 'K: V'] [--writes] [--fix]");
  process.exit(1);
}

const headers = {};
if (flag("--cookie")) headers.Cookie = flag("--cookie");
// Repeatable, so each occurrence is read rather than only the first.
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--header" || !argv[i + 1]) continue;
  const [key, ...rest] = argv[++i].split(":");
  headers[key.trim()] = rest.join(":").trim();
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
const ask = async (method, url, body) => {
  try {
    const res = await fetch(new URL(url, baseUrl), {
      method,
      redirect: "manual",
      headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null; // an HTML page, which is normal for a route
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 0, error: err.message };
  }
};

const problems = [];
const learned = { queries: [], actions: [] };

async function main() {
  console.log(`Probing ${manifest.routes?.length ?? 0} routes and ${manifest.queries?.length ?? 0} queries against ${baseUrl}\n`);

  let reachable = 0;
  let skipped = 0;
  for (const probe of readOnlyPlan(manifest)) {
    if (probe.skipped) {
      skipped++;
      continue;
    }
    const { status, body, error } = await ask(probe.method, probe.url);
    if (error) {
      problems.push(`${probe.kind} ${probe.name}: could not reach the app (${error})`);
      continue;
    }

    if (probe.kind === "route") {
      const verdict = readRoute(status);
      if (verdict.ok) reachable++;
      else problems.push(`route ${probe.name}: ${verdict.why}`);
      continue;
    }

    // A query answers two questions at once: is it there, and what does it
    // return -- the second being something the manifest cannot say today.
    const verdict = readRoute(status);
    if (!verdict.ok) {
      problems.push(`query ${probe.name} (${probe.url}): ${verdict.why}`);
      continue;
    }
    reachable++;
    const shape = body ? describeShape(body) : null;
    if (shape?.fields?.length || shape?.of?.length) learned.queries.push({ name: probe.name, returns: shape });
  }

  console.log(`  ${reachable} reachable, ${problems.length} problems, ${skipped} not probeable without a value`);

  if (has("--writes")) {
    console.log(`\nChecking which fields the SERVER requires. This makes real requests.`);
    for (const action of manifest.actions ?? []) {
      const probes = omissionProbes(action);
      if (!probes.length) continue;
      const corrections = [];
      for (const { omitted, body } of probes) {
        const { status } = await ask(action.method, action.endpoint, body);
        const result = readOmission(omitted, status);
        if (result.required === false) corrections.push(omitted);
      }
      if (corrections.length) {
        learned.actions.push({ name: action.name, notRequired: corrections });
        console.log(`  ${action.name}: ${corrections.join(", ")} accepted without it, though the manifest says required`);
      }
    }
  }

  if (problems.length) {
    console.log(`\n${problems.length} thing(s) the manifest is wrong about:`);
    for (const p of problems) console.log(`  ${p}`);
    console.log(`\n  Each of these is something the agent has been told exists. It will send`);
    console.log(`  someone there, confidently, and be wrong.`);
  }

  const found = learned.queries.length + learned.actions.length;
  if (found && has("--fix")) {
    const overlayPath = path.join(path.dirname(manifestPath), OVERLAY_FILE);
    const existing = fs.existsSync(overlayPath) ? JSON.parse(fs.readFileSync(overlayPath, "utf-8")) : {};
    const merged = { ...existing };
    // Into the OVERLAY, never the generated file: what a probe learned is a
    // correction, it survives regeneration, and a human can read the diff.
    for (const { name, returns } of learned.queries) {
      merged.queries = upsert(merged.queries ?? [], { name, returns });
    }
    for (const { name, notRequired } of learned.actions) {
      const action = manifest.actions.find((a) => a.name === name);
      const bodyFields = (action.bodyFields ?? []).map((f) =>
        notRequired.includes(f.name) ? { ...f, required: false } : f,
      );
      merged.actions = upsert(merged.actions ?? [], { name, bodyFields });
    }
    fs.writeFileSync(overlayPath, JSON.stringify(merged, null, 2));
    console.log(`\nWrote ${found} correction(s) to ${overlayPath}`);
  } else if (found) {
    console.log(`\n${found} thing(s) learned. Re-run with --fix to write them into ${OVERLAY_FILE}.`);
  }

  process.exit(problems.length ? 1 : 0);
}

function upsert(list, patch) {
  const existing = list.find((i) => i.name === patch.name);
  if (existing) {
    Object.assign(existing, patch);
    return list;
  }
  return [...list, patch];
}

main();
