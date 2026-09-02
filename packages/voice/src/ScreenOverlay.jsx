import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A mount point for whole-screen widget chrome (the listening rim) that has
 * to survive a host app we don't control and can't read the source of.
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
 * So this component doesn't try to out-number the host. It steps outside it:
 *
 *   - mounted as a direct child of <body>, outside the host's React tree, so
 *     it has no ancestors to inherit a broken containing block from;
 *   - styling lives in a *closed* shadow root, which the host's stylesheets
 *     cannot select into and its scripts cannot reach (a happy side effect:
 *     our own dom_snapshot/dom_click fallback tools walk the light DOM, so
 *     the interpreter never sees its own chrome as part of the page);
 *   - the box is pinned with inline `!important` declarations, which outrank
 *     every author rule a host can write -- including its own `!important`;
 *   - and where the browser has it, the element promotes itself into the
 *     *top layer* via the popover API. The top layer paints above the entire
 *     document and ignores ancestor stacking/containing blocks by
 *     construction -- immunity to 1 and 2 by rule rather than by out-bidding.
 *
 * `pointer-events: none` throughout: the host app underneath stays fully
 * clickable, which is the whole point of an ambient indicator.
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

function mount(css) {
  const host = document.createElement("div");
  host.setAttribute("data-interpreter-overlay", "");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("popover", "manual"); // "manual" => no light-dismiss, no
  // backdrop darkening, and it never closes anything else the host has open.
  for (const [prop, value] of Object.entries(PINNED)) {
    host.style.setProperty(prop, value, "important");
  }

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.append(style);

  const parent = document.body || document.documentElement;
  parent.append(host);
  raise(host);

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
 * Portals `children` into a viewport-sized overlay that sits above an unknown
 * host app. `active` doesn't gate rendering -- the overlay stays mounted so
 * exit animations can finish -- it gates only whether we fight for the top of
 * the top-layer stack, so an idle indicator never displaces a host's modal.
 */
export function ScreenOverlay({ children, css, active, onHost }) {
  const [mounted, setMounted] = useState(null);
  const onHostRef = useRef(onHost);
  onHostRef.current = onHost;

  useEffect(() => {
    const instance = mount(css);
    setMounted(instance);
    // The host is the only handle a caller gets on this subtree: the root
    // is closed, so events from inside retarget to it and composedPath()
    // stops at it. That makes "event.target === host" the one reliable
    // "this came from inside the overlay" signal.
    onHostRef.current?.(instance.host);
    return () => {
      setMounted(null);
      onHostRef.current?.(null);
      instance.dispose();
    };
  }, [css]);

  useEffect(() => {
    if (!mounted || !active) return;
    const { host } = mounted;

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
  }, [mounted, active]);

  return mounted ? createPortal(children, mounted.shadow) : null;
}
