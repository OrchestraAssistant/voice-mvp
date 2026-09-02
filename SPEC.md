# SPEC — voice control for React apps

What the system is, how the parts fit, and what each one is responsible for.
For *decisions* (and the alternatives rejected), see
[DESIGN-CHOICES.md](DESIGN-CHOICES.md). For *running it*, see
[README.md](README.md).

---

## 1. The product

A dev installs a package into their React app. Their users can then talk to
the app: navigate it, fill and submit its forms, read its data, trigger its
write actions — by voice, in real time.

The bet is that an agent driving a *specific* app well beats a generic
screen-reading agent, because the app's own source already describes what it
can do. So the product is two halves:

- **Build time** — static analysis reads the app's source and produces a
  manifest of its routes, read queries and write actions.
- **Run time** — a realtime voice model receives that manifest as its
  function-calling tool list, and a browser widget executes the calls.

## 2. Two tiers of capability

**Tier 1 — DOM fallback.** Generic primitives (`dom_snapshot`, `dom_click`,
`dom_type`) let the model perceive and operate whatever is on screen. Works
anywhere, less reliable, and blind between calls: the model sees nothing of
the page unless it explicitly calls `dom_snapshot`, which returns a JSON list
of visible interactive elements — never pixels.

**Tier 2 — the manifest.** Named, typed actions derived from the app's source
(`action_createTask`, `query_tasks`). Fast and reliable, because they call
the app's real endpoints rather than improvising clicks.

The model is instructed to prefer Tier 2 and fall back to Tier 1. A **Tier 3**
(the host registering real backend endpoints directly, bypassing the browser)
was designed but is not built.

## 3. Architecture

Four buckets, split by what ships and to whom:

```
packages/voice/       THE PRODUCT      → npm, to devs      (@yourco/voice)
packages/voice-cli/   THE TOOLING      → npm, to devs      (@yourco/voice-cli)
relay/                YOUR SERVICE     → ships to nobody; devs get a URL
demo-app/ + demo-api/ SHOWCASE + TEST  → ships to nobody
```

Data flow for one spoken command:

```
  voice ─► OpenAI Realtime (WebRTC, browser ⇄ OpenAI directly)
              │  emits function_call
              ▼
       widget executes it
        ├─ query_*/action_*  → fetch() the app's own API
        ├─ dom_*             → operate the live DOM
        └─ navigate          → host's router
              │  result JSON
              ▼
       back into the session, model speaks the outcome
```

The relay is **not** in the audio path. It is only touched at session start.

## 4. The manifest

Generated into `<app>/.voice/manifest.json`. Shape:

```jsonc
{
  "routes":  [{ "path": "/tasks/:id", "component": "TaskDetail" }],
  "queries": [{
    "name": "tasks", "description": "...", "method": "GET",
    "endpoint": "/api/tasks",
    "params": [{ "name": "search", "type": "string",
                 "required": false, "source": "query-string" }]
  }],
  "actions": [{
    "name": "deleteTask", "description": "...", "method": "DELETE",
    "endpoint": "/api/tasks/{id}",
    "requiresConfirmation": true,
    "params":     [{ "name": "id", "type": "string", "required": true, "source": "url" }],
    "bodyFields": [{ "name": "done", "required": false, "type": "boolean" }]
  }]
}
```

- `endpoint` may contain `{param}` placeholders, filled from `params` where
  `source: "url"`. `source: "query-string"` params are appended as a query
  string. `bodyFields` become the JSON body.
- **queries are read-only and safe to auto-run; actions are writes.** That
  split drives the confirmation policy and is the single most important
  distinction in the file.

### What the extractor actually reads

`packages/voice-cli/generate.js`, Babel AST over the app's source. It targets
recognisable patterns, not arbitrary JavaScript:

| from | it extracts |
|---|---|
| `<Route path element>` JSX | routes |
| React Query `useQuery`/`useMutation` calling a `request(url, opts)` helper | queries/actions, method, endpoint |
| module-level string consts (e.g. `BASE = "/api"`) | inlined into endpoints |
| Zod schemas co-located with the form that submits them | `bodyFields` + types + required |
| HTTP method | `requiresConfirmation` heuristic: `DELETE` → `true` |

Anything outside those patterns (GraphQL, tRPC, Redux, non-Zod forms) is not
extracted — deliberately, that's Tier 1's job.

**The manifest is generated, then hand-corrected.** Regenerating overwrites
corrections; there is no merge step. This is a known rough edge (see README).

## 5. The relay

`relay/index.js`, one job: mint an ephemeral OpenAI Realtime session.

- `POST /voice/session` — reads the manifest, builds the tool list and system
  instructions, calls `https://api.openai.com/v1/realtime/client_secrets`
  with `OPENAI_API_KEY`, returns the ephemeral token.
- `GET /voice/manifest` — serves the manifest to the widget.

Two reasons it is server-side and not in the browser:

