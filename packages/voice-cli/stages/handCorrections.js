import path from "node:path";
import { OVERLAY_FILE, applyOverlay } from "../core/overlay.js";

/**
 * Corrections a person wrote, and the list of what should ship.
 *
 * A policy: it changes what the manifest says rather than discovering
 * anything. Runs before exclusions, because naming something in the overlay is
 * a deliberate act that outranks a default.
 *
 * The generated manifest used to carry a field asking people not to run the
 * generator again, because doing so destroyed their corrections. This is that
 * file, read instead of overwritten.
 */
export const handCorrections = {
  name: "hand-corrections",
  role: "policy",
  describe: `${OVERLAY_FILE}: descriptions, fixes, and an include list`,

  run({ outDir, manifest }) {
    const result = applyOverlay(manifest, path.join(outDir, OVERLAY_FILE));
    const notes = [];
    if (result.applied.length) notes.push(`${result.applied.length} correction(s) from ${OVERLAY_FILE}`);
    for (const miss of result.unmatched) notes.push(`${OVERLAY_FILE} describes ${miss}, which no detector found`);
    return { notes, named: result.named, include: result.include };
  },
};
