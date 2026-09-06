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

/**
 * What the rim is allowed to say. A user setting, because a rim that changes
 * colour is either informative or distracting depending entirely on who is
 * looking at it -- and it sits in their peripheral vision the whole time they
 * are working, which is not a place to impose an opinion.
 *
 *   "state"  a palette per state: prism, orchid, lagoon.
 *   "single" prism throughout, and the rim only says whether it is on.
 */
export const RIM_MODES = [
  { id: "state", label: "Colour by state", note: "3 palettes" },
  { id: "single", label: "Always prism", note: "1 palette" },
];

/** Collapses every state onto one swatch, for `rimMode: "single"`. */
export function fixedPalettes(swatch = SWATCHES.prism) {
  return Object.fromEntries(STATES.map((s) => [s, swatch]));
}

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

/**
 * OKLab: the space where a straight line looks straight.
 *
 * Two problems, one answer. sRGB dips through a muddy low-chroma middle, worst
 * on blue to green -- which is exactly the trip from listening to working.
 * Linear light fixes the mud and introduces a second fault: it is not
 * perceptually uniform, so an even ramp through it LOOKS like it accelerates.
 * Measured on orchid to lagoon with a linear ramp, the first 180ms of a 1.2s
 * fade carried 6% of the visible change and the last 120ms carried 32%, which
 * reads as a pause followed by a lunge.
 *
 * OKLab is built so that equal steps are equally visible. An even ramp through
 * it is even to the eye, and its midpoints stay saturated.
 */
const rgbToOklab = ([r8, g8, b8]) => {
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const oklabToRgb = ([L, A, B]) => {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
};

/** One colour, `t` of the way from `a` to `b`. */
export function mixColor(a, b, t, space = "oklab") {
  const from = parse(a);
  const to = parse(b);

  if (space === "oklab") {
    const [L1, A1, B1] = rgbToOklab(from);
    const [L2, A2, B2] = rgbToOklab(to);
    const [r, g, b2] = oklabToRgb([L1 + (L2 - L1) * t, A1 + (A2 - A1) * t, B1 + (B2 - B1) * t]);
    return `rgb(${r}, ${g}, ${b2})`;
  }

  const m =
    space === "srgb"
      ? (x, y) => Math.round(x + (y - x) * t)
      : (x, y) => toSrgb(toLinear(x) + (toLinear(y) - toLinear(x)) * t);
  return `rgb(${m(from[0], to[0])}, ${m(from[1], to[1])}, ${m(from[2], to[2])})`;
}

/** Two palettes, mixed stop by stop. */
export function mixPalettes(from, to, t, space = "oklab") {
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
