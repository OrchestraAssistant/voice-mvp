# Providers — the voice-to-action contract

`@yourco/voice` is a **core** (a React widget, a browser executor, a
confirmation gate, a manifest runtime) with a **swappable provider** for the
voice-to-action pipeline — the same shape the Vercel AI SDK has (`ai` core +
`@ai-sdk/openai` / `@ai-sdk/anthropic` / custom providers). You pick a provider,
or you bring your own.

```
   voice in ──►  [ PROVIDER ]  ──► decided tool call ──►  [ EXECUTOR ]  ──► your app
                 (swappable)          onToolCall()          (core)        API + DOM
                      ▲                                          │
                      └──── transcripts / activity ────► [ UI ] (core)
```

A provider is everything between "audio in" and "a decided tool call." Nothing
else varies.

## What the core owns, always

These never move with the provider, and that is the point:

1. **The manifest** — the app as data, the single source of truth. A provider
   *reads* it; it does not define the app.
2. **The executor** — `executeTool` + transports + `domActions`. Tool calls run
   **in the browser**, against the app's own API (the user's cookies) and the
   live DOM. A provider never executes a tool; it only *proposes* one.
3. **The confirmation gate** — destructive actions stage in the executor and wait
   for a yes. A provider cannot bypass it. **BYOA is not BYO-security-holes.**
4. **The UI** — `VoiceProvider` state, the rim, the panel — driven by callbacks.

## What a provider owns

1. A client **`VoiceSession`** — the transport and the live voice loop.
2. A server **half**, if it needs credentials — where keys live (see BYOK). For
   the OpenAI Realtime provider this is the relay; a cascade provider might reuse
   the app's own backend; a local provider may need none. **The relay is part of
   the OpenAI provider, not the framework.**

---

## The contract

A provider is a plain object (usually returned by a factory you configure):

```ts
type VoiceProviderFactory = (options?: object) => VoiceProviderSpec;

interface VoiceProviderSpec {
  id: string;                                   // "openai-realtime"
  capabilities: Capabilities;                   // what the UI may offer
  mint?(deps: ProviderDeps): Promise<Minted | null>;   // optional: pre-acquire a credential
  connect(deps: ProviderDeps): Promise<VoiceSession>;  // open the live session
}
```

`mint` is an optional optimisation: acquire a short-lived credential ahead of
time (the OpenAI provider mints an ephemeral key on hover) so the first "talk" is
fast. A provider with no credential omits it.

### `ProviderDeps` — what the core hands the provider

```ts
interface ProviderDeps {
  manifest: Manifest;            // the app as data
  toolCatalog: ToolCatalog;      // manifest projected to a neutral tool list (provided)
  callbacks: {
    onToolCall(name: string, args: object): Promise<Result>;  // THE contract — runs in the browser
    onTranscript(turn: { role: "user" | "assistant"; text: string }): void;
    onActivity(a: { userSpeaking: boolean; agentBusy: boolean }): void;
    onStatus(s: "connecting" | "ready" | "closed" | "error"): void;
    onHangUp(info: { because: string }): void;
    onEvent?(event: object): void;              // structured log stream, optional
  };
  initialMode: "continuous" | "ptt" | "ptnt";
  withMic: boolean;              // false = warm the connection without listening
  minted?: Minted | null;        // a handle from mint(), if any
  signal: AbortSignal;
}
```

`onToolCall` is the whole game: whenever the provider's model decides an action,
it calls this and awaits the result. That call lands in the core's executor —
which routes it to the manifest (`run_query`/`run_action`), the DOM (`dom_*`), or
the host router (`navigate`), enforces the confirmation gate, and returns a JSON
result the provider feeds back to its model. **A provider that can fire
`onToolCall` and stream `onTranscript`/`onActivity` is a complete provider.**

### `VoiceSession` — what `connect` returns

The live controls the UI drives. These are the least-common-denominator of a
voice session; a provider implements what it can and declares the rest absent via
`capabilities`.

```ts
interface VoiceSession {
  stop(): void;                       // tear down; nothing may speak after
  sendTextTurn(text: string): void;   // a typed turn (if capabilities.textInput)

  // microphone
  attachMic(): Promise<MediaStreamTrack>;
  releaseMic(): Promise<void>;        // release the mic, keep the connection
  hasMic(): boolean;
  setMicEnabled(enabled: boolean): void;   // mute / unmute

  // turn-taking (push-to-talk / push-to-not-talk)
  setTurnDetection(auto: boolean): void;   // server-VAD (true) vs manual (false)
  clearInputBuffer(): void;                // PTT press: begin a held turn
  commitAndRespond(): void;                // PTT release: finalise and answer

  // barge-in
  cancelResponse(): void;             // interrupt what the model is saying
}
```

The method names lean on the voice-session vocabulary, not any one vendor's wire
protocol; a cascade provider implements `clearInputBuffer`/`commitAndRespond` as
"start/finish a held turn" over its own transport, `cancelResponse` as "stop the
TTS + abort the in-flight generation," and so on.

### `Capabilities` — so the UI adapts

```ts
interface Capabilities {
  pushToTalk: boolean;   // can it do manual turn-taking?
  bargeIn: boolean;      // can it be interrupted mid-response?
  textInput: boolean;    // does sendTextTurn do anything?
  warm: boolean;         // is mint()/pre-warm meaningful?
}
```

