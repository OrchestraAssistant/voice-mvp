# Directions

Forward-looking directions we might take, written down so they are not lost.
Distinct from DESIGN-CHOICES.md (what was decided and built) and
DESIGN-PHILOSOPHY.md (the standing principles): nothing here is committed, and
each entry is kept honest about what is hard, not just what is exciting.

---

## 1. The extension: the DOM tier, unshackled from opt-in

Everything so far is the developer's side of one app: install the package, it
learns the app into a manifest, the manifest ships to the frontend, users drive
that one app by voice. Every app that installs the package, but only those apps.

The complementary picture is a **browser extension** that carries the floating
widget and rim onto *any* page, with no package installed on the site. It is not
a new direction -- it is the logical completion of the one we are already on.
Our whole design is tiered: the manifest is the high-fidelity, opt-in path; DOM
is the universal, best-effort fallback. The extension is simply **the DOM tier
applied to the whole web** instead of to one app that happened to leave the
manifest silent.

### What it gains

1. **Browser orchestration** -- create / close / switch / navigate tabs. This is
   the underrated win, and the one to build first: it is a *browser API*, so it
   is deterministic and reliable, and it is something no embedded widget can ever
   do. "Open these three things", "go back to the one with the invoice", "read
   this page and tell me X" -- all of it works without a single fragile click.
2. **Voice and chat over the open web** -- driving arbitrary sites by DOM. This
   is the flashy pitch, and the weak half. See the honesty below.

### The honest caveat

"DOM navigation works rather well blind" is over-optimistic and we should not
believe it of ourselves. We spent a whole fieldtest watching DOM navigation be
*funky* on cal.diy -- and cal is the friendly case: real testIds, semantic
structure, a known app. The open web is the long tail -- obfuscated class names,
canvas and shadow-DOM apps, cookie banners, anti-bot walls, no testIds. DOM-only
is the FLOOR, and the floor out there is lower than the floor on cal. The
extension buys universal reach at a real reliability cost; it will feel like
magic on good sites and like a struggle on bad ones, and the bad ones are most
of the web. Anchor the product on the reliable browser-orchestration layer;
treat blind-DOM *acting* as the honest-but-rough tier it is.

### The seam -- and why we have already built it

The interesting question is what happens when the extension navigates to a tab
running an app that DID install the package (and so shipped a manifest). The
naive fear is a hard technical wall: a Realtime session fixes its tools at
creation, so you cannot hot-swap an app's typed tools into a running session --
which would force a re-mint on every navigation (expensive, context lost) or two
sessions fighting for the microphone.

The **dispatcher dissolves that wall.** We built `run_query` / `run_action` /
`expand` -- operations as *data* in a catalog, reached through a fixed, generic
set of tools -- to fit a big app's tools into a prompt. That same shape is what
lets the extension walk between apps in ONE session: the extension holds one
session with fixed generic tools (DOM + tabs + the three dispatchers) forever,
and landing on a package-app does not add tools, it swaps the **catalog data**
the dispatcher reads. Same session, new app, no re-mint. The thing invented for
the big-app problem is the same thing that makes the whole-web session coherent.

The handshake is small: the package publishes its manifest discoverably (a
`<meta>` tag, or `window.__voice`), and a content script -- which runs in the
page's own origin -- reads it AND already holds the auth cookies to execute the
typed calls as the logged-in user. So "only one widget persists" resolves
cleanly: the extension's session is always primary, and a package-app's embedded
widget should detect the extension and yield to it.

### The two problems that actually gate this

Not the tech -- the architecture above mostly reaches. These:

1. **Who pays.** The embedded model bills the app DEVELOPER for their users'
   sessions. An extension minting realtime sessions for arbitrary browsing bills
   whom -- the user, a subscription? That is a business-model fork, not a detail;
   it changes what the company is.
2. **Trust and blast radius -- the big one.** A realtime model that can see
   every page and click and type with your cookies on any site is pointed at
   your bank, your email, your health portal. The embedded widget is scoped to
   one app a developer vetted; the extension is unscoped by design. A
   prompt-injection on a malicious page could drive your authenticated session
   elsewhere. It is solvable -- per-site permissions, read-only defaults, action
   confirmation -- but it is a first-class design problem and a headline feature,
   not a cleanup task, and it will gate adoption harder than the technology will.

