import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The single mount point for every piece of widget chrome -- the listening
 * rim and the floating panel -- that has to survive a host app we don't
 * control and can't read the source of.
 *
 * A plain `position: fixed; z-index: 9999` div rendered inside the host's
 * own tree loses to three separate things, and a host app is free to do all
 * three without ever knowing we exist:
 *
 *   1. Stacking context. Any ancestor with its own z-index, opacity < 1,
 *      transform, filter, backdrop-filter, isolation or will-change starts a
 *      new stacking context, and our z-index is then only ever compared
 *      against our siblings *inside* it. A host element painted later wins
 *      no matter how big our number is.
 *   2. Containing block. `transform`, `filter`, `perspective`,
 *      `backdrop-filter`, `contain: paint/layout` or `will-change` on any
 *      ancestor re-roots `position: fixed` onto that ancestor -- so
 *      `inset: 0` silently stops meaning "the viewport" and starts meaning
 *      "some div two thirds down the page".
 *   3. The cascade. Class names collide, and the host's `* {}` reset and its
 *      `!important` rules apply to our nodes exactly as readily as to its own.
 *
 * So this doesn't try to out-number the host. It steps outside it:
 *
 *   - mounted as a direct child of <body>, outside the host's React tree, so
 *     it has no ancestors to inherit a broken containing block from;
 *   - styling lives in a shadow root, which the host's stylesheets cannot
 *     select into (a happy side effect: our own dom_snapshot/dom_click
 *     fallback tools walk the light DOM with querySelectorAll, which does not
 *     descend into a shadow root open or closed, so the interpreter never
 *     sees its own chrome as part of the page);
 *   - the box is pinned with inline `!important` declarations, which outrank
 *     every author rule a host can write -- including its own `!important`;
 *   - and where the browser has it, the element promotes itself into the
 *     *top layer* via the popover API. The top layer paints above the entire
 *     document and ignores ancestor stacking/containing blocks by
 *     construction -- immunity to 1 and 2 by rule rather than by out-bidding.
 *
 * `pointer-events: none` throughout: the host app underneath stays fully
 * clickable, which is the whole point of an ambient indicator. The panel is
 * the one part that wants clicks, so it opts back in for its own subtree.
 *
 * There is exactly ONE of these, mounted by <VoiceProvider>, with an ordered
 * layer per piece of chrome. See LAYERS for why that is not a detail.
 */

/**
 * Every property a host page could use to move, clip, shrink, hide or
 * re-stack a <div> it doesn't know about. Set as inline !important, so a
 * host `* { position: static !important }` style reset can't reach us.
 */
const PINNED = {
  // Box: exactly the viewport, wherever the host thinks our parent is.
  position: "fixed",
  top: "0px",
  right: "0px",
  bottom: "0px",
  left: "0px",
  width: "auto",
  height: "auto",
  "min-width": "0px",
  "min-height": "0px",
  "max-width": "none",
  "max-height": "none",
  margin: "0px",
  padding: "0px",
  border: "0px",
  // Paint: nothing of our own, and nothing inherited from a host reset.
  background: "none",
  "box-shadow": "none",
  "mix-blend-mode": "normal",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  filter: "none",
  "backdrop-filter": "none",
  "clip-path": "none",
  contain: "none",
  display: "block",
  visibility: "visible",
  opacity: "1",
  overflow: "visible",
  // Behaviour. `display: block` above also doubles as the fallback for the
  // UA's `[popover]:not(:popover-open) { display: none }` -- if showPopover()
  // isn't available or throws, we stay visible as an ordinary fixed element
  // at the top of the z-index range.
  "pointer-events": "none",
  "z-index": "2147483647",
  isolation: "isolate",
};

/**
 * Enter (or re-enter) the top layer. The top layer is a stack -- whatever
 * opened last paints last -- so re-entering is how we get back above a host
 * dialog or popover that opened after us.
 */
