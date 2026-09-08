/**
 * Test-id SHAPES harvested from source, and matching a measured id back to one.
 *
 * This is the static half of a two-part trick. A `data-testid` built from a
 * template -- `data-testid={`${weekday}-switch`}` -- reaches the running page
 * as `Sunday-switch` in English and `Domingo-switch` in Spanish. The probe can
 * only ever measure the rendered value, which is locale-bound and specific to
 * whatever data happened to be on screen. But the SHAPE, `*-switch`, is right
 * there in the source, and it is the marker that actually generalises.
 *
 * So: static analysis reads the shapes (it cannot know the values), the probe
 * measures a value (it cannot know the shape), and matching one to the other
 * recovers the thing neither could produce alone -- which is the manifest
 * pipeline's whole division of labour in miniature.
 *
 * A shape is the template with every `${...}` hole turned into `*`. Kept only
 * when it has real text around the hole: `${x}` alone is `*`, which matches
 * everything and signals nothing.
 */
import { execFileSync } from "node:child_process";

/** Every distinct test-id template in the source tree, as `*`-holed shapes. */
export function testIdShapes(root) {
  if (!root) return [];
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-rhoE", "--include=*.tsx", "--include=*.jsx", "--include=*.ts", "--include=*.js",
       "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=dist",
       "data-testid=\\{`[^`]*`\\}", root],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 },
    );
  } catch {
    return []; // grep found nothing, or no grep; either way, no shapes
  }
  const shapes = new Set();
  for (const line of out.split("\n")) {
    const m = line.match(/`([^`]*)`/);
    if (!m || !m[1].includes("${")) continue;
    // Collapse every ${...} to a single *, then any run of *s to one.
    const shape = m[1].replace(/\$\{[^}]*\}/g, "*").replace(/\*+/g, "*");
    // Needs a real STEM, not just separators between holes. `${a}-${b}` becomes
    // `*-*`, whose only literal is a hyphen -- that matches nearly any
    // hyphenated id and would swallow `schedule-more`, which is not a template
    // instance at all. Require at least three alphanumeric characters of
    // literal text before a shape is allowed to stand in for a value.
    const stem = shape.replace(/\*/g, "").replace(/[^a-zA-Z0-9]/g, "");
    if (stem.length >= 3) shapes.add(shape);
  }
  return [...shapes];
}

/** Does a rendered id fit a `*`-holed shape? `*` matches one-or-more chars. */
export function shapeMatches(shape, value) {
  const re = new RegExp("^" + shape.split("*").map(escapeRe).join(".+") + "$");
  return re.test(value);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The most specific shape a measured id belongs to, or the id unchanged.
 *
 * "Most specific" = the shape with the most literal (non-`*`) characters, so
 * `*-switch` is preferred over a hypothetical `*` and a longer stem wins over
 * a shorter one. A tie or no match returns the literal: a value that fits no
 * template was not built from one, and its own text is the right marker.
 */
export function generalize(value, shapes) {
  const fits = shapes
    .filter((s) => shapeMatches(s, value) && s !== value)
    .sort((a, b) => b.replace(/\*/g, "").length - a.replace(/\*/g, "").length);
  return fits[0] ?? value;
}
