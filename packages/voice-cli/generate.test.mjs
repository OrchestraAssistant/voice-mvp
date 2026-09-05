import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "generate.js");

/** A throwaway app directory, since every case here is about what the tool
 *  does when run from somewhere that is not this repo. */
function app(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "voice-cli-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

// Both streams, always. The diagnostics are warnings, so a helper that reads
// only stdout sees a successful run as silent -- which is what it is NOT.
const run = (cwd, args = []) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

describe("running it the way a consumer would", () => {
  test("defaults resolve from the caller's directory, not from the package", () => {
    // The bug this exists for: the defaults used to resolve relative to
    // generate.js, to a sibling demo-app that exists in this repo and nowhere
    // else. `npx @yourco/voice-cli` therefore worked for us and for no one who
    // installed it, and nothing caught that because our own invocation passed
    // explicit paths through a workspace script.
    const root = app({ "src/App.jsx": '<Route path="/things" element={<Things/>} />' });
    const { code } = run(root);
    assert.equal(code, 0);
    assert.ok(existsSync(join(root, ".voice/manifest.json")), "wrote nothing where the caller stands");
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.deepEqual(manifest.routes, [{ path: "/things", component: "Things" }]);
  });

  test("explicit paths still win", () => {
    const root = app({ "app/App.jsx": '<Route path="/x" element={<X/>} />' });
    assert.equal(run(root, ["app", "out"]).code, 0);
    assert.ok(existsSync(join(root, "out/manifest.json")));
  });

  test("a source directory that was asked for and is not there is an error", () => {
    // An explicit path that does not exist is a typo. A MISSING `src/` is not:
    // plenty of apps keep their source at the root, so that falls back to `.`
    // rather than refusing to run.
    const { code, out } = run(app(), ["definitely-not-here"]);
    assert.equal(code, 1);
    assert.match(out, /No source directory/);
    assert.doesNotMatch(out, /ENOENT|at Object\./, "raw exception leaked to the user");
  });

  test("an app it cannot read names every detector and what each looked for", () => {
    // Finding nothing is a legitimate outcome -- the widget still has its DOM
    // tools -- but silence about why is how a user concludes the product is
    // broken. Every detector reports, including the ones that found nothing.
    const root = app({ "src/main.tsx": "export const nothing = 1;", "package.json": "{}" });
    const { code, out } = run(root);
    assert.equal(code, 0, "an unrecognised app is not an error");
    for (const detector of ["react-router", "next-app-router", "next-pages-router", "request-hooks", "zod-bodies"]) {
      assert.match(out, new RegExp(detector), `${detector} did not report at all`);
    }
    assert.match(out, /Nothing was extracted/);
  });

  test("--help explains itself without needing an app at all", () => {
    const { code, out } = run(app(), ["--help"]);
    assert.equal(code, 0);
    assert.match(out, /npx @yourco\/voice-cli/);
  });
});

describe("what gets published", () => {
  test("the allowlist ships the binary and nothing else", () => {
    // The runtime package restricts itself to dist/; this one shipped whatever
    // happened to be in the directory.
    const pkg = JSON.parse(readFileSync(join(dirname(CLI), "package.json"), "utf8"));
    assert.deepEqual(pkg.files, ["generate.js"]);
    assert.equal(pkg.bin["voice-cli"], "./generate.js");
  });
});

describe("detectors are separate and additive", () => {
  test("Next.js routes come from the filesystem, both routers at once", () => {
    // An app mid-migration genuinely has both, which is the common case rather
    // than an edge one. Groups in parentheses organise files without appearing
    // in the URL; [param] is dynamic; @slot is a parallel route rendered into
    // a layout rather than navigated to.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "16.0.0" } }),
      "app/page.tsx": "export default function P(){}",
      "app/(main)/bookings/[status]/page.tsx": "export default function P(){}",
      "app/@modal/thing/page.tsx": "export default function P(){}",
      "app/docs/[...slug]/page.tsx": "export default function P(){}",
      "pages/legacy/[id].tsx": "export default function P(){}",
      "pages/_app.tsx": "export default function P(){}",
      "pages/api/thing.ts": "export default function h(){}",
    });
    const { out } = run(root, ["."]);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const paths = manifest.routes.map((r) => r.path).sort();

    assert.ok(paths.includes("/"), "the root page");
    assert.ok(paths.includes("/bookings/:status"), "route group dropped, [param] converted");
    assert.ok(paths.includes("/docs/*"), "catch-all became a wildcard");
    assert.ok(paths.includes("/legacy/:id"), "the Pages Router was read too");
    assert.ok(!paths.some((p) => p.includes("@modal")), "a parallel route is not a destination");
    assert.ok(!paths.some((p) => p.includes("_app")), "framework plumbing is not a destination");
    assert.ok(!paths.some((p) => p.startsWith("/api")), "API routes are not pages");
    assert.match(out, /next-app-router/);
  });

  test("a plain React app with a pages/ folder is not a Next.js app", () => {
    // This fired for real: the demo app keeps components in src/pages/, a
    // directory name with no framework meaning, and the Pages Router detector
    // claimed four routes from it. A detector firing on a coincidence is worse
    // than one finding nothing, because the result looks real.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "src/pages/Dashboard.jsx": "export default function D(){}",
    });
    const { out } = run(root);
    assert.match(out, /next-pages-router\s+does not apply/);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.deepEqual(manifest.routes, []);
  });

  test("a query string in a ternary is a parameter, not part of the path", () => {
    // The real shape: `${BASE}/tasks${search ? `?search=${search}` : ""}`.
    // The ternary is not an identifier, and the old reader emitted it as
    // {param1} marked REQUIRED, producing "/api/tasks{param1}" -- an endpoint
    // no request could satisfy. The name is legible in the nested template.
    const root = app({
      "package.json": "{}",
      "src/api.js": `
        const BASE = "/api";
        async function request(url, options) {}
        export function useTasks(search) {
          return useQuery({ queryFn: () => request(\`\${BASE}/tasks\${search ? \`?search=\${search}\` : ""}\`) });
        }`,
    });
    run(root);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const tasks = manifest.queries.find((q) => q.name === "tasks");
    assert.equal(tasks.endpoint, "/api/tasks", "the unreadable expression leaked into the path");
    assert.deepEqual(tasks.params, [{ name: "search", type: "string", required: false, source: "query-string" }]);
  });

  test("the source a param carries is one the widget actually acts on", () => {
    // It used to emit "hook-arg", which nothing reads, so every filter it
    // found was dropped silently at request time.
    const root = app({
      "package.json": "{}",
      "src/api.js": `
        async function request(url) {}
        export const useThing = (id) => useQuery({ queryFn: () => request(\`/api/things/\${id}\`) });`,
    });
    run(root);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.equal(manifest.queries[0].name, "thing", "an arrow-function hook was skipped");
    assert.deepEqual(manifest.queries[0].params[0].source, "url");
  });

  test("a write action with no body is called out, not shipped quietly", () => {
    const root = app({
      "package.json": "{}",
      "src/api.js": `
        async function request(url, o) {}
        export function useUpdateThing() {
          return useMutation({ mutationFn: (v) => request("/api/things/1", { method: "PUT" }) });
        }`,
    });
    const { out } = run(root);
    assert.match(out, /no body fields/);
    assert.match(out, /cannot change anything/);
  });
});

