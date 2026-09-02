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
                      dev/ holds two harnesses, neither published: stress.html
                      (hostile host) and bubble.html (clean host, for the panel).

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
npm run dev:stress   # dev harnesses  :5174   (/stress.html and /bubble.html)
```

Open http://localhost:5173. Vite proxies `/api` → 3001 and `/voice` → 3002.

**Ports:** only `:5173`, `:5174/stress.html` and `:5174/bubble.html` serve a
page. `:3001` and `:3002` have no root route, so `/` returning 404 there is
correct — check `/api/tasks` and `/voice/manifest` instead.

`bubble.html` is the panel's workbench, and exists because the real widget
lives in a **closed** shadow root that no selector and no devtools query can
reach into. It mounts the bubble `inline` on a page with no opinions of its
own, which renders identically and *can* be driven and inspected.
`?mount=shadow` switches to the real overlay path, `?bg=dark` puts it on a
dark background — the fastest way to catch a surface that is actually
transparent — and `?trace=1` records the animated container and the measured
wrapper frame by frame after each click, which is the only practical way to
debug the resize. Healthy looks like `inner` holding steady while `outer`
moves toward it; `inner` moving too means the content is reflowing mid-
transition and the panel will visibly overshoot, and `inner` reading as the
*sum* of both panes means the outgoing one never left the flow.

`?shadow=open` forces every shadow root open so the path that actually ships
can be inspected — nothing else can see inside it, since a closed root has no
`.shadowRoot` and defeats both selectors and devtools. Pair it with
`?mount=shadow`. Selectors still can't drive the panel from outside, and a
click on this page would close it via click-outside before the proxied click
landed, so the harness drives it from the keyboard instead: **1** toggles the
Talk tab, **2** toggles Settings.

**Verify in the shadow root, not just inline.** A bug can be invisible at
`mount="inline"` and present in every build that ships — see DESIGN-CHOICES
§1 on runtime-injected stylesheets, which cost a round of "fixed" that
wasn't.

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
- **`rimTuningDev.js`** is temporary (rim geometry sliders in the flat panel).
- **A widget that renders but looks unstyled** is almost always one of the
  three cascade traps in DESIGN-CHOICES §3, not a React problem: theme tokens
  reaching `:root` where `--iv-*` isn't defined, our own rules sitting
  unlayered above `@layer utilities`, or Tailwind scanning the wrong root.

## State of the UI work

`InterpreterBubble` is a port of skiper-ui's skiper96 expanding-tabs
component. The layout and animation mechanics are now that component's
**unchanged** — measured wrapper, `popLayout`, `key={selected}`, tab strip
absolutely positioned inside the measured div.

Four deliberate differences remain:

1. **One tab closed, two open.** Closed, the pill is just the mic; Settings
   only joins the strip once the panel is open, so idle chrome stays as small
   as possible. Tab indices are fixed (talk 0, settings 1) so `selected`
   survives the array growing.
2. **Widths 56→290** (theirs: 200→290). Only the collapsed width differs, and
   only because ours collapses to a single-icon pill rather than five.
3. **Outline icons** — no `fill-current`; it floods lucide's stroke-only
   paths and turns a cog into a blob.
4. **Our content** in the panes, built from the same row/list vocabulary the
   original uses, so the shell and its contents stay of a piece.

If you touch this, change one thing at a time and compare against the
original — a long detour here came from stacking "fixes" on top of my own
earlier modifications instead of reverting to the source structure.

## Testing

A local Chromium is installed but missing system libs, and there's no root to
fix that — so `npm`-side tooling can't drive a browser. The hub's browser can,
against `https://interpreter.hub.tailnet:<port>/`, and that is the thing to
reach for on anything visual. **Computed style beats a screenshot** whenever
the question has a factual answer: the entire theme-token bug in
DESIGN-CHOICES §3 was invisible in screenshots (a transparent panel on a white
page looks like a white panel) and obvious the moment
`background-color` read back `rgba(0, 0, 0, 0)`.

- `npm run build:pkg && npm run build -w demo-app` catches every import/JSX
  error.
- `curl` against the four endpoints above covers the whole server path.
- `curl 'http://localhost:5174/@fs/<abs-path>/src/styles.css?direct'` returns
  the *compiled* stylesheet. Read this before theorising about the cascade —
  it is what actually shipped, layers and all.
- **jsdom** is genuinely useful for DOM semantics — it settled the shadow-DOM
  retargeting question (`composedPath()` truncates on a *closed* root, so the
  click-outside check must compare against the overlay host). Reach for it
  before theorising about DOM behaviour.
- Taste — does it *look* right — is still a human call. Correctness mostly
  isn't; check it.
