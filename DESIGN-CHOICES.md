# Design choices

Decisions that were genuine forks — where the alternative was reasonable and
might become the better answer later. Each records what was chosen, what it
costs, and what would justify revisiting.

---

## 1. Where the widget mounts: shadow root vs. the host's DOM tree

**Chosen:** all widget chrome renders into a **single open shadow root**
attached to `<body>`, outside the host app's React tree.

**Alternative:** render in the host's tree (`mount="inline"`, still supported
as a switch), and defend our styling with high-specificity selectors.

### Why

A host app's ordinary global CSS reaches an in-tree widget and wins. This
isn't hypothetical — the demo app, which is a deliberately unremarkable host,
took the widget apart on first contact:

```css
/* demo-app/src/index.css — an entirely normal thing for an app to have */
form   { display: flex; flex-direction: column; }
button { padding: 6px 14px; border: 1px solid var(--border); background: #fafafa; }
```

Result: the widget's command input and Send button stacked vertically, and the
tab pills became bordered grey boxes.

Two separate mechanisms make this unwinnable in-tree:

1. **Specificity + source order.** Our base rules are `:where(...) button`,
   which scores 0,0,1 — identical to a bare `button {}`. The host's stylesheet
   loads after ours (verified in the demo's compiled CSS: widget styles at
   char 7386, host styles at 13287), so on every tie the host wins.
2. **Cascade layers outrank specificity.** Tailwind v4 emits utilities into
   `@layer utilities`, and for normal declarations *unlayered* styles beat
   *layered* ones regardless of score. So a host's unlayered `button {}`
   (0,0,1) beats `.bg-foreground/4` (0,1,0) — the utility is more specific and
   still loses.

Raising our own specificity to answer this doesn't work either: it then stomps
the Tailwind utilities the pasted skiper/shadcn components are built from.
That's the trap — every specificity setting is wrong for one of the two.

Inside a shadow root, outer selectors simply **don't match** our nodes, so
neither mechanism applies. The problem stops existing instead of being
rebalanced.

### Open, not closed

The root was closed at first. The difference is narrower than it looks, and it
runs the wrong way.

Closed buys exactly two things over open: `host.shadowRoot` returns `null`,
and `composedPath()` truncates at the boundary — verified in jsdom:

| mode | `composedPath()` length | reveals inner node |
|---|---|---|
| `open` | 8 | yes |
| `closed` | 5 | no |

Everything the isolation is actually *for* survives either way. Outside CSS
still cannot select in. `document.querySelectorAll` does not descend into an
open root either, so our own `dom_snapshot` / `dom_click` fallback still never
sees the widget's chrome as page content. Inherited properties still cross.

What closed cost was larger:

- Click-outside could use neither `contains()` nor `composedPath()`, so it ran
  off `event.target === overlayHost`. Reliable, but a third branch that cost
  two broken iterations before it was understood. Open deletes it.
- The configuration that ships became unreachable by devtools, selectors and
  tests. That is not neutral: a resize fix was verified at `mount="inline"`,
  looked complete, and was broken in every build that shipped. Nothing could
  see it.
- It was never a security boundary. A host that wants in patches
  `Element.prototype.attachShadow` before our script loads. That is six lines,
  and it is exactly what the harness had to do to become inspectable. If a
  customer's security review ever demands real isolation, the honest answer is
  an iframe, not a closed root.

### What it costs

- **Event retargeting.** Events crossing the boundary still have
  `event.target` rewritten to the shadow host, open or not. Anything reading
  `target` from a document-level listener has to read `composedPath()`
  instead.