describe("hand corrections survive regeneration", () => {
  test("the overlay is read, not overwritten", () => {
    // The generated file used to carry a field asking people not to run the
    // generator again, because doing so destroyed their corrections. That is a
    // workflow that punishes improving the thing.
    const root = app({
      "package.json": "{}",
      "src/api.js": `
        async function request(url) {}
        export function useTasks() { return useQuery({ queryFn: () => request("/api/tasks") }); }`,
      ".voice/manifest.overlay.json": JSON.stringify({
        queries: [{ name: "tasks", description: "List every task, newest first" }],
      }),
    });
    const { out } = run(root);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.equal(manifest.queries[0].description, "List every task, newest first");
    assert.match(out, /1 correction\(s\) applied/);
    // And the overlay itself is untouched.
    const overlay = JSON.parse(readFileSync(join(root, ".voice/manifest.overlay.json"), "utf8"));
    assert.equal(overlay.queries[0].description, "List every task, newest first");
  });

  test("an overlay can describe what no detector found", () => {
    // The escape hatch that matters: an app whose data layer nothing
    // understands can still be described entirely by hand.
    const root = app({
      "package.json": "{}",
      ".voice/manifest.overlay.json": JSON.stringify({
        actions: [{ name: "archive", method: "POST", endpoint: "/api/archive", description: "Archive it", params: [], bodyFields: [] }],
      }),
    });
    const { out } = run(root);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.equal(manifest.actions[0].name, "archive");
    assert.match(out, /which no detector found/, "adding by hand should be visible, not silent");
  });

  test("a stale overlay entry is reported rather than silently added", () => {
    const root = app({
      "package.json": "{}",
      ".voice/manifest.overlay.json": JSON.stringify({ queries: [{ name: "renamedAwayLongAgo", description: "x" }] }),
    });
    const { out } = run(root);
    assert.match(out, /renamedAwayLongAgo/);
    assert.match(out, /Stale, or a name that changed/);
  });
});

