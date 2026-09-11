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

// v1 loads only the content script (the widget in the page). background/offscreen
// are the cross-tab future path -- kept in src/, not built into the shipped v1.
const entries = [{ entryPoints: ["src/content.js"], outfile: "dist/content.js" }];

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