- **Runtime-injected stylesheets land in the wrong tree.** A library that
  injects a `<style>` into `document.head` at runtime has no effect on our
  nodes, and fails *silently* — no error, no warning, just a rule that never
  matches. framer-motion's `AnimatePresence mode="popLayout"` is exactly this:
  it takes the outgoing child out of flow with an injected
  `[data-motion-pop-id] { position: absolute !important }` block, so inside
  the shadow root the outgoing pane stayed in flow and the panel animated to
  the *sum* of both panes' heights (188 + 210 = 398) before snapping back.
  It behaved perfectly at `mount="inline"` throughout.

  The fix is one prop — `AnimatePresence` takes `root?: HTMLElement |
  ShadowRoot` and appends there instead (`const parent = root ?? document.head`
  in its `PopChild`) — but finding it meant reading framer-motion's source.
  **The general lesson is the one to keep:** a fix verified only at
  `mount="inline"` is not verified. Anything that injects styles, measures
  against `document`, or looks up an element by id needs checking in the
  root, which is what `dev/bubble.html?mount=shadow` is for.
- Focus, `aria-*` relationships, and form participation don't cross the
  boundary for free.
- **One root, not one per component.** The rim and the panel used to mount
  their own overlay each, which meant two elements competing for a top layer
  that is a plain stack: last to `showPopover()` paints last. Neither could
  concede without a rule, and each re-raising itself when the other appeared
  was a feedback loop — our raise fires a `toggle`, the other answers with a
  raise, measured at ~1800 events a second and seen as the panel flickering
  above and below the rim. They now share one host with an ordered layer
  each, so paint order is DOM order, decided once, and the question stops
  existing rather than being arbitrated at runtime. The cost is that
  `VoiceProvider` mounts the overlay, so chrome can no longer be used entirely
  standalone; `OverlayProvider` is exported for harnesses that want the
  overlay without a session.
- Host tooling and any library that queries `document` can't see inside.
- Inherited properties (`color`, `font`) *do* still cross, so isolation is of
  rules, not of everything.

### Revisit if

- A host is observed reaching into the root and interfering. Closing it again
  would only make that slightly less convenient, so the answer at that point
  is probably the iframe below rather than going back.
- We adopt a component that assumes document-level DOM access.
- We decide prefixed class names (`.iv-transcript`) plus explicit shielding
  is enough, accepting that a host's `button {}` still reaches us.

`mount="inline"` is kept deliberately so the difference stays observable:
compare `/` against `/?mount=inline` in the demo app.

### Considered and deferred: an iframe

The strongest isolation available, and — as far as we understand it, from
general knowledge rather than verified research — what the established
widget vendors use. Chat messengers (Intercom, Zendesk, Drift) render their
UI in one or more iframes with a small coordinating script in the page.
Payment and captcha embeds (Stripe Elements, reCAPTCHA) do it for a stricter
reason: the host page *must not* be able to read what the user types, so
isolation is the product requirement rather than a styling convenience.

An iframe is strictly stronger than a shadow root:

- separate document *and* separate JS global scope;
- **inherited properties don't cross either** — `color`, `font`,
  `line-height` still leak into our shadow root, and wouldn't here;
- immune to `!important`, ancestor stacking contexts and re-rooted
  containing blocks by construction, not by workaround.

Deferred because of three costs that land specifically hard on this product:

1. **Content can't overflow the frame's box.** A panel that expands, or any
   dropdown that spills past its edge, requires resizing the iframe itself
   from inside over `postMessage`. Much of the complexity in those vendors'
   SDKs is exactly this.
2. **The listening rim is full-viewport.** A transparent full-viewport
   iframe with `pointer-events: none` can host the rim, but then it can't
   receive the panel's clicks either — so it becomes multiple iframes, or
   one that resizes as the panel opens and closes.
3. **Our agent must touch the host's DOM regardless.** `dom_snapshot` /
   `dom_click` / `dom_type` are the whole Tier-1 fallback and can only run
   in the page's context. So an iframe splits us into iframe-UI plus
   page-script, coordinated over `postMessage` — where today the UI and the
   session share React state directly.

The asymmetry worth remembering: a chat widget's UI is self-contained and
never reads the host page, which is what makes an iframe cheap for them.
Ours is closer to a browser extension that happens to have a panel.