The core hides the controls a provider cannot honour (no push-to-talk button if
`pushToTalk` is false) instead of showing dead UI. A weaker provider degrades; it
does not break.

### `ToolCatalog` — the neutral projection

The core hands the provider the manifest already projected to a neutral list, so
a provider does not re-derive it:

```ts
type ToolCatalog = Array<{
  name: string;
  kind: "query" | "action";
  description: string;
  params: Param[];
  bodyFields?: Param[];
  destructive: boolean;   // from requiresConfirmation
  group?: string[];       // the topic, on a large app
}>;
```

Most providers re-project this into *their* model's tool format — OpenAI function
schemas, a JEV `choice` question, a Pipecat tool list. The **manifest stays the
single source**; only the projection is provider-specific. (For the OpenAI
provider, that projection lives server-side in the relay, so the tool list the
model sees is authoritative and a tampered browser cannot redefine it.)

---

## BYOK — keys never touch the browser

One rule makes bring-your-own-key universal: **any call that needs a credential
goes through the provider's server half; the browser half is always keyless.**

- `provider.mint`/`connect` reach a server endpoint the app configures (the
  "broker"). That endpoint holds the key, reads it from its own environment, and
  returns only a short-lived handle.
- **OOTB:** the relay is the broker. BYOK means running it with *your*
  `OPENAI_API_KEY` (and, if exposed, a `VOICE_RELAY_SECRET` — see the README's
  "Securing the relay").
- **BYOA:** point the broker at *your* endpoint (your Pipecat server, your own
  proxy). Your key, your infra.
- Even a "client-side" cascade routes its LLM/STT/TTS calls through the broker —
  otherwise the key would be in the page. That single rule holds for every
  provider.

---

## BYOA — build your own provider

Implement the factory and hand it to the widget:

```jsx
import { VoiceProvider } from "@yourco/voice";

const myProvider = () => ({
  id: "my-cascade",
  capabilities: { pushToTalk: true, bargeIn: true, textInput: true, warm: false },
  async connect({ toolCatalog, callbacks, withMic, signal }) {
    // 1. open your transport / start your STT-LLM-TTS (or Pipecat) loop
    // 2. project toolCatalog into your model's tool format
    // 3. when the model decides an action:
    //       const result = await callbacks.onToolCall(name, args);
    //       // feed result back to your model
    // 4. stream callbacks.onTranscript / onActivity / onStatus as they happen
    return {
      stop() { /* tear down */ },
      setMicEnabled(on) { /* mute */ },
      setTurnDetection(auto) { /* VAD vs PTT */ },
      clearInputBuffer() {}, commitAndRespond() {}, cancelResponse() {},
      attachMic: async () => {/*...*/}, releaseMic: async () => {}, hasMic: () => true,
      sendTextTurn(text) { /* a typed turn */ },
    };
  },
});

<VoiceProvider manifest={manifest} provider={myProvider()}> <Interpreter/> </VoiceProvider>
```

That is the whole surface. If your provider can fire `onToolCall` and stream
transcripts, the rim, the panel, the confirmation gate, navigation, and every
transport work unchanged — because none of them ever knew which provider they had.

---

## Package split

Modelled on the AI SDK (`ai` + `@ai-sdk/*`):

```
@yourco/voice            core: the widget, the executor, the gate, the manifest runtime
@yourco/voice-cli        the manifest generator (build-time)
@yourco/voice-openai     the OpenAI Realtime provider + its relay      (the reference)
@yourco/voice-cascade    an STT-LLM-TTS / JEV-cascade provider         (planned)
@yourco/voice-pipecat    a Pipecat bridge provider                     (planned)
```

The relay ships **inside** `@yourco/voice-openai`, not the core.

---

## Where voice is NOT the AI SDK (read this before designing a provider)

1. **Session, not call.** AI SDK providers are request/response over messages.
   A realtime voice provider is a **live, full-duplex, stateful session** — VAD,
   turn-taking, barge-in, audio in *and* out. Hence `connect() → VoiceSession`
   rather than `doStream(messages)`. AI SDK's speech/transcription are one-shot;
   there is no standard provider interface for full-duplex realtime voice — this
   is it.
2. **Tool execution is local and fixed.** The provider proposes tool calls via
   `onToolCall`; the *core* executes them in the browser (cookies + DOM). A
   **server-brain** provider (Pipecat) must therefore **bridge** its model's tool
   calls down to the browser and the result back up. The interface supports it —
   `onToolCall` is just fired from the provider's transport — but that bridge is
   the real work for a server-side pipeline.
3. **Safety is the core's, not the provider's.** The confirmation gate lives in
   the executor, so a custom provider can only ever *propose* a destructive
   action; the core stages and confirms it.

---

## Status

- **Shipped:** the contract (`packages/voice/src/providers/contract.js`) and the
  reference **`openaiRealtime`** provider (`providers/openaiRealtime.js`),
  wrapping the existing realtime client + relay mint.
- **Next:** route the core `VoiceProvider` component through the provider as its
  single path (today it still calls the realtime client directly). That is the
  `VoiceProvider` god-component refactor — it is heavily source-asserted in tests,
  so it moves deliberately, converting those tests to behavioural as it goes.
- **Then:** the first non-OpenAI provider (`@yourco/voice-cascade`), which also
  proves the tool-schema projection and capability negotiation on a second stack.
