/**
 * The rim is the only thing on screen that says what the agent is doing, so it
 * carries the whole cycle rather than one bit of it.
 *
 * All four states are observable at runtime, which is what makes this worth
 * building: `input_audio_buffer.speech_started` / `speech_stopped` bracket the
 * user talking, `response.created` / `response.done` bracket the model
 * thinking, and `output_audio_buffer.started` / `stopped` bracket it speaking.
 *
 * No JSX in here on purpose -- these are values and a lerp, so the tuner and
 * the tests can both import them without a browser.
 */

/**
 * Named swatches, so a set of colours can be discussed and swapped without
 * anyone reciting hex codes at each other. The names are the palette's own;
 * which STATE wears which is the separate mapping below.
 */
export const SWATCHES = {
  /**
   * Electric four-hue: soft yellow, acid green, cornflower, hot magenta.
   * Very high saturation (0.97) and by far the brightest of the set.
   *
   * Currently unworn -- kept because it is a good palette and naming it is the
   * point of this object. Note its cornflower sits 3° off `prism`'s blue, so
   * the two do not belong in the same rim.
   */
  arcade: ["#F9EA62", "#5EFF1A", "#4E87F9", "#FF00C8"],

  /** The skiper86 original. Blue to purple to red to orange -- a spectrum
   *  sweep rather than a block, and the widest arc of any of them. */
  prism: ["#3B82F6", "#A855F7", "#EF4444", "#F97316"],

  /** Cyan, teal, green, lime. Cool and wet; the widest genuinely free band. */
  lagoon: ["#06B6D4", "#14B8A6", "#22C55E", "#84CC16"],

  /** A single fuchsia hue (291-295°) ramped from pale to deep by lightness
   *  alone, which makes it the only true monochrome of the four. */
  orchid: ["#F0ABFC", "#E879F9", "#D946EF", "#A21CAF"],
};

/**
 * Which swatch each state wears.
 *
 * Kept separate from the swatches so a state can be re-dressed in one line,
 * and so "prism" means a set of colours rather than a moment in a
 * conversation. A host can pass its own `palettes` and never use these.
 *
 * THREE states, not four. Thinking and speaking back were split at first, on
 * the theory that they are different things to the user. They are not
 * different in the way that matters here: both are the agent holding the
 * floor, and neither is a moment when anything the user does changes what
 * happens next. The distinction the rim has to carry is whose turn it is.
 *
 * Collapsing them also bought real separation. With four, `arcade`'s
 * cornflower sat 3° off `prism`'s blue; with three, the closest any two stops
 * get is 20°, and every palette clears the 18° guideline outright.
 */
export const PALETTES = {
  /** Connected, microphone live, nobody talking. */
  ready: SWATCHES.prism,
  /** Speech actually arriving and being forwarded. */
  listening: SWATCHES.orchid,
  /** The agent has the floor: thinking, calling tools, or speaking back. */
  working: SWATCHES.lagoon,
};

export const STATES = Object.keys(PALETTES);

/** Hue in degrees and saturation 0..1, for judging how far apart two palettes
 *  actually are. Exported because "distinct" should be measurable rather than
 *  asserted by eye -- the tuner shows it and a test enforces it. */
export function hueSat(color) {
  const [r8, g8, b8] = parse(color);
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  let h = 0;
  if (d) h = 60 * (mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return { h, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}

/** Shortest way round the wheel. */
export const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** How far this palette's nearest stop sits from any stop in `others`. */
export function nearestHue(palette, others) {
  const theirs = others.flat().map((c) => hueSat(c).h);
  return Math.min(...palette.map((c) => Math.min(...theirs.map((h) => hueGap(hueSat(c).h, h)))));
}

/** Mean saturation -- an achromatic palette is distinct without needing a hue. */
export const meanSat = (palette) => palette.reduce((a, c) => a + hueSat(c).s, 0) / palette.length;

/** Accepts "#abc", "#aabbcc" and "rgb(r, g, b)" -- a crossfade mid-flight
 *  produces the last of those, and it has to be re-parsable to interrupt. */
function parse(color) {
  if (color.startsWith("rgb")) return color.match(/\d+/g).slice(0, 3).map(Number);
  const h = color.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// sRGB is not perceptually uniform, so a straight lerp between two saturated
// hues dips through a muddy low-chroma middle -- worst on blue to green, which
// is exactly the trip from listening to working. Mixing in linear light keeps
// the midpoint bright.
const toLinear = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const toSrgb = (l) => {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
};

/** One colour, `t` of the way from `a` to `b`. */
export function mixColor(a, b, t, space = "linear") {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const m =
    space === "srgb"
      ? (x, y) => Math.round(x + (y - x) * t)
      : (x, y) => toSrgb(toLinear(x) + (toLinear(y) - toLinear(x)) * t);
  return `rgb(${m(ar, br)}, ${m(ag, bg)}, ${m(ab, bb)})`;
}

/** Two palettes, mixed stop by stop. */
export function mixPalettes(from, to, t, space = "linear") {
  return from.map((c, i) => mixColor(c, to[i] ?? c, t, space));
}

/**
 * The gradient at a given angle.
 *
 * Stops are mixed pairwise rather than two whole gradients being cross-faded
 * as stacked layers. Stacking shows BOTH rainbows at once through the middle,
 * which reads as a smear; mixing stop by stop stays one rainbow that changes
 * hue, which is what a change of state should look like.
 *
 * No wrapping fifth stop: the angle rotates across a viewport-sized box, so
 * the two ends sit on opposite screen edges and never meet at a seam.
 */
export function rimGradient(angle, stops) {
  return `linear-gradient(${angle}deg, ${stops.join(", ")})`;
}
