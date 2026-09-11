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

**v1 (`src/content.js`): the real embedded widget, injected into the page.**
The content script mounts `VoiceProvider` + `Interpreter` — the same bubble, rim,
mic and Realtime session the package ships — so the entire loop is reused, not
re-implemented, and the mic works because the bubble click is the user gesture
`getUserMedia` requires. The manifest is probed from the page (`<meta>` /
`.well-known`); with none, the widget runs its universal DOM tier. Per-tab,
exactly like the embedded widget.

**Kept in `src/` for the cross-tab future (not loaded by v1):** the service
worker + tab orchestration (`background.js`, `tabs.js`), the offscreen Realtime
host (`offscreen.js`), and the message protocol (`messaging.js`). That path is
the *one persistent session across tabs* of DIRECTIONS §1 — it needs the
offscreen mic-gesture problem solved and the tab tools added to the session
schema. v1 deliberately sidesteps both by living in the page.

**Not yet:**
- Cross-tab single session + tab orchestration (the `background`/`offscreen` path).
- `window.__voice` probing (needs a MAIN-world injection; meta/well-known work).
- SPA hard-nav across origins — the widget's default navigate is history/popstate.
- The widget injects on every page (`<all_urls>`); per-site activation is a
  Trust-model follow-up.

## Build & load

```
npm install          # in this package (esbuild)
npm run build        # bundles src/ -> dist/
```
Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked**
→ select this directory. Open a normal web page: the **voice bubble appears in
the corner** (it's the real embedded widget). **Click the bubble**, grant the mic
prompt, and talk — the model drives that page (navigate, read, click, run its API
if it serves a manifest). Clicking the bubble is the user gesture the mic needs.

Requirements to actually connect:
- The **relay must be up at mint time** (`RELAY_URL` in `src/offscreen.js`,
  default the trial relay). After minting, audio is browser↔OpenAI directly, so
  a relay that dies mid-call doesn't drop the session.
- The browser must **trust the relay's cert** and reach it (the hub CA, for the
  trial relay).
- Grant the **microphone** permission when Chrome prompts.
- Watch the offscreen document's console (`chrome://extensions` → the extension →
  "Inspect views: offscreen.html") for `[voice-offscreen]` status/transcript logs.

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
