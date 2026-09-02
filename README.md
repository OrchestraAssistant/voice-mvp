# Voice MVP

A working end-to-end proof of the architecture we discussed: static
analysis turns a React app into a manifest of what it can do, a relay
server mints ephemeral realtime-voice sessions with that manifest as
the tool list, and a runtime widget executes calls (manifest-driven
first, DOM fallback second) with a confirmation gate on destructive
actions.

## Layout

```
demo-app/     Vite + React Router + React Query + RHF/Zod "Tasker" app
              -- src/voice/  is the widget package (VoiceProvider, DOM
                 fallback, WebRTC client, listening rim) -- what would
                 ship as an npm package in the real product.
              -- stress.html + src/stress-main.jsx  is the "host app we
                 don't know" harness for the rim (see below).
server/       Express: the demo app's own REST API (/api/*), plus the
              voice relay (/voice/session mints an ephemeral OpenAI
              token + attaches the manifest as tools; /voice/manifest
              serves it for inspection/debugging).
voice-cli/    The static-analysis extractor (`generate.js`). Real
              Babel-AST analysis, not a stub -- see "What it actually
              extracts" below.
.voice/       manifest.json -- generated, then hand-reviewed/edited.
              Committed, not gitignored, same as a Prisma schema.
```

## Run it

Three terminals:

```bash
# 1. (re-)generate the manifest from the demo app's source
cd voice-cli && node generate.js

# 2. backend: the demo app's API + the voice relay
cd server && OPENAI_API_KEY=sk-... npm run dev

# 3. frontend
cd demo-app && npm run dev -- --host
```

Open the app at **http://interpreter.hub.tailnet:5173/** (or
`localhost:5173` if you're on this machine directly). You need a real
browser for the live voice test — mic access and WebRTC audio can't be
exercised headlessly, which is also why I couldn't do this last step
myself.

Click **Talk** in the bottom-right widget, grant mic permission, and
try things like:

- "What tasks do I have?"
- "Create a task called buy milk, due tomorrow"
- "Mark buy groceries as done"
- "Delete the task about the Q3 report" → it should ask you to confirm
  before actually deleting (this is the confirmation gate — try saying
  no, then try again and say yes)
- "Take me to settings and change my theme to dark"

There's also a text box in the widget ("Or type a command...") that
sends a text turn through the same tool-calling pipeline, in case you
want to sanity-check the logic without talking out loud.

**If you don't have an `OPENAI_API_KEY` with Realtime access yet**:
everything except the actual voice connection is already verified
working (see below) — the text-input box won't work either without a
session, but you can still see the manifest, run `generate`, and read
through the code. Set the key and restart `server` whenever you're
ready.

## What I verified without a live key

- `voice-cli/generate.js` runs real Babel AST analysis on the demo
  app and produces `.voice/manifest.json` — 4 routes, 3 queries, 4
  actions, with real required/optional fields and types pulled from
  the Zod schemas in `NewTask.jsx`/`Settings.jsx`, and `deleteTask`
  correctly auto-flagged `requiresConfirmation: true` off the DELETE
  heuristic.
- Every query/action in the manifest was exercised directly against
  the running API (`curl`) with the exact URL/method/body shape the
  widget's executor builds from the manifest, end to end: list tasks
  with a search filter, create, update (mark done), update settings,
  delete — all round-tripped correctly.
- `npm run build` in `demo-app` compiles clean (174 modules, no
  errors) — catches broken imports/JSX across every file.
- `/voice/session` correctly refuses with a clear error when
  `OPENAI_API_KEY` isn't set, rather than failing silently.