### If we build it, the order

Browser-orchestration + read-the-page first (reliable, differentiated,
low-risk). Blind-DOM acting as the honest rough tier. The dispatcher as the
manifest handshake. The security model designed up front, as a feature.

---

## 2. Responsive layouts: fork the DOM artifacts, not the manifest

An app renders different DOM at different widths -- a desktop sidebar vs a mobile
bottom-nav, a visible link vs a hamburger, whole components present in one layout
and absent in the other. This matters because our artifacts are not all equally
affected, and the split is the whole design.

**What is layout-INVARIANT:** routes and API operations. `/event-types` is
`/event-types` at any width; an API call does not change with the viewport. So
`navigate({path})` and the whole API path work in any layout, untouched. This is
a real robustness advantage of the API/route surface.

**What is layout-DEPENDENT:** the DOM artifacts -- `readyWhen` markers and DOM
flows. A testId present on desktop may not exist on mobile; the click sequence to
do a thing differs. And note the asymmetry: a LIVE `dom_snapshot` adapts (it sees
whatever is rendered now), so agentic DOM manipulation is layout-robust at
RUNTIME. What is fragile is the PROBED/RECORDED artifacts, baked at one viewport.

So the plan, when we build the responsive story:

- **Probe both layouts.** The probe already drives a browser at a fixed viewport
  (1280x900 = desktop, an implicit assumption we have been making). Run a second
  pass at a mobile viewport (+ mobile UA/touch) and capture markers per
  breakpoint. Same probe, twice.
- **Differentiate statically, best-effort.** Responsiveness is written down:
  Tailwind responsive prefixes (`hidden md:block` = desktop-only, `md:hidden` =
  mobile-only), `useMediaQuery`/`isMobile` conditional-render branches, and
  separate `MobileNav`/`DesktopSidebar` components. Static analysis can TAG an
  element/testId with the layout(s) it appears in. Imperfect (runtime widths,
  dynamic conditions), but a solid annotation.