**Revisit if** a customer's security review objects to our UI sharing a
JS context with their page (an iframe answers that and a shadow root
doesn't), or if host CSS inheritance — the one thing the shadow root
doesn't stop — turns out to cause real visual bugs in the field.

### Considered and rejected: ID-scoped selectors

The obvious cheaper alternative: give the widget root an `id` and prefix every
rule with it — `#interpreter-widget button { … }`, scoring **1,0,1**. That
beats a host's `button {}` (0,0,1) outright, with no dependence on source
order, and it also stops our styles leaking outward. Pre-shadow-DOM, this is
how embeddable widgets did it, and if we weren't building on Tailwind it would
be the right call: far simpler than a shadow root.

It's specifically incompatible with *this* codebase:

1. **It outranks our own utilities too.** The components are assembled from
   Tailwind classes — `.bg-foreground/4` at 0,1,0. An ID rule beats those by a
   wider margin than it beats the host, so `#interpreter-widget button
   { background: transparent }` kills the selected-tab highlight exactly like
   the `.interpreter-widget button.rounded-2xl` override originally did. The
   bind is structural: **0,0,1 and 0,1,0 are adjacent**, so no specificity
   sits above a host's `button {}` and below a utility class. Any shield
   strong enough to stop the host stops us. Escaping it means marking the
   utilities `!important` (Tailwind v4 supports this), which just relocates
   the fight.
2. **It only defends properties we explicitly declare.** A host's
   `button { text-transform: uppercase }` still lands unless we've written
   `text-transform` ourselves — so it implies hand-rolling a full reset per
   element type (`all: revert` scoped to us). Doable, but open-ended.
3. **`!important` ignores specificity entirely.** `body div { position: static
   !important }` — a real legacy-CSS pattern, and one the stress harness
   deliberately includes — beats any ID. Only inline `!important` (what
   `ScreenOverlay` pins on its host element) or shadow isolation escapes it.
4. **It addresses none of the non-cascade problems.** A transformed or
   `contain: paint` ancestor re-roots `position: fixed` so `inset: 0` stops
   meaning the viewport; an ancestor stacking context caps our z-index at any
   value. Those are layout and paint concerns, not selector matching.

Minor, but worth noting: an `id` must be unique per document, so a host
mounting two widgets breaks it. `[data-x]` scores 0,1,0 (same as a class, so
no help); the `[data-x][data-x]` doubling trick works but is the same
specificity arms race by another name.

**Revisit if** we ever drop Tailwind from the package. Then reason 1 — the
decisive one — disappears, and ID-scoping plus a scoped reset becomes a
genuinely simpler answer than maintaining shadow-boundary workarounds.

---

## 2. Tailwind is a build-time dependency, and preflight is excluded

**Chosen:** author components with Tailwind; compile to plain CSS in
`dist/voice.css`; ship no Tailwind to consumers. Import
`tailwindcss/theme.css` + `utilities.css` only — **never** the full
`@import "tailwindcss"`.

**Why:** preflight is a *global* reset (`*,::before,::after{box-sizing:border-box;margin:0}`,
unstyled headings). Fine for an app that owns the page; catastrophic for a
widget dropped into someone else's, where it would silently restyle their
entire document.

**Cost:** pasted shadcn/skiper components assume preflight exists — buttons
being transparent and borderless is what lets their utility classes compose.
We supply a preflight-equivalent reset scoped to our own roots instead. When a
pasted component looks subtly wrong, this is the first thing to suspect.

**Revisit if:** we move fully into the shadow root, where preflight could be
injected safely, since it could no longer reach the host document.

---

## 3. Theme tokens map through `@theme inline reference`, not `:root`

**Chosen:** `@theme inline reference { --color-background: var(--iv-surface); ... }`,
with the concrete values defined in a rule scoped to the widget's roots.

**Why:** shadcn components are written against `bg-background`, `bg-muted`,
`text-foreground`. Defining `--color-*` values directly on `:root` would
overwrite the same variables in any host that also uses Tailwind v4.

**Why the two modifiers, and not a plain `@theme`:** a plain `@theme` emits
the names to `:root` and has the utilities *reference* them —
`.bg-background { background-color: var(--color-background) }`. That silently
does not work, and it is worth being precise about why, because the failure is
invisible: a custom property whose value contains `var()` is substituted at
**computed-value time on the element it is declared on**, not deferred to
whoever reads it later. On `:root`, `--iv-surface` does not exist, so
`--color-background` computes to the guaranteed-invalid value and *inherits
down in that state*; defining `--iv-surface` further in never gets a second
look. Every semantic utility in the widget resolved to `transparent` /
`unset`. It looked fine only because the panel sat on white hosts — on
`dev/bubble.html?bg=dark` the whole panel is see-through.

- `inline` pastes the value into the utility itself —
  `.bg-background { background-color: var(--iv-surface) }` — so the lookup
  happens at the **use** site, inside our subtree, where `--iv-surface` is
  defined.
- `reference` then stops the (now unreferenced) `--color-*` names being
  emitted to `:root` at all, which is what this section wanted in the first
  place.

**Cost:** the utilities are inert outside our subtree — fine, and arguably
correct, but surprising if someone expects them to work anywhere.

### Related: our own rules live in `@layer base`

Same class of bug, same stylesheet. The scoped preflight-equivalent reset
(`:where(.interpreter-panel, .interpreter-widget) button { background:
transparent }`) was written at zero specificity on the theory that "utilities
always win". They don't: for normal declarations **unlayered beats layered**
regardless of specificity, and Tailwind's utilities are in `@layer utilities`.
So the reset beat `bg-foreground/4` and the selected tab never highlighted.
`@layer theme, base, components, utilities;` up front, with everything of ours
in `base`, puts the two in a defined order — and it is the same mechanism that
makes ID-scoping unworkable in §1.

### Related: the measured wrapper is pinned to the panel width

`useMeasure` watches a wrapper that would otherwise be as wide as the
container animating around it. Collapsed, that container is 56px, so at the
first frame of an open the content wrapped and measured **348px** tall, then
unwrapped to 188 as the width caught up — the panel ballooned and collapsed
instead of just growing. Measuring at the final width (`style={{ width:
PANEL_WIDTH }}`) makes the transition monotonic in all four directions; the
container's `overflow-hidden` does the revealing, and the tab strip is
unaffected because it is absolute against the container, not the wrapper.
The original never hits this because 200 → 290 is too small a change to
rewrap anything. `dev/bubble.html?trace=1` is what this was diagnosed with.

### Related: `@source "./"` is explicit

Tailwind's automatic content detection keys off the *build's* root, not the
stylesheet's. The library build (root `packages/voice`) found `src/`; the dev
server (root `dev/`) silently did not, and served a stylesheet with almost
none of the utilities the components are built from — so the same component
looked correct in one and unstyled in the other. Declaring `@source "./"`
relative to the stylesheet makes the scanned set the same for every consumer.

---

## 4. Dependencies are bundled, not peer

**Chosen:** `framer-motion`, `lucide-react`, `react-use-measure`, `clsx`, and
`tailwind-merge` are bundled into `dist/voice.js`. Only `react`/`react-dom`
are external.

**Why:** React must be external — two copies is the classic "invalid hook
call". The rest are implementation details a customer shouldn't have to
install.

**Cost:** a host already using framer-motion ships it twice. The bundle is
~262KB (~73KB gzipped), and `mode="popLayout"` pulls in framer-motion's
layout-projection code specifically.

**Revisit if:** bundle size becomes a selling point, or telemetry shows most
hosts already have framer-motion.

`usehooks-ts` was deliberately *not* added for a single `useOnClickOutside`;
it's ten lines locally.

---

## 5. The demo app has no Tailwind, on purpose

**Chosen:** `demo-app/` stays plain Vite with hand-written CSS and consumes
`@yourco/voice` exactly as a customer would.

**Why:** it's the only thing that proves the compiled package stands on its
own in a host that doesn't share our build setup. Adding Tailwind there would
destroy the signal — and it's precisely what caught the collision in §1.

**Revisit if:** never, really. If we want a Tailwind host to test against,
add a *second* demo rather than converting this one.
