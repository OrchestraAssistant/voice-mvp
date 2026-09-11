/**
 * Discover whether the current page serves a @yourco/voice manifest -- the
 * handshake that lights up the high-fidelity API/route tier on top of the
 * universal DOM tier.
 *
 * Three publish points, cheapest for the app first:
 *   1. <meta name="voice-manifest" content="/.well-known/voice/manifest.json">
 *   2. a well-known URL, /.well-known/voice/manifest.json, no page cooperation
 *   3. window.__voice = { manifest, relayUrl }  (a mounted package sets this)
 *
 * (1) and (2) are readable straight from the content script's isolated world --
 * a <meta> is DOM, and fetch to same-origin carries the user's cookies. (3)
 * lives in the PAGE's JS world, which the isolated content script cannot see;
 * reading it needs a MAIN-world injection (web_accessible_resources/inpage.js),
 * left as a TODO below so the cheap paths work first.
 */

async function fromMeta() {
  const meta = document.querySelector('meta[name="voice-manifest"]');
  const href = meta?.getAttribute("content");
  if (!href) return null;
  try {
    const res = await fetch(new URL(href, location.href), { credentials: "include" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function fromWellKnown() {
  try {
    const res = await fetch(new URL("/.well-known/voice/manifest.json", location.origin), { credentials: "include" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// TODO(main-world): window.__voice is set by the page's own script and is
// invisible from the content script's isolated world. To read it, inject
// dist/inpage.js into the MAIN world (it is declared web-accessible) and have
// it postMessage the manifest back. Wire this once the cheap paths are proven.
async function fromWindowGlobal() {
  return null;
}

/** The page's manifest, or null when it serves none (DOM-only tier applies). */
export async function probeManifest() {
  return (await fromMeta()) ?? (await fromWellKnown()) ?? (await fromWindowGlobal());
}
