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