function raise(host) {
  if (typeof host.showPopover !== "function") return false;
  try {
    host.hidePopover();
  } catch {
    // Not currently open; nothing to leave.
  }
  try {
    host.showPopover();
    return true;
  } catch {
    return false; // Falls back to the inline fixed/z-index styling.
  }
}

/**
 * The layers inside the overlay, in paint order: earlier sits below.
 *
 * There is ONE overlay host for the whole widget, and this is why. The top
 * layer is a plain stack -- last to showPopover() paints last -- so two hosts
 * of ours could not agree an order without each watching for the other and
 * re-raising itself, which is a feedback loop: our raise fires a toggle, the
 * other answers with a raise, which fires a toggle. Measured at ~1800 events
 * a second, seen as the panel flickering above and below the rim.
 *
 * Sharing one host deletes the question instead of managing it. Both layers
 * are ordinary siblings in one tree, so paint order is DOM order, decided
 * here, once, and nothing has to fight for it at runtime.
 */
const LAYERS = ["rim", "panel"];

const OverlayContext = createContext(null);

function mount() {
  const host = document.createElement("div");
  host.setAttribute("data-interpreter-overlay", "");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("popover", "manual"); // "manual" => no light-dismiss, no
  // backdrop darkening, and it never closes anything else the host has open.
  for (const [prop, value] of Object.entries(PINNED)) {
    host.style.setProperty(prop, value, "important");
  }

  // OPEN, not closed. The difference is narrower than it looks and runs the
  // wrong way. Closed buys exactly two things over open: `host.shadowRoot` is
  // null, and composedPath() truncates at the boundary. Everything the
  // isolation is actually FOR survives either way -- outside CSS still cannot
  // select in, document.querySelectorAll still does not descend (so our own
  // dom_snapshot fallback still never sees the widget's chrome as page
  // content), and inherited properties still cross.
  //
  // What closed costs is larger. It forces the click-outside check onto a
  // workaround, since neither contains() nor composedPath() can see in. It
  // makes the configuration that actually ships unreachable by devtools,
  // selectors and tests -- which is how a resize fix got verified only at
  // mount="inline" and shipped broken. And it is not a security boundary
  // regardless: a host that wants in patches Element.prototype.attachShadow
  // before our script loads, which is six lines. Closed charged real
  // debuggability for the appearance of a guarantee it could not make.
  const shadow = host.attachShadow({ mode: "open" });

  // One container per layer, created up front in order. `display: contents`
  // so they generate no box at all and cannot affect layout; they exist
  // purely to fix the order their contents paint in.
  const layers = {};
  for (const name of LAYERS) {
    const el = document.createElement("div");
    el.setAttribute("data-overlay-layer", name);
    el.style.display = "contents";
    shadow.append(el);
    layers[name] = el;
  }

  const parent = document.body || document.documentElement;
  parent.append(host);

  // A host that wipes or replaces <body> (`body.innerHTML = ""`, a hard
  // re-render, a router that owns the document) would take us with it.
  // Watching body's *direct* children only -- this fires on the rare
  // structural change, not on every render inside the app.
  const reattach = new MutationObserver(() => {
    if (!host.isConnected) {
      (document.body || document.documentElement).append(host);
      raise(host);
    }
  });
  reattach.observe(parent, { childList: true });

  return {
    host,
    shadow,
    layers,
    dispose() {
      reattach.disconnect();
      try {
        host.hidePopover();
      } catch {
        // Already closed.
      }
      host.remove();
    },
  };
}

/**
 * Mounts the single overlay every piece of widget chrome draws into: a
 * viewport-sized box, in a shadow root, as a direct child of <body>, above an
 * unknown host app. Rendered by <VoiceProvider>, so consumers never place it.
 *
 * It stays mounted for the life of the app -- exit animations need somewhere
 * to finish. What comes and goes is whether we fight for the top of the
 * top-layer stack, which is driven by whether any layer currently claims to
 * be active: an idle indicator should never displace a host's modal, and an
 * open panel should sit above one.
 */
