import { motion, AnimatePresence } from "framer-motion";
import { ScreenOverlay } from "./ScreenOverlay.jsx";

/**
 * The animated rainbow rim around the screen edge, signaling real listening
 * state.
 *
 * "base" (see ListeningGlow.base.jsx) is a literal 1:1 port of the pasted
 * Skiper86 component. Confirmed reason it blocks content: its stacking
 * relies on real content sitting *above* the glow (their button wrapper
 * has an explicit z-2) over a mostly-empty demo box -- a setup that can't
 * work for a page where content fills the entire viewport edge to edge.
 * See ListeningGlow.base.jsx's header for the full breakdown.
 *
 * Everything here is the original's -- same four colors, same 5s linear
 * angle sweep, same viewport-sized gradient box, same alpha falloff. The
 * ONE substitution is how the middle is hidden: the original covers it with
 * an opaque `bg-muted` rectangle, which is exactly what makes it unusable
 * over a real app, so that cover is reproduced as a mask instead. See
 * FALLOFF below for the arithmetic tying the two together.
 *
 * It renders through <ScreenOverlay>, not into the host app's tree, and
 * carries the CSS below with it instead of expecting a stylesheet to exist
 * -- so it draws over a host app whose markup and CSS we've never seen.
 * That file's header has the reasoning.
 */

/* The original's exact four stops, in order. No wrapping fifth stop: the
   animation rotates the gradient's *angle* across a viewport-sized box, so
   the two ends sit on opposite screen edges and never meet at a seam. */
const COLORS = "rgb(59, 130, 246), rgb(168, 85, 247), rgb(239, 68, 68), rgb(249, 115, 22)";

/**
 * How the rim fades inward, as [distance from the screen edge, alpha].
 *
 * This is not hand-tuned -- it's the original's cover, solved. There, a
 * `bg-muted` rectangle inset 2px with `blur-xl` (Tailwind: `blur(24px)`,
 * i.e. a Gaussian with a 24px standard deviation) sits over a sharp
 * rainbow. A blurred hard edge is an error function, so the fraction of
 * gradient still showing at distance d from the screen edge is
 *
 *     visible(d) = 1 - Φ((d - 2) / 24)
 *
 * evaluated below. Two things fall out of it that are easy to get wrong:
 *
 *   - The peak is 0.53, NOT 1. At the very edge the blurred cover is
 *     already ~47% opaque, so even the brightest part of the reference rim
 *     is a little over half strength. Taking the mask to full alpha (the
 *     previous version did) is precisely why ours read as more intense than
 *     the original.
 *   - The tail is long and very faint -- still ~4% at 44px, not gone until
 *     ~80px. A Gaussian doesn't stop where a linear ramp would.
 *
 * Over a light page the two are equivalent: compositing a `bg-muted` cover
 * at (1 - visible) is the same result as masking to `visible` and letting a
 * near-white page show through. Over a dark app they differ, and the mask
 * is the one that's still correct.
 */
const FALLOFF = [
  [0, 0.53],
  [4, 0.47],
  [8, 0.4],
  [14, 0.31],
  [20, 0.23],
  [26, 0.16],
  [34, 0.09],
  [44, 0.04],
  [56, 0.012],
  [68, 0.003],
  [80, 0],
];

/* One axis of the mask: strongest at both edges, transparent through the
   middle. Pixel stops throughout -- "20px" means exactly that, with none of
   the percentage/aspect-ratio reinterpretation that made earlier
   radial-gradient attempts come out at the wrong scale. */
function edgeMask(direction) {
  const stops = [
    ...FALLOFF.map(([px, alpha]) => `rgba(0, 0, 0, ${alpha}) ${px}px`),
    ...[...FALLOFF].reverse().map(([px, alpha]) => `rgba(0, 0, 0, ${alpha}) calc(100% - ${px}px)`),
  ];
  return `linear-gradient(to ${direction}, ${stops.join(", ")})`;
}

/* Scoped inside the overlay's shadow root, so these class names are ours
   alone and can't collide with the host app's.

   The horizontal and vertical masks are unioned with `mask-composite: add`,
   which is source-over -- 1-(1-x)(1-y), not saturating addition. That
   matters at the corners: it lands them at 1-(1-0.53)^2 = 0.78, which is
   what the original's separable 2D blur gives there too (0.47 x 0.47
   covered). Corners come out brighter than the edges in both, by the same
   amount, without clipping. */
const GLOW_CSS = `
  .frame {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;

    -webkit-mask-image: ${edgeMask("right")}, ${edgeMask("bottom")};
    -webkit-mask-composite: source-over, source-over;
    mask-image: ${edgeMask("right")}, ${edgeMask("bottom")};
    mask-composite: add, add;
  }

  /* Viewport-sized, exactly like the original's \`absolute size-full\`. The
     sweep is the gradient's angle animating 0->360deg, not a rotating
     plane: at every moment all four colors are mapped across the screen
     along the current axis, which is what gives each edge its spread of
     color instead of one stretched-out band. */
  .sweep {
    position: absolute;
    inset: 0;
  }
`;

export function ListeningGlow({ active }) {
  return (
    <ScreenOverlay css={GLOW_CSS} active={active}>
      <AnimatePresence>
        {active && (
          <motion.div
            className="frame"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeInOut" }}
          >
            <motion.div
              className="sweep"
              animate={{
                background: [
                  `linear-gradient(0deg, ${COLORS})`,
                  `linear-gradient(360deg, ${COLORS})`,
                ],
              }}
              transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </ScreenOverlay>
  );
}

/**
 * Derives "is the mic actually capturing audio right now" from mode +
 * connection + hold state. Not the same thing as `status === "connected"`:
 * ptt only listens while held, ptnt listens except while held.
 */
export function isListening({ status, mode, holding }) {
  if (status !== "connected") return false;
  if (mode === "ptt") return holding;
  if (mode === "ptnt") return !holding;
  return true; // continuous
}
