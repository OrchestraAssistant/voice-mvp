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

  test("a missing source directory is a diagnosis, not a stack trace", () => {
    const { code, out } = run(app());
    assert.equal(code, 1);
    assert.match(out, /No source directory/);
    assert.doesNotMatch(out, /ENOENT|at Object\./, "raw exception leaked to the user");
  });

  test("an app it cannot read says what it looked for", () => {
    // It reads one specific layout. Finding nothing is a legitimate outcome --
    // the widget still has its DOM fallback -- but silence about why is how a
    // user concludes the product is broken.
    const root = app({ "src/main.tsx": "export const nothing = 1;" });
    const { code, out } = run(root);
    assert.equal(code, 0, "an unrecognised app is not an error");
    assert.match(out, /src\/App\.jsx/);
    assert.match(out, /src\/api\.js/);
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
