# @yourco/voice-extension (scaffold)

The `@yourco/voice` DOM tier carried onto **any** page as a browser extension —
the logical completion of the tiered design (manifest = high-fidelity opt-in;
DOM = universal fallback). This is a **scaffold**: the architecture and the
reusable/cheap layers are wired; the Realtime session plumbing is structured but
stubbed. See DIRECTIONS §1 for the why.

## Architecture — one session, three worlds

```
 offscreen document          service worker (background)         content script (per tab)
 ── mic + Realtime session   ── router + tab orchestration       ── DOM tier + API tier
    one session, fixed          TAB_TOOLS run here                  runs IN the page:
    generic tools               PAGE_TOOLS -> active tab            domActions, transports,
    catalog SWAPS per page      owns offscreen lifecycle            catalog, route param-fill
```

The **dispatcher** (`run_query`/`run_action`/`expand`) is what lets one
never-re-minted session walk between apps: landing on a manifest page swaps the
catalog **data**, not the tools. Every tool the model calls is forwarded from the
offscreen session → service worker → the world that can run it.

The **content script reuses the package core verbatim** (`../voice/src`):
`domActions` (snapshot/click/type/pageContext), `transports` (rest/trpc/graphql),
`catalog` (expand), and the route param-fill from `routes.js`. It runs there
because that world has the two things the worker lacks: the live DOM and the
user's auth cookies.

## What's wired vs. stubbed

**Wired (real):**
- Tab orchestration — `open/close/switch/navigate/list_tabs` via `chrome.tabs`
  (`src/tabs.js`). The reliable, deterministic core; build on this first.
- The message protocol and routing (`src/messaging.js`, `src/background.js`).
- Manifest probing — `<meta>` tag and `/.well-known/voice/manifest.json`
  (`src/manifestProbe.js`).
- The content-script tool executor — DOM tools, API calls with page cookies,
  `expand`, and route param-fill (`src/content.js`).

**Stubbed (structured, marked `TODO`):**
- The Realtime/mic session in `src/offscreen.js` — `connectRealtimeSession`
  wiring and the catalog-swap-on-tab-change. The embedded `VoiceProvider` is the
  reference for the tool-call loop.
- `window.__voice` probing — needs a MAIN-world injection (isolated content
  scripts can't see the page's JS globals); the meta/well-known paths work now.
- SPA soft-navigation — content-script `navigate` does a full `location.assign`;
  an in-app route change needs MAIN-world router access.
- The visible widget UI (bubble/rim) — reuse `Interpreter`/`useInterpreter` from
  the package, rendered into an injected shadow root.

## Build & load

```
npm install          # in this package (esbuild)
npm run build        # bundles src/ -> dist/
```
Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked**
→ select this directory. Click the toolbar icon on a tab to point the session at
it.

## The two gates (not code — design, per DIRECTIONS §1)

1. **Trust / blast radius.** An unscoped model that can see and act on any page
   with your cookies. The `activeTab`/`drivingTabId` scoping, read-only default,
   and write confirmation are the start, but the real threat is **prompt
   injection through the DOM snapshot** — page content is attacker-controlled
   input the model reads. Treat it as data, never instructions. This is a
   first-class feature, not cleanup, and it gates adoption harder than the tech.
2. **Who pays.** The embedded widget bills the app developer; an extension
   minting sessions for arbitrary browsing bills whom? A business-model fork,
   not a detail.
