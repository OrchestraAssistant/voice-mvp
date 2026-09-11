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

**Wired (real) — v1 drives the active tab by voice:**
- The Realtime/mic session (`src/offscreen.js`) — `connectRealtimeSession` owns
  the whole protocol (mic, audio out, response serialisation, the tool loop).
  The browser connects DIRECTLY to OpenAI with the ephemeral key; the relay is
  only hit for the brief mint at the start.
- The tool bridge — every tool the model calls is forwarded offscreen → worker →
  the world that runs it; session-local tools (answer_aloud/end_session) are
  acked in place.
- Tab orchestration — `open/close/switch/navigate/list_tabs` via `chrome.tabs`
  (`src/tabs.js`). The reliable, deterministic core.
- Message protocol + routing (`src/messaging.js`, `src/background.js`), with a
  ready-handshake so the session starts without a load race.
- Manifest probing — `<meta>` + `/.well-known/voice/manifest.json` — and the
  content-script tool executor: DOM tools, API calls with page cookies, `expand`,
  route param-fill (`src/content.js`).

**Not yet:**
- **Tab tools aren't exposed to the MODEL yet.** The relay mints the session's
  tool schemas from the manifest (page-driving tools: navigate/dom_*/run_query/
  run_action/expand); the tab tools are implemented but the model has no schema
  for them until we add them via `session.update` or a relay change. So v1
  drives ONE tab; multi-tab orchestration is the next step.
- No visible widget UI yet (bubble/rim) — reuse `Interpreter`/`useInterpreter`
  into an injected shadow root. Today it's headless: click the icon and talk.
- `window.__voice` probing (needs a MAIN-world injection; meta/well-known work).
- SPA soft-nav — content-script `navigate` does a full `location.assign`.

## Build & load

```
npm install          # in this package (esbuild)
npm run build        # bundles src/ -> dist/
```
Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked**
→ select this directory. Open a normal web page, **click the toolbar icon** to
point the session at that tab, grant the mic prompt, and talk — the model drives
that page (navigate, read, click, run its API if it serves a manifest).

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
