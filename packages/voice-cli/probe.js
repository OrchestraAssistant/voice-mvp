#!/usr/bin/env node
/**
 * Asks the running app whether the manifest is true.
 *
 *   node probe.js .voice/manifest.json http://localhost:3000 [options]
 *
 *   --login <spec.json>   sign in first, so authenticated pages answer. In a
 *                         file, not an argument: credentials in a command end
 *                         up in shell history.
 *   --cookie "<header>"   send a session cookie you already have
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

import { describePages, describeShape, harvestPage, omissionProbes, readOmission, readOnlyPlan, readRoute } from "./core/probe.js";
import { OVERLAY_FILE } from "./core/overlay.js";
import { cookieJar, pick, signedIn } from "./core/session.js";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
// Flags that take a value, so their value is not mistaken for a positional.
const VALUED = new Set(["--cookie", "--header", "--login"]);
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
  console.error("usage: probe.js <manifest.json> <baseUrl> [--login spec.json] [--cookie ...] [--header 'K: V'] [--writes] [--fix]");
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
const jar = cookieJar();
if (headers.Cookie) jar.absorb([headers.Cookie]);

const ask = async (method, url, body, form) => {
  try {
    const cookie = jar.header();
    const res = await fetch(new URL(url, baseUrl), {
      method,
      redirect: "manual",
      headers: {
        ...headers,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
    });
    // Every response can extend the session, not just the login one.
    jar.absorb(res.headers.getSetCookie?.() ?? []);
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null; // an HTML page, which is normal for a route
    }
    return { status: res.status, body: parsed, text };
  } catch (err) {
    return { status: 0, error: err.message };
  }
};

const problems = [];
const learned = { routes: [], queries: [], actions: [] };
const harvested = [];

/**
 * Signs in before probing, if asked. Without a session most routes answer
 * with a redirect to a login page, which says only that the app has
 * authentication.
 */
async function signIn(specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
  const before = jar.size();
  const fields = { ...(spec.post?.form ?? spec.post?.json ?? {}) };

  if (spec.csrf) {
    const { body } = await ask("GET", spec.csrf.url);
    const token = pick(body, spec.csrf.pick);
    if (!token) throw new Error(`no ${spec.csrf.pick} at ${spec.csrf.url}`);
    fields[spec.csrf.as ?? spec.csrf.pick] = token;
  }

  const { status } = spec.post.json
    ? await ask("POST", spec.post.url, fields)
    : await ask("POST", spec.post.url, undefined, fields);

  // A login endpoint answering 200 with an error in the body is the normal
  // way to fail, so the status proves nothing. A cookie that was not there
  // before proves it: a session IS a cookie.
  if (!signedIn(before, jar.size())) {
    throw new Error(`no session cookie came back (status ${status}). Credentials wrong, or the sequence does not match this app.`);
  }
}

async function main() {
  if (flag("--login")) {
    try {
      await signIn(flag("--login"));
      console.log(`Signed in; probing as a real user.\n`);
    } catch (err) {
      console.error(`Could not sign in: ${err.message}`);
      console.error(`Probing anonymously instead, which mostly measures the login page.\n`);
    }
  }
  console.log(`Probing ${manifest.routes?.length ?? 0} routes and ${manifest.queries?.length ?? 0} queries against ${baseUrl}\n`);

  let reachable = 0;
  let skipped = 0;
  for (const probe of readOnlyPlan(manifest)) {
    if (probe.skipped) {
      skipped++;
      continue;
    }
    const { status, body, text, error } = await ask(probe.method, probe.url);
    if (error) {
      problems.push(`${probe.kind} ${probe.name}: could not reach the app (${error})`);
      continue;
    }

    if (probe.kind === "route") {
      const verdict = readRoute(status);
      if (!verdict.ok) {
        problems.push(`route ${probe.name}: ${verdict.why}`);
        continue;
      }
      reachable++;
      // The page usually describes itself better than anything we could
      // invent from its filename. Collected raw; what counts as a description
      // is decided across all pages once they are all in.
      const page = harvestPage(text);
      if (page) harvested.push({ path: probe.name, ...page });
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

  learned.routes = describePages(harvested);
  if (learned.routes.length) {
    console.log(`\n${learned.routes.length} page(s) describe themselves:`);
    for (const r of learned.routes.slice(0, 6)) console.log(`  ${r.path}  "${r.description}"`);
    if (learned.routes.length > 6) console.log(`  ...and ${learned.routes.length - 6} more`);
  }

  const found = learned.routes.length + learned.queries.length + learned.actions.length;
  if (found && has("--fix")) {
    const overlayPath = path.join(path.dirname(manifestPath), OVERLAY_FILE);
    const existing = fs.existsSync(overlayPath) ? JSON.parse(fs.readFileSync(overlayPath, "utf-8")) : {};
    const merged = { ...existing };
    // Into the OVERLAY, never the generated file: what a probe learned is a
    // correction, it survives regeneration, and a human can read the diff.
    for (const { path, description } of learned.routes) {
      merged.routes = upsertBy(merged.routes ?? [], "path", { path, description });
    }
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

const upsert = (list, patch) => upsertBy(list, "name", patch);

function upsertBy(list, key, patch) {
  const existing = list.find((i) => i[key] === patch[key]);
  if (existing) {
    Object.assign(existing, patch);
    return list;
  }
  return [...list, patch];
}

main();
