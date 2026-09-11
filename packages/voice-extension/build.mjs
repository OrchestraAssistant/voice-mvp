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
  // The extension ships to a browser; keep it small but debuggable.
  sourcemap: true,
};

const entries = [
  { entryPoints: ["src/content.js"], outfile: "dist/content.js" },
  { entryPoints: ["src/background.js"], outfile: "dist/background.js" },
  { entryPoints: ["src/offscreen.js"], outfile: "dist/offscreen.js" },
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