1. `OPENAI_API_KEY` never reaches a client.
2. **The tool list and confirmation policy are attached here**, so a tampered
   browser cannot redefine its own tools or drop a `requiresConfirmation`
   flag. The server is authoritative about what the agent may do.

Model defaults to `gpt-realtime`; input transcription `gpt-live-transcribe`.
After minting, the browser negotiates WebRTC directly with
`https://api.openai.com/v1/realtime/calls` using the ephemeral key.

## 6. Tool surface

Built by `relay/tools.js` from the manifest, plus fixed primitives:

| tool | kind | notes |
|---|---|---|
| `query_<name>` | Tier 2 read | safe, auto-runs |
| `action_<name>` | Tier 2 write | may require confirmation |
| `navigate(path)` | routing | host's `navigate`, or `pushState` fallback |
| `dom_snapshot()` | Tier 1 | JSON list of visible interactive elements |
| `dom_click(elementId)` | Tier 1 | ids come from the last snapshot |
| `dom_type(elementId, text)` | Tier 1 | native-setter trick so React sees it |
| `confirm_pending_action()` | gate | executes the staged destructive action |
| `cancel_pending_action()` | gate | discards it |

### The confirmation gate

For an action with `requiresConfirmation: true`, the first call **does not
execute**. The widget stages it and returns `{status: "needs_confirmation"}`;
the model asks the user; only `confirm_pending_action` performs the write.
The side effect lives solely in the confirm handler, so a misbehaving model
cannot double-execute — worst case it never confirms, which is safe.

## 7. Mic modes

One realtime session throughout; switching modes never reconnects, so history
and instructions survive. Implemented by toggling `turn_detection` via
`session.update` plus muting the local track.

| mode | resting state | turn ends when |
|---|---|---|
| `continuous` | mic live | server VAD detects ~200ms silence |
| `ptt` | mic muted | you release the button (explicit commit) |
| `ptnt` | mic live | VAD, but held = muted ("don't hear this") |

`Ctrl+Space` mirrors the hold button globally. PTT commits with
`input_audio_buffer.commit` + `response.create`, and cancels any in-flight
response on press (barge-in).

Note `server_vad` is **acoustic**, not semantic: `threshold` is energy,
`silence_duration_ms` is a fixed timer. `semantic_vad` exists as a one-line
alternative if end-of-turn detection feels wrong.

## 8. Public API

```jsx
import { VoiceProvider, InterpreterBubble, ListeningGlow,
         isListening, useInterpreter } from "@yourco/voice";
import "@yourco/voice/styles.css";
```

**`<VoiceProvider>`** — required ancestor. All props optional:

| prop | purpose |
|---|---|
| `relayUrl` | relay origin; `""` = same origin (dev proxy) |
| `navigate(path)` | host's router; falls back to `pushState` + `popstate` |
| `onAfterAction()` | host refreshes its own cache after a write |
| `onToolCall(name, args, result)` | fires for **every** tool call |
| `onTranscript({role, text})` | every completed turn |
| `onPendingAction(action \| null)` | staged / resolved |
| `onModeChange`, `onStatusChange` | mic mode, connection status |

It deliberately does **not** import react-router or react-query — a host
using neither still works.

**`useInterpreter()`** — the headless API; the built-in UI has no privileged
access. Returns `status`, `transcript`, `pendingAction`, `error`, `manifest`,
`mode`, `holding`, and `start`, `stop`, `sendText`, `setMode`, `holdStart`,
`holdEnd`, `confirmManually`, `cancelManually`.

**Components** — `<InterpreterBubble>` (default drop-in: icon pill expanding
into a tabbed panel), `<InterpreterPanel>` (flat panel, unpositioned),
`<ListeningGlow active>` (screen-edge rim) + `isListening({status, mode,
holding})`.

## 9. Host isolation

The widget renders into a **closed shadow root** on `<body>` via
`ScreenOverlay`, not the host's React tree, because a host's ordinary
`button {}` / `form {}` rules otherwise reach in and win. `ScreenOverlay`
also pins its host element with inline `!important`, promotes into the top
layer via the popover API, and re-attaches if the host wipes `<body>`.

Consequences to know before touching it:

- Events **retarget** to the overlay host, and a *closed* root also truncates
  `composedPath()` — so "is this click inside us?" is answered by
  `event.target === overlayHost`, nothing else works.
- `pointer-events: none` is pinned on the host so the rim never eats clicks;
  interactive subtrees opt back in with `pointer-events: auto`.
- Inherited properties (`color`, `font`) still cross the boundary.

`<InterpreterBubble mount="inline">` renders in the host tree instead, kept
so the difference stays demonstrable (`/` vs `/?mount=inline`).

## 10. Not built

Deliberately out of scope so far: the exploration crawler (navigation graph
built by driving the app), React fiber/state introspection, Tier 3 direct API
hooks, and a real control plane (the relay reads the manifest off disk — no
versioning, rollback, tenancy or `push`).