export function OverlayProvider({ children }) {
  const [instance, setInstance] = useState(null);
  const [claims, setClaims] = useState({});

  useEffect(() => {
    const created = mount();
    setInstance(created);
    return () => {
      setInstance(null);
      created.dispose();
    };
  }, []);

  const setClaim = useCallback((name, value) => {
    setClaims((current) => (current[name] === value ? current : { ...current, [name]: value }));
  }, []);

  const active = Object.values(claims).some(Boolean);

  useEffect(() => {
    if (!instance || !active) return;
    const { host } = instance;

    // Raising on activation covers anything the host already had open.
    raise(host);

    // From here on, anything else entering the top layer paints over us --
    // the top layer is a stack and it opened later, which no z-index can
    // answer. So watch for it and re-enter above it. Two mechanisms, because
    // neither alone covers both kinds:
    //
    //   - `toggle` catches native popovers. It doesn't bubble, but a
    //     capture-phase listener still sees it on the way down.
    //   - `showModal()` sets the `open` attribute, which is observable on
    //     every version; its `toggle` event only shipped in 2025 browsers,
    //     and a host on an older engine would otherwise silently cover us.
    //     Attribute-filtered observation is cheap -- it fires on `open`
    //     changing somewhere, not on the host app's ordinary re-renders.
    //
    // Skipping our own host is all the guard this needs now that there is
    // only one of them. With two, this same listener was a mutual-raise loop.
    const onToggle = (event) => {
      if (event.target === host || event.newState !== "open") return;
      raise(host);
    };
    document.addEventListener("toggle", onToggle, true);

    const dialogs = new MutationObserver((records) => {
      if (records.some((r) => r.target.matches?.("dialog[open]"))) raise(host);
    });
    dialogs.observe(document.documentElement, { subtree: true, attributeFilter: ["open"] });

    return () => {
      document.removeEventListener("toggle", onToggle, true);
      dialogs.disconnect();
    };
  }, [instance, active]);

  const value = useMemo(() => ({ instance, setClaim }), [instance, setClaim]);
  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

/**
 * Claims a layer of the shared overlay and returns where to render into it.
 *
 * `active` is this layer's vote on whether the overlay should hold the top of
 * the top layer. `css` is the layer's own stylesheet, injected into the shared
 * root -- each piece of chrome carries its own styles rather than the provider
 * knowing about all of them.
 *
 * Returns `{ container, root }`. `container` is the portal target. `root` is
 * the shadow root, which callers need because a shadow root is its own style
 * scope: anything injecting a stylesheet at runtime must be told to put it
 * here rather than in `document.head`, where it would silently not apply.
 * framer-motion's AnimatePresence takes it as `root` for exactly that reason.
 */
export function useOverlayLayer(name, { active = false, css } = {}) {
  const context = useContext(OverlayContext);
  if (!context) {
    throw new Error("Widget chrome must be rendered inside <VoiceProvider>, which mounts the overlay.");
  }
  const { instance, setClaim } = context;

  useEffect(() => {
    setClaim(name, active);
    return () => setClaim(name, false);
  }, [name, active, setClaim]);

  useEffect(() => {
    if (!instance || !css) return;
    const style = document.createElement("style");
    style.textContent = css;
    // Ahead of the layer containers, so author order inside the root is
    // stylesheets first and content after.
    instance.shadow.prepend(style);
    return () => style.remove();
  }, [instance, css]);

  return {
    container: instance?.layers[name] ?? null,
    root: instance?.shadow ?? null,
  };
}

/** Renders `children` into one layer of the shared overlay. */
export function OverlayLayer({ name, active, css, children }) {
  const { container } = useOverlayLayer(name, { active, css });
  return container ? createPortal(children, container) : null;
}