describe("Next.js API layers", () => {
  test("route handlers give the URL and the method with nothing inferred", () => {
    // The easiest endpoints in any framework to read: the filesystem is the
    // URL and the exported function names are the verbs. A React Router app
    // makes us infer both from a fetch call.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "16" } }),
      "app/api/tasks/route.ts": `
        export async function GET(req) {
          const status = req.nextUrl.searchParams.get("status");
        }
        export async function POST(req) {}`,
      "app/api/tasks/[id]/route.ts": "export async function DELETE(req) {}",
    });
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));

    const list = m.queries.find((q) => q.endpoint === "/api/tasks");
    assert.ok(list, "GET became a query");
    assert.deepEqual(list.params, [{ name: "status", type: "string", required: false, source: "query-string" }]);

    assert.ok(m.actions.some((a) => a.endpoint === "/api/tasks" && a.method === "POST"));
    const remove = m.actions.find((a) => a.method === "DELETE");
    assert.equal(remove.endpoint, "/api/tasks/{id}");
    assert.equal(remove.requiresConfirmation, true, "DELETE must be staged for confirmation");
    assert.deepEqual(remove.params, [{ name: "id", type: "string", required: true, source: "url" }]);
  });

  test("a pages API handler has its methods read out of its branches", () => {
    // One default export serves every verb and branches on req.method, so
    // there are no per-verb exports to read.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "14" } }),
      "pages/api/things/[id].ts": `
        export default function handler(req, res) {
          if (req.method === "GET") return res.json({});
          switch (req.method) { case "PUT": return res.json({}); }
        }`,
    });
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.ok(m.queries.some((q) => q.endpoint === "/api/things/{id}" && q.method === "GET"));
    assert.ok(m.actions.some((a) => a.method === "PUT"));
  });

  test("a handler with no branch is assumed to read, never to write", () => {
    // Guessing a write would invent an operation nobody wrote.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "14" } }),
      "pages/api/whatever.ts": "export default function handler(req, res) { res.json({}); }",
    });
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.equal(m.actions.length, 0);
    assert.equal(m.queries[0].method, "GET");
  });
});

describe("discovery is not exposure", () => {
  const infra = () =>
    app({
      "package.json": JSON.stringify({ dependencies: { next: "16" } }),
      "app/api/cron/reminders/route.ts": "export async function POST(){}",
      "app/api/auth/callback/route.ts": "export async function GET(){}",
      "app/api/trpc/[trpc]/route.ts": "export async function GET(){}",
      "app/api/bookings/route.ts": "export async function GET(){}",
    });

  test("machinery is left out, and said out loud", () => {
    // Reading cal.diy turned up 84 endpoints including cron jobs, OAuth
    // handshakes and webhook receivers. Nobody asks for those by voice, and
    // the tool list rides in the session prompt: they took the prefix from
    // ~2,500 tokens to ~10,900, paid on the first response of every session.
    const { out } = run(infra(), ["."]);
    assert.match(out, /left out as infrastructure/);
    assert.match(out, /scheduled jobs the app calls itself/);
    assert.match(out, /Name one in manifest\.overlay\.json to keep it/, "excluding silently would be worse than not excluding");
  });

  test("what a person would actually ask for survives", () => {
    const root = infra();
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const endpoints = [...m.queries, ...m.actions].map((x) => x.endpoint);
    assert.ok(endpoints.includes("/api/bookings"), "a real endpoint was filtered away");
    assert.ok(!endpoints.some((e) => e.startsWith("/api/cron")));
    assert.ok(!endpoints.some((e) => e.startsWith("/api/trpc")));
    assert.ok(!endpoints.some((e) => e.includes("/callback")));
  });

  test("naming one in the overlay keeps it", () => {
    // The exclusion is a default, not a verdict. Naming an endpoint in the
    // overlay is a deliberate act and outranks the policy.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "16" } }),
      "app/api/cron/reminders/route.ts": "export async function POST(){}",
      ".voice/manifest.overlay.json": JSON.stringify({
        actions: [{ name: "createCronReminders", description: "Kick off the reminder job by hand" }],
      }),
    });
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.ok(m.actions.some((a) => a.name === "createCronReminders"), "the overlay did not outrank the exclusion");
  });
});