- I could not launch a real browser here (no root, so Playwright's
  Chromium is missing shared libraries I can't install) or exercise
  microphone/WebRTC audio at all — that part needs you, live.

## The listening rim, over an app we don't control

The rainbow rim that signals "the mic is live" has to draw over a host
app whose markup and CSS we've never seen. A `position: fixed;
z-index: 9999` div rendered inside the host's tree loses to three
separate things a host is free to do without knowing we exist: a
stacking context on any ancestor (our z-index is then only compared
against our siblings inside it), a `transform`/`filter`/`contain` on
any ancestor (which re-roots `position: fixed` onto that ancestor, so
`inset: 0` quietly stops meaning "the viewport"), and its own `*{}`
resets and `!important` rules landing on our nodes.

`src/voice/ScreenOverlay.jsx` steps outside all three instead of
trying to out-number them: it mounts as a direct child of `<body>`
(no host ancestors to inherit a broken containing block from), keeps
its CSS in a **closed shadow root** (host stylesheets can't select in,
host scripts can't reach in -- and our own `dom_snapshot` walks the
light DOM, so the interpreter never sees its own chrome as page
content), pins its box with inline `!important` declarations (which
outrank every author rule a host can write, including its own
`!important`), and promotes itself into the browser's **top layer** via
the popover API, which paints above the whole document by rule rather
than by out-bidding anyone. `pointer-events: none` throughout, so the
app underneath stays fully clickable.

The *look* is a separate problem from the stacking. The reference
(skiper-ui's `AppleBorderGradient`) can't be copied as-is precisely
because of how it gets its shape: it lays a sharp rainbow across the
whole viewport and hides the middle under a solid `bg-muted` rectangle,
inset 2px and blurred 24px (`blur-xl`) — which is why dropping it on a
real app paints over the page. Everything else about
`ListeningGlow.jsx` is the original's: same four colours, same 5s
linear sweep of the gradient's *angle* across a viewport-sized box (not
a rotating plane — that stretches one colour band per edge instead of
spreading all four), same falloff. Only the cover is substituted, for a
mask carrying the identical alpha profile.

That profile is solved, not eyeballed. A blurred hard edge is an error
function, so the fraction of gradient still showing at distance `d`
from the screen edge is `1 - Φ((d - 2) / 24)` — tabulated as `FALLOFF`.
Two values in it are easy to get wrong and both change the look
completely: the peak is **0.53, not 1** (at the very edge the blurred
cover is already ~47% opaque, so even the brightest part of the
reference is barely over half strength), and the tail is Gaussian —
still ~4% at 44px, not gone until ~80px. Note also what *not* to do:
blurring the gradient itself instead spreads it outward, bleeding the
strongest colour off-screen and leaving a wide washed-out band with no
crisp edge.

Add **`?glow=1`** to the demo app's URL to force the rim on without a
live mic session, which is how to look at it without an OpenAI key.
**Rim geometry sliders** sit at the bottom of the interpreter panel —
temporary, and confined to `rimTuningDev.js` plus its call sites so
they're one file to delete once the numbers are settled. `width` scales
the whole `FALLOFF` curve proportionally, so the decay keeps its shape
at any size. `cornerRadius` is signed, ±300, and shapes the *inner*
corner where the glow turns to follow the next edge — the outer corner
stays square either way.

The two edge masks union into a square inner corner, and each sign gets
its own family of layers, since a mask layer has no notion of a negative
radius. **Positive** punches a soft hole with `mask-composite: intersect`
where the two edges meet, at `(width, width)` in from each screen
corner, cutting the corner back. **Negative** unions in a bloom centred
on the screen corner itself, reaching further into the page. Both
collapse to a no-op at 0, so the default is exactly the reference's own
square corner — verified rather than assumed, since "0 means untouched"
is the whole contract of a signed control.

One consequence worth knowing: a square corner already reaches
`width × √2` along the diagonal, so the bloom only starts changing the
corner's *shape* past about 113px at the default width. Below that it
sits inside the existing band and just fills the corner in.

All of it rides on CSS custom properties rather than the stylesheet
text, since `ScreenOverlay` keys its mount effect on that string and
would rebuild the whole overlay on every frame of a drag.

Watch out for `mask-composite: subtract` here — it's source-OUT
(*source minus destination*), not destination minus source. Compositing
a disc that way replaces the rim with "disc outside rim", which at
radius 0 erases the rim from the screen entirely.

**Verify it yourself** at **http://interpreter.hub.tailnet:5173/stress.html**
— a deliberately hostile page that is *not* the demo app: the widget's
mount point is buried inside a `transform` + `contain: paint` ancestor,
under a global `body div { position: static !important; z-index: 0
!important }` reset, on a page whose own chrome already sits at
`z-index: 2147483647`. The buttons there open a full-bleed `<dialog>`
(`showModal()`) and a full-bleed native popover — both in the top layer,
both covering every pixel the rim draws on. Checked in this browser:
the rim stays on top of all of them, and the corner counter button
underneath still takes its clicks.

Two known limits, both deliberate. Re-entering the top layer above a
host's newly-opened dialog/popover is *reactive* — a `toggle` listener
plus a MutationObserver on `open` — so there's a frame where the host's
element is above us before we re-raise. And an element the host puts
into fullscreen also enters the top layer; we don't currently fight
that one, since a rim over fullscreen video is probably wrong anyway.

## What it actually extracts (and doesn't)

The extractor targets specific, recognizable patterns — this is a
first-pass tool meant to be reviewed and hand-corrected, not a general
JS analyzer:

- **Routes** from `<Route path="..." element={<X/>} />` JSX in
  `App.jsx`.
- **Queries/actions** from `useQuery`/`useMutation` hooks in `api.js`
  that call a `request(url, options)` helper, including resolving
  simple module-level string constants (e.g. `BASE = "/api"`) inline.
- **Field shapes** (required/optional, type, enum values) from Zod
  schemas co-located in the same page file as the form that submits
  them.
- The **confirmation policy** is a heuristic (`DELETE` → true) that's
  meant to be reviewed, not trusted blindly — see the two hand-edits
  in `.voice/manifest.json` (the `tasks` search param and
  `updateTask`'s body fields) for exactly the kind of correction a
  real integration would need. Regenerating overwrites hand-edits, the
  same tension a generated-file-with-manual-overrides always has; a
  real version would need a diff/merge step, which is out of scope
  here.

Anything outside these patterns (GraphQL/tRPC, Redux/Zustand actions,
non-Zod forms) isn't extracted — that's intentionally the DOM-fallback
layer's job (`dom_snapshot`/`dom_click`/`dom_type` tools), not this
CLI's.

## Deliberately out of scope for this MVP

Per the phase-0 scope cut: the exploration crawler ("SLAM" nav-graph),
React fiber/state access, Tier-3 direct API-key hooks, and a real
versioned control plane (this relay just reads `.voice/manifest.json`
off disk on every session request — no history, no rollback, no
multi-tenant storage). The security-relevant part of that design —
server-side token minting and server-held tool/policy definitions so
the browser can't redefine them — is implemented; the persistence
layer around it isn't.
