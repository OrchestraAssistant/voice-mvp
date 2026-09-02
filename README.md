# voice-mvp

Voice control for React apps. Static analysis turns an app into a manifest of
what it can do; a relay mints realtime-voice sessions with that manifest as
the tool list; a widget executes the calls in the browser — manifest-driven
first, DOM fallback second, with a confirmation gate on destructive actions.

**Working end to end today**, against the real OpenAI Realtime API.

| doc | for |
|---|---|
| this file | orientation, running it, gotchas |
| [SPEC.md](SPEC.md) | what the system is and how the parts fit |
| [DESIGN-CHOICES.md](DESIGN-CHOICES.md) | decisions, alternatives rejected, revisit conditions |

---

## Layout

Four buckets, split by what ships and to whom. **This split is the thing to
internalise first** — conflating it caused real confusion before it existed.

```
packages/voice/       THE PRODUCT. React widget: VoiceProvider, useInterpreter,
                      InterpreterBubble/Panel, ListeningGlow, ScreenOverlay.
                      Ships to devs as @yourco/voice (built to dist/).
                      dev/ holds the hostile-host stress harness; not published.

packages/voice-cli/   THE TOOLING. Babel extractor: app source → manifest.json.
                      Ships to devs as @yourco/voice-cli.

relay/                YOUR SERVICE. Mints ephemeral OpenAI tokens; owns the
                      tool list + confirmation policy. Ships to nobody —
                      devs just get a URL.

demo-app/             SHOWCASE + INTEGRATION TEST. Plain Vite, no Tailwind,
demo-api/             consumes @yourco/voice exactly as a customer would.
                      demo-api/ stands in for the customer's backend.
```

The demo app having **no Tailwind is deliberate** — it's the only thing
proving the compiled package stands alone in a host that doesn't share our
build setup, and it's what caught the CSS-collision bug in DESIGN-CHOICES §1.

## Run it

```bash
npm install          # workspaces
npm run build:pkg    # @yourco/voice → dist/  (REQUIRED after any package edit)
npm run generate     # demo-app/src → demo-app/.voice/manifest.json

npm run dev:api      # demo backend   :3001
npm run dev:relay    # voice relay    :3002   (needs relay/.env OPENAI_API_KEY)
npm run dev:demo     # demo frontend  :5173
npm run dev:stress   # stress harness :5174   (content at /stress.html)
```

Open http://localhost:5173. Vite proxies `/api` → 3001 and `/voice` → 3002.

**Ports:** only `:5173` and `:5174/stress.html` serve a page. `:3001` and
`:3002` have no root route, so `/` returning 404 there is correct — check
`/api/tasks` and `/voice/manifest` instead.

### Verify the stack in one go

```bash
curl -s -o /dev/null -w "demo    %{http_code}\n" http://localhost:5173/
curl -s -o /dev/null -w "api     %{http_code}\n" http://localhost:5173/api/tasks
curl -s -o /dev/null -w "manifest %{http_code}\n" http://localhost:5173/voice/manifest
curl -s -o /dev/null -w "session %{http_code}\n" -X POST http://localhost:5173/voice/session
```

All four `200` means the relay is minting live tokens and the proxy is right.

### Try it

Click the mic pill (bottom-right) → panel opens with **Talk** and a **cog**.
Talk starts the session; the cog holds mic modes. Then:

- "What tasks do I have?"
- "Create a task called buy milk, due tomorrow"
- "Delete the task about the Q3 report" → **must ask you to confirm first**

There's a text box in the panel that runs the same tool pipeline without a
mic — genuinely useful for testing logic, though it needs an active session
(so mic permission is still granted; it just skips talking).

`?glow=1` forces the listening rim on without a session.
`?mount=inline` renders the widget in the host's DOM instead of the shadow
root — a live A/B of the CSS-collision problem.

## Gotchas that have actually bitten

- **`npm run build:pkg` after every package edit.** The demo resolves
  `@yourco/voice` to `dist/`, not `src/`. Editing the package and reloading
  the browser shows nothing until you rebuild.
- **`npm run generate` overwrites hand-corrections to the manifest.** There's
  no merge step. The demo's manifest currently carries two by-hand fixes the
  extractor gets wrong (`tasks` endpoint/params, `updateTask` bodyFields);
  regenerate and you must reapply them. `handEdited` in the file flags this.
- **Tailwind's scanner reads comments.** Quoting a class name in prose emits
  CSS for it. ~1KB of dead utilities in `voice.css` come from exactly that.
- **Preflight is excluded on purpose** (it would restyle the host's document).
  Pasted shadcn/skiper components assume it exists — if one looks subtly
  wrong, suspect this first. We ship a preflight-equivalent reset scoped to
  our own roots instead.
- **Duplicate dev servers.** Starting `dev:demo` twice makes Vite silently
  bind :5175 and you can end up looking at a different instance than the one
  you're rebuilding. `ps aux | grep vite` before debugging a "nothing
  changed" mystery.
- **`DEBUG_HEIGHT` in `InterpreterBubble.jsx`** is currently `true`, showing
  a red height readout in the panel. Temporary; set false or delete.
- **`rimTuningDev.js`** is likewise temporary (rim geometry sliders).

## State of the UI work

`InterpreterBubble` is a port of skiper-ui's skiper96 expanding-tabs
component. The layout and animation mechanics are now that component's
**unchanged** — measured wrapper, `popLayout`, `key={selected}`, tab strip
absolutely positioned inside the measured div.

Three deliberate differences remain:

1. **Widths 68→320** (theirs: 200→290). Ours must collapse to a single-icon
   pill. This is the prime suspect for any remaining resize jitter: the
   measured wrapper has no fixed width, so at 68px content wraps and measures
   tall. The cheap experiment is temporarily setting `COLLAPSED_WIDTH = 200`.
2. **Outline icons** — no `fill-current`; it floods lucide's stroke-only
   paths and turns a cog into a blob.
3. **Our content** in the panes.

If you touch this, change one thing at a time and compare against the
original — a long detour here came from stacking "fixes" on top of my own
earlier modifications instead of reverting to the source structure.

## Testing without a browser

There is no browser in this environment (Chromium is installed but missing
system libs, and there's no root to install them). What works instead:

- `npm run build:pkg && npm run build -w demo-app` catches every import/JSX
  error.
- `curl` against the four endpoints above covers the whole server path.
- **jsdom** is genuinely useful for DOM semantics — it settled the shadow-DOM
  retargeting question (`composedPath()` truncates on a *closed* root, so the
  click-outside check must compare against the overlay host). Reach for it
  before theorising about DOM behaviour.
- Anything about *layout or visual result* has to be checked by a human. Say
  so rather than guessing; guessing here has been expensive.