- **Per-layout flows (#3).** A recorded DOM flow is layout-specific -- one
  recorded on desktop will not replay on mobile. So a flow carries the layout it
  was recorded for; the widget picks by its current width; and "re-derive from a
  live snapshot when no recorded flow matches" is the fallback. This is a real
  constraint on the recorded-flows direction (section 1), not an afterthought.
- **Layout-TAG the artifacts; do NOT fork the manifest (#4).** The instinct to
  avoid clogging a layout with things it cannot use is right, but the mechanism
  is not two manifests. Most of the manifest is invariant (routes, queries,
  actions); duplicating it per layout would repeat ~90% of it. Only the DOM bits
  -- `readyWhen`, flows -- are layout-specific, so they carry a layout tag within
  ONE manifest, and the widget filters those by its runtime width. DRY, and still
  ships nothing useless to a layout.

**The client filters by the LIVE viewport, and it rides the dispatcher we
already have.** One manifest, layout-tagged; the widget -- the only thing that
knows the runtime width -- drops the tags that do not apply before the catalog
reaches the AI. This is not a new mechanism: the widget already decides what the
AI sees (root catalog vs. `expand` subsets), and layout is one more filter
dimension on that same pass. And the value is mostly CORRECTNESS, not tokens:
`readyWhen` markers never reach the AI at all (internal widget behaviour, zero
tokens), and a DOM flow ships only its one-line name, so the token saving is the
occasional genuinely-mobile-only or desktop-only operation. The real win is not
handing the AI a flow or marker that cannot work in the layout it is looking at
-- a failure, not just waste.

**Not yet -- the trigger to build this.** We have not actually observed the
voice system fail on a genuine layout difference (the mobile render that
prompted all this was a CSS leak, since fixed, not a responsive failure). And the
artifact that benefits most -- recorded DOM flows -- is itself unbuilt (section
1's deferred piece). Meanwhile the agentic DOM path already adapts for free (a
live `dom_snapshot` sees whatever layout is rendered), and `readyWhen` has a
cheap stopgap: prefer a marker present in both layouts. So building the full
layout story now would be infrastructure for an unconfirmed problem whose main
consumer does not exist -- against our own "measure, don't infer". Build it when
one of these is true: we observe a real layout-driven failure; we build recorded
flows (where layout-tagging earns its keep); or a product targets mobile
specifically. Until then this is captured, not committed -- which is what this
file is for.

---

## 3. Stack coverage: where the manifest can be built today

We began as a **Next / tRPC / zod / react-query tool**, and as of the producer
round below we also read the **React-Router-v7 / axios-service / REST** world
(plus Valibot and Yup schemas). This section is the map of that edge, dimension
by dimension, so that "can we do app X?" is a lookup rather than an
investigation, and so that adding a capability is a deliberate move against a
known gap.

The map was prompted by `testapps/plane` (Plane): React Router v7 framework
mode, axios service classes over a Django REST backend, `@plane/types`
interfaces, SWR + MobX, and **zero testIds**. On first look the CLI extracted
**0 routes / 0 actions** -- not because Plane is small (it is huge: 23 service
classes, 339 methods) but because its every seam matched none of our detectors.
That gap is what the new producers close; the shape is a coherent and *very
common* SPA-over-REST one, not a Plane peculiarity.

**Read this table honestly.** The *support* column is authoritative -- it is the
CLI's own stage report (producers `next-app-router`, `next-pages-router`,
`next-route-handlers`, `next-pages-api`, `react-router`, `react-router-config`,
`tanstack-router`, `tanstack-server-routes`, `remix-fs-routes`, `astro-pages`, `trpc-routers`, `request-hooks`, `axios-services`,
`openapi-spec`; enrichers `zod-bodies`, `valibot-bodies`, `yup-bodies`,
`arktype-bodies`, `typescript-types`, `page-metadata`, `call-sites`; and
`graphql-operations`, whose ops ride a dedicated widget `graphql` transport). The *ranking* within each category is rough ecosystem prevalence,
and the effort tags (S/M/L) on remaining gaps are estimates. `◆` marks where
Plane lands. (A rendered, colour-coded version of this lives as a private
artifact -- regenerate it from this table if the two drift.)

Legend: **Y** supported · **~** partial (works with host help, or only enriches
an already-found op) · **N** not yet.

### Framework / meta-framework
| Option | | Note |
|---|---|---|
| Next.js -- App Router | Y | next-app-router + next-route-handlers |
| Next.js -- Pages Router | Y | next-pages-router + next-pages-api |
| Vite + React SPA / CRA | Y | via react-router producer, *if* JSX routes |
| React Router v7 (framework) ◆ | Y | **react-router-config** producer (navigation) |
| Remix (classic, file routes) | Y | **remix-fs-routes** (navigation) |
| TanStack Start | Y* | routing via **tanstack-router**, API routes via **tanstack-server-routes**. *`createServerFn` server functions are RPC to a framework id (the Server-Actions case), left alone |
| Astro | Y | **astro-pages** -- `src/pages/**` pages (navigation) + `.ts`/`.js` endpoints (real HTTP) |
| Gatsby / Redwood | N (L) | own router/build |

### Routing declaration
| Option | | Note |
|---|---|---|
| Next app/pages file convention | Y | folder → route |
| React Router JSX `<Route path element>` | Y | parsed |
| RR data router `createBrowserRouter([])` | Y | **react-router-config** (object routes, nested children) |
| RR-v7 `route()/layout()` in routes.ts ◆ | Y | **react-router-config** (helper calls, merged across files) |
| TanStack Router (file or code) | Y | **tanstack-router** (`createFileRoute`/`createRoute`, `$param`→`:param`) |
| Wouter | ~ | `<Route path>` caught by react-router (JSX); `component` prop name missed |
| Remix / fs-routes (flat, folder, v1 nested) | Y | **remix-fs-routes** (splits the spec on both `.` and `/`) |
| Hash router | ~ | JSX form detected; hash paths untested |
| Hand-rolled switch / conditional render | N (L) | not declarative -- hard to recover |

### API layer / operation source (the crux)
| Option | | Note |
|---|---|---|
| tRPC routers | Y | trpc-routers |
| Next Route Handlers (app/api) | Y | next-route-handlers |
| Next Pages API routes | Y | next-pages-api |
| Astro endpoints (`src/pages/**/*.ts`) | Y | **astro-pages** (exported GET/POST/... functions) |
| TanStack Start server routes | Y | **tanstack-server-routes** (`createAPIFileRoute`/`createServerFileRoute` explicit-path forms) |
| Exported react-query/SWR hooks over fetch | Y | request-hooks (useQuery/useMutation + fetch helper) |
| REST via axios service classes ◆ | Y | **axios-services** producer (`this.<verb>(url, data)`; TS body via `_inputType`) |
| REST via bare fetch / ky wrappers | N (M) | un-hooked call sites (too scattered to name reliably) |
| Next Server Actions / TanStack `createServerFn` | N | deliberately skipped: RPC to a framework-internal id, no stable callable URL -- DOM tier only |
| OpenAPI / Swagger JSON spec | Y | **openapi-spec** (paths → typed ops; $ref + allOf resolved) |
| GraphQL operations (Apollo / urql) | Y | **graphql-operations** + widget `graphql` transport; inlines fragments (same-file and imported, across packages, via the symbol resolver). Subscriptions deferred |
| Supabase / Firebase SDK calls | N (L) | SDK method calls, not routes |

### Request typing / schema source
| Option | | Note |
|---|---|---|
| zod | Y | zod-bodies -- creates the field list AND types it |
| TypeScript interfaces / types ◆ | Y* | typescript-types: name correlation, **plus an explicit `_inputType` hint** a producer can hand it (resolved across workspace packages, `Partial<T>` unwrapped). *Enriches a found op; still will not create one. |
| Valibot | Y | **valibot-bodies** (optional/nullish/pipe/picklist) |
| Yup | Y | **yup-bodies** (`.required()` opt-in, `.oneOf` enum, `object().shape`) |
| ArkType | Y | **arktype-bodies** (string DSL: `"count?"` key optional, `'a'\|'b'` enum, `[]` array) |
| GraphQL variables | Y | typed by **graphql-operations** from the `$var: Type` list |
| OpenAPI schema | Y | request bodies read by **openapi-spec** |
| io-ts / JSON Schema / Prisma types | N (M) | |

### Data layer -- refresh after a write
onAfterAction is generic (the host wires it); a synthetic focus event is the
fallback. So "support" here is whether our refresh story *works*, not something
we detect.
| Option | | Note |
|---|---|---|
| TanStack Query (react-query) | Y | invalidateQueries; refetch-on-focus fallback |
| SWR ◆ | Y | mutate(); revalidateOnFocus fallback |
| Next Router cache (router.refresh) | Y | onAfterAction → router.refresh() |
| Apollo Client cache | Y | refetchQueries |
| RTK Query / urql / Zustand / Redux / MobX ◆ | ~ | host wires the refetch in onAfterAction -- no focus magic |
| Raw useEffect + fetch | N | no cache to poke; focus fallback may miss |

### DOM anchoring -- runtime perception & action
This is the widget's *live* tier (`domActions.js`), and it is far richer than
"testId or bust". It is distinct from the *static* readiness-marker harvest,
which is testId-shape-centric. **0 testIds does not kill the DOM tier** -- it
only costs disambiguation of same-labelled controls and statically-harvested
`readyWhen` markers. Everything below is used at runtime.
| Anchor | | Note |
|---|---|---|
| data-testid / data-test-id ◆(=0) | Y | primary disambiguator + readiness marker (`*`-shape); `-undefined` guarded |
| id attribute (domId) | Y | first-class anchor + readiness marker |
| ARIA role (button/link/checkbox/switch/combobox/textbox) | Y | drives the interactive selector |
| aria-label / aria-labelledby | Y | accessible name → label |
| label[for] / wrapping label / placeholder | Y | label↔control association; names inputs & editors |
| semantic tags (button/a/input/select/textarea/contenteditable) | Y | base selector |
| visible text (innerText) / heading-above | Y | last-resort label; heading names rich-text editors |
| landmark roles (nav / main / dialog) | ~ | not a first-class anchor; dialogs reached via re-snapshot |
| stable classes / hashed CSS-in-JS | N | never keyed on (by design) -- unreachable only if NO id/testid/role/label/text |

### Styling isolation -- host compatibility
Largely solved by the default shadow-DOM mount, regardless of host stack:
Tailwind v3/v4, CSS Modules, styled-components/emotion, vanilla-extract,
MUI/Chakra, Panda/UnoCSS, Bootstrap -- all **Y**. The one caveat: global CSS /
Sass under the *light-DOM* `mount="inline"` path needs the `.iv-scope` wrapper
(the exported sheet is scoped for exactly this).

### The two highest-leverage producers -- now SHIPPED

Both of the producers this section used to nominate are built, tested (unit +
an end-to-end `test/integration/planeShape.test.mjs` that guards them against
each other), and in the registry:

1. **`react-router-config` (was RR-v7, S).** Reads `route()/index()/layout()/
   prefix()` config and `createBrowserRouter([{ path, element }])` objects,
   joining inline nesting and collecting routes across the files a merged tree
   is split over. Unlocks voice **navigation** for the React-Router-v7 world.
2. **`axios-services` (was axios-service-class, L).** Model `class ... {
   this.<verb>(url, data) }` methods into queries/actions -- endpoint and url
   params from the template literal, query params from an axios config object,
   collision-safe names, and the body param's TS type recorded as `_inputType`
   for the TypeScript enricher (which now resolves it across workspace packages
   and unwraps `Partial<T>`). Unlocks the whole SPA-over-REST class.

A second round then widened coverage further, all through the same seam:
- **`tanstack-router`** -- `createFileRoute('/posts/$postId')` and
  `createRoute({ path })`, with `$param` normalised to the `:param` the widget's
  navigation understands. Covers TanStack Router SPAs and TanStack Start routing.
- **`openapi-spec`** -- when an app ships an OpenAPI/Swagger JSON spec it is the
  cheapest producer of all: paths, methods, parameters AND request bodies are
  already written down and typed. Resolves `$ref` and merges `allOf`; drops
  `readOnly` (response-only) fields. JSON only -- a YAML spec would need a parser
  dependency the package does not carry.
- **`valibot-bodies`**, **`yup-bodies`**, **`arktype-bodies`** -- the rest of the
  validation-schema field, beside `zod-bodies`.

A third round added **GraphQL**, the one gap that was more than a producer: the
**`graphql-operations`** producer reads `gql` operation documents (name, kind,
typed variables) and the widget gained a **`graphql` transport** that POSTs the
document with the model's arguments as `variables`, unwrapping `data` and
raising the `errors` array. Built together on purpose -- a producer alone would
have emitted addressable-but-uncallable ops, the Server-Actions trap. Only
every emitted GraphQL op is faithfully reproducible; the query document ships in
the manifest but the catalog projection keeps it out of the prompt. Follow-up
rounds taught the producer to **inline fragments** -- first same-file
(transitively), then imported ones, resolved across files and workspace packages
through the same symbol resolver zod uses for cross-package schemas -- so an
operation that splices in shared fragments is reconstructed and emitted rather
than skipped. Only a fragment that resolves to no gql document on disk leaves
its operation unemitted. A **remix-fs-routes** producer also landed, reading the
filename-convention routing Remix and `@react-router/fs-routes` apps use.

Two meta-frameworks followed. **astro-pages** reads `src/pages/**`: the
`.astro`/`.md`/`.mdx` files are navigation routes, and the `.ts`/`.js` files that
export `GET`/`POST`/... are real HTTP endpoints -- both callable, one producer.
**tanstack-server-routes** reads TanStack Start's `createAPIFileRoute` /
`createServerFileRoute` explicit-path API routes (its page routing was already
covered by `tanstack-router`). Both frameworks' RPC-style server functions
(`createServerFn`, like Next Server Actions) are left alone: they resolve to a
framework-internal id, not a URL the widget can call, so emitting them would be
the addressable-but-uncallable trap.

The Plane shape that motivated all of this went from **0 routes / 0 actions** to
a full manifest on a fixture that mirrors it (RR-v7 routes + axios services +
sibling-package types). Plane itself was pulled from `/library` before a final
run against the real source, so that last validation is on a faithful fixture,
not the app.

### The next candidates (still captured, not committed)
- **GraphQL subscriptions** -- skipped, because a subscription is a stream, not
  a request/response call the widget can make and read once.
- **RR-v7 / TanStack / Remix static readiness** -- the routing producers give
  navigation; DOM readiness markers for those routes still come only from the
  live tier.
- **YAML OpenAPI** -- only if a dependency is acceptable; JSON covers most.
- **Supabase / Firebase SDK calls** -- SDK method calls, not routes.

The trigger to build any of these is the same as before: a real app we want that
needs it.

---

## 4. Navigation: fill route params from live context, and what is still flat

Workspace/org/tenant-scoped apps (Plane is the archetype) parameterise nearly
every route -- `/:workspaceSlug/projects`, `/:workspaceSlug/profile/:userId`.
The manifest ships the PATTERNS; the model has no live value for the params. So
"take me to my work" used to send `/:workspaceSlug/...` straight to the router,
which matched nothing and bounced to not-found -- "went somewhere completely
different." This is framework-agnostic: our producers normalise every dynamic
segment to `:param`, so a Next `[id]`, a react-router-dom `:id` and Plane's RR8
route all hit it identically.

### Built (widget, `routes.js` + the navigate handler)

`planNavigation(args, routes, currentPath)` fills a target route's `:params`
before anything reaches the router, from two sources, args winning:

- **the current URL** -- the `:workspaceSlug` (etc.) the user is already standing
  in is reused for free, matched by binding `location.pathname` against the
  manifest route it fits. The model never has to know it.
- **the model's args** -- a `projectId` it resolved via a list query, passed flat
  or under `params`.

A param neither source fills is a HOLE, and a path with a hole is **refused, not
navigated**: the handler returns "no value for `userId` -- resolve it or do it on
the screen" instead of landing on not-found. Same principle as the probe
planner's brace check: never send a template literally. This is the general fix
for the whole class, not a Plane patch.

### Still flat -- the wired/unwired boundary

- **Routes do not tier.** Operations get grouping + `expand({topic})` via the
  relay catalog (`operations()` = queries + actions only); routes are dumped as
  a flat list in the base prompt (`tools.js` `routeList`), reading only
  `path`/`description`. A route's `group` field is silently ignored. So the only
  lever to keep the navigable set small is PRUNING (`drop`, §skill), not
  expand-into-topics. Wiring route grouping is a relay (`routeList` → the topic
  tree) + widget (`expandTopic` include routes) change -- medium, deferred until
  an app has too many real destinations to prune.
- **Reachability is prose, not a marker.** Operations render `[screen only]` from
  `confidence`; a route cannot be marked screen-only structurally -- the "reach
  by the nav item" steer lives only in the description text. The model reads it;
  nothing acts on it automatically.
- **No live screen context (deferred #2).** The model still cannot SEE the page.
  Filling `:workspaceSlug` from the URL is the cheapest slice of that idea; the
  full version (a DOM snapshot / screen context on navigate) is deferred for its
  per-turn token cost -- it lives in the growing conversation, not the cached
  prefix. When built, the right shape is a cheap navigate-result context (landed
  URL + resolved params + heading) always, and a full snapshot only on demand or
  on an unexpected landing.

### The missing-query corollary

Some params are unfillable from ANY source -- Plane's "your work" needs the
current user's id and no query returns it. Two honest answers, both upstream of
navigation: the judgement pass adds a `usersMe` query so the id is resolvable, or
it marks the page "reach by the nav item" and the model clicks it (a DOM tier
job, which needs the model to see the screen -- back to #2). Param-filling makes
the reachable routes reachable; it does not invent values that do not exist.
