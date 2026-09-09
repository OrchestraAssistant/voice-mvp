# Design philosophy

The standing principles behind the choices. DESIGN-CHOICES.md records what was
decided; this records why the decisions tend to come out the way they do. When
the two disagree, this document is the tie-breaker.

---

## 1. Best-effort with the tools at hand, not perfect-or-nothing

A problem does not have to be solved completely to be solved. The alternative
to a perfect solution is usually not "wait until one exists" -- it is a partial
solution that helps today and names what it does not cover. We take the
partial one.

This has a direct consequence for how features are shaped: **offer several
paths for people with different tools, rather than one path that assumes
everyone has the same ones.** A capability that only works with a paid service,
a particular framework, or a browser on the machine is still worth building --
as long as it degrades honestly for whoever lacks that tool, and says what they
are missing rather than failing blank.

Concretely, across this codebase already:

- The static analyser extracts what it can from source and reports what it
  could not, rather than refusing an app it does not fully understand.
- The probe uses a real browser when one is present and skips, with a reason,
  when none is -- CI is a normal place to have no browser.
- The widget prefers a manifest-declared tool, falls back to DOM actions when
  the manifest is silent, and says so.

None of these is complete. Each is the best available with the tools actually
in hand, and each is honest about its edge.

## 2. Use the actor the user already has, including an LLM agent

Very capable, code-literate LLM agents are common in development right now.
That is a tool most of our users have, and a feature may lean on it -- the same
way another feature may lean on a browser or a test-id convention. Leaning on
it is not cheating, any more than requiring Node is.

The rule is the same as principle 1: lean on it as ONE path, not the only one.
Where an intelligent pass would help, ship it as something an agent can run
(a skill, a documented prompt, a checklist) AND leave the door open for a human
to do the same work by hand. A team with an agent gets it cheaply; a team
without does it themselves; nobody is blocked. That some users have more
powerful tools than others is simply true, and designing for the least-equipped
by refusing to use anything better serves no one.

## 3. The worked example: how a manifest should actually be built

The manifest is where these principles first bite, because a big app defeats
any single method.

- **Static analysis** finds the operations -- routes, queries, actions -- from
  source. It is exhaustive and cheap and knows nothing about what matters.
- **Probing** confirms them against the running app and measures what source
  cannot: which routes are real, what a page needs to be ready, what a write
  truly requires.
- **An intelligent pass** -- human or LLM agent -- does the one thing neither
  of the above can: judge. Which twenty of two hundred operations a person
  would actually speak to; which tier each belongs in; what a tool is FOR, in
  a sentence, rather than "Auto-detected tRPC mutation schedule.update".

So the optimal pipeline is **static + probing + a human-or-agent pass**, in
that order, each doing only what it is good at. The first two are mechanical
and ship in the CLI. The third is judgement, so it ships as a skill an agent
can run and a procedure a human can follow -- and the manifest format has to
carry its output (tiers, real descriptions, an include list) as first-class
fields, not as an afterthought bolted on by hand.

This is why "no cheating -- generate and probe only" produced 177 empty tool
shells that broke a live session: we had removed the third stage entirely.
The lesson is not that the third stage is a crutch. It is that judgement is a
real stage of the work, and pretending a machine that cannot judge will
nonetheless produce a judged result is the actual mistake.

## 4. "Known" API means the call succeeds AND the UI reflects it

We prefer the API path when we trust it: it is one deterministic request, not a
fragile sequence of clicks. But "the call succeeded" is not the whole of trust.
An API call changes the server; it does not necessarily change what the user is
looking at.

Most SPAs hold a client-side cache -- React Query, SWR, Apollo, RTK Query. The
app's OWN mutations invalidate the relevant keys and refetch, so the UI updates.
But a mutation WE make out-of-band is invisible to that cache: the server changed
and the screen did not. A few apps push updates over SSE/WebSocket and would
reflect it automatically, but that is the exception, not the rule. So a
successful API call can leave the user staring at stale data -- which, to them,
looks like the action did nothing.

Two answers, and we already built one:

- **`onAfterAction` is the bridge.** After every action the widget calls
  `onAfterAction?.()` -- "let the host refresh whatever cache it keeps; it knows,
  we don't." The developer wires it to their `invalidateQueries()` (or
  equivalent) and the UI catches up. It is the designed seam, but it depends on
  the developer wiring it, so it belongs prominently in the setup guide.
- **The DOM path keeps the UI in sync for free**, because doing the action
  through the app's own controls fires the app's own handlers, which update its
  cache the normal way. So this is a genuine case where DOM beats API: the API is
  faster to DO, but the DOM is what the app NOTICES.

The consequence for the confidence tiers: an operation is fully `known` only when
its result becomes visible -- the app has `onAfterAction` wired, or an SSE
channel, or the like. Absent that, a mutation whose outcome the user must SEE is
a point for the DOM path, even when the API call itself is perfectly specified.
Trust is end-to-end, not server-deep.
