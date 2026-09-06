import fs from "node:fs";

/**
 * Hand corrections that survive regeneration.
 *
 * Static analysis reads structure, and structure is not intent. It can find
 * that `useUpdateTask` does `PUT /api/tasks/{id}`; it cannot know that the
 * description the model should read is "mark a task done or change its title".
 * So the generated manifest carried a field saying, in effect, please do not
 * run this tool again:
 *
 *   "handEdited": "generate overwrites this file; these corrections must be
 *                  reapplied."
 *
 * That is a workflow that punishes improving the thing. The overlay is the
 * same corrections in a file the generator READS instead of overwrites, so
 * running it again is safe and the corrections are reviewable on their own.
 *
 * Deep merge by identity -- routes by path, queries and actions by name --
 * with overlay fields winning. Adding an entry the detectors missed is
 * allowed; that is how an app the analyser cannot read still gets a manifest.
 */
export const OVERLAY_FILE = "manifest.overlay.json";

const singular = { routes: "route", queries: "query", actions: "action" };

export function applyOverlay(manifest, overlayPath) {
  if (!fs.existsSync(overlayPath)) return { applied: [], unmatched: [], named: [], include: null };

  let overlay;
  try {
    overlay = JSON.parse(fs.readFileSync(overlayPath, "utf-8"));
  } catch (err) {
    return { applied: [], unmatched: [`${OVERLAY_FILE} is not valid JSON: ${err.message}`], named: [], include: null };
  }

  const applied = [];
  const unmatched = [];
  // Anything the overlay speaks about is deliberate, so exclusion policy
  // leaves it alone -- that is how an endpoint filtered by default is kept.
  const named = [];
  for (const kind of ["routes", "queries", "actions"]) {
    for (const patch of overlay[kind] ?? []) {
      const key = kind === "routes" ? "path" : "name";
      if (kind !== "routes") named.push(patch.name);
      const target = (manifest[kind] ??= []).find((item) => item[key] === patch[key]);
      if (!target) {
        // Not an error: an app whose data layer no detector understands can
        // be described entirely by hand, and that should work.
        manifest[kind].push(patch);
        applied.push(`+${singular[kind]} ${patch[key]}`);
        unmatched.push(`${kind} "${patch[key]}"`);
        continue;
      }
      Object.assign(target, patch);
      applied.push(`${singular[kind]} ${patch[key]}`);
    }
  }
  // `include` narrows to a chosen set. On a small app the whole manifest is
  // the right answer; on a large one it is not. cal.diy yields 208 tools and
  // ~23,600 tokens of prompt prefix, paid on the first response of every
  // session -- and 208 choices is not obviously easier for a model than 20.
  // Selecting belongs to whoever knows which twenty matter.
  if (Array.isArray(overlay.include)) {
    for (const kind of ["queries", "actions"]) {
      const before = manifest[kind].length;
      manifest[kind] = manifest[kind].filter((item) => overlay.include.includes(item.name));
      const dropped = before - manifest[kind].length;
      if (dropped) applied.push(`include: kept ${manifest[kind].length} of ${before} ${kind}`);
    }
  }
  return { applied, unmatched, named, include: overlay.include ?? null };
}
