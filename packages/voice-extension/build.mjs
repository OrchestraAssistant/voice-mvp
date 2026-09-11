/**
 * Bundles the three extension worlds from src/ into dist/, resolving the shared
 * core imported from ../voice/src. MV3 content scripts are not ES modules, so
 * each entry is bundled to a single self-contained file.
 */
import { build, context } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  target: "chrome120",
  logLevel: "info",
  sourcemap: true,
  // The content script bundles React + the widget; give it the production build.
  define: { "process.env.NODE_ENV": '"production"' },
};

// The persistent build: session in the offscreen document, DOM/API bridge in the
// content script, the mic granted by the popup, all routed by the worker.
const entries = [
  { entryPoints: ["src/content.js"], outfile: "dist/content.js" },
  { entryPoints: ["src/background.js"], outfile: "dist/background.js" },
  { entryPoints: ["src/offscreen.js"], outfile: "dist/offscreen.js" },
  { entryPoints: ["src/popup.js"], outfile: "dist/popup.js" },
];

const watch = process.argv.includes("--watch");

for (const entry of entries) {
  const config = { ...common, ...entry };
  if (watch) {
    const ctx = await context(config);
    await ctx.watch();
    console.log(`watching ${entry.outfile}`);
  } else {
    await build(config);
  }
}
