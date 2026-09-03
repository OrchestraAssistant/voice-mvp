import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { connectRealtimeSession, isUsable, mintSession } from "./realtimeClient.js";
import { OverlayProvider } from "./ScreenOverlay.jsx";
import { createRelayLogger } from "./relayLog.js";
import { resolveRoutePath } from "./routes.js";
import * as dom from "./domActions.js";

const InterpreterContext = createContext(null);

function buildUrl(template, args) {
  let url = template;
  for (const [key, value] of Object.entries(args)) {
    url = url.replace(`{${key}}`, encodeURIComponent(value));
  }
  return url;
}

async function apiFetch(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

/**
 * VoiceProvider mounts the interpreter for the app it wraps. Everything it
 * exposes is reachable through the `useInterpreter()` hook, so a consumer
 * never has to touch this component directly to build a custom UI.
 *
 * Optional callback props are the escape hatch for side effects that
 * aren't about rendering at all -- analytics, toasts, syncing an external
 * store -- fired at the same points the internal state updates, so they
 * never depend on any UI actually being mounted:
 *
 *   onToolCall(name, args, result)  -- fires after every tool call the
 *     model makes resolves, whatever kind it is (query/action/DOM/nav).
 *   onTranscript({ role, text })    -- fires for every completed turn.
 *   onPendingAction(action | null)  -- fires when a destructive action is
 *     staged for confirmation, and again with null when it's resolved.
 *   onModeChange(mode)              -- fires on continuous/ptt/ptnt switch.
 *   onTransportChange(transport)    -- fires on connection state change. Not the
 *     same as "the mic is live"; see isListening().
 *
 * Two host integration points, both optional, both injected rather than
 * imported. The widget deliberately does not depend on react-router or
 * react-query -- a host app may use neither, and a package that imports
 * them would force both on everyone who installs it:
 *
 *   relayUrl           -- origin of the voice relay ("" = same origin, the
 *     default, which suits a dev proxy; set it to your hosted relay in
 *     production since the host app won't be on the same domain).
 *   navigate(path)     -- how this app changes route. Defaults to a plain
 *     history.pushState + popstate, which works anywhere but won't
 *     re-render a router that isn't listening for it; pass your router's
 *     navigate (e.g. react-router's useNavigate()) for a real SPA nav.
 *   onAfterAction()    -- called after any write action succeeds, so the
 *     host can refresh whatever cache it keeps (e.g. react-query's
 *     queryClient.invalidateQueries).
 */
export function VoiceProvider({
  children,
  relayUrl = "",
  navigate: navigateProp,
  onAfterAction,
  onToolCall,
  onTranscript,
  onPendingAction,
  onModeChange,
  onTransportChange,
  logToRelay = false,
  /**
   * How much of the connect to do before the user asks to talk.
   *
   *   "off"    nothing until the Talk button. ~1.6s of dead air on the click.
   *   "open"   mint AND connect when the panel opens; only the microphone is
   *            left for the click.
   *   "eager"  mint on mount and keep a fresh key; connect when the panel
   *            opens. Same click as "open", but the panel-open connect is
   *            shorter by the whole mint.
   *   "hover"  mint on mount; connect when the pointer reaches the pill, which
   *            is earlier than the click that opens it. Costs a connect for
   *            anyone whose cursor merely crosses that corner of the screen.
   *
   * The microphone is never taken early in any of them. You could, silently,
   * for users who have already granted permission -- and it lights the OS
   * recording indicator, which is how a widget gets distrusted.
   */
  warmup = "hover",
}) {
  const [manifest, setManifest] = useState(null);
  // What the relay is willing to offer. Fetched rather than hard-coded so the
  // list of models stays a server-side decision.
  const [options, setOptions] = useState({ models: [], languages: [], defaults: {} });
  const [model, setModelState] = useState(null); // null = the relay's default
  const [language, setLanguageState] = useState("auto");
  // TRANSPORT only: is the realtime connection up. Deliberately says nothing
  // about whether a microphone is attached to it, because those come apart --
  // a session can be established and held with no mic on it at all. Conflating
  // the two is what made `status === "connected"` mean "listening", which is
  // wrong the moment a connection exists before the user has asked to talk.
  const [transport, setTransport] = useState("idle"); // idle | connecting | ready | error
  // Whether a microphone is attached to the session. Combined with mode and
  // holding by isListening(), which is what should drive any "we can hear you"
  // affordance.
  const [micAttached, setMicAttached] = useState(false);
  // Observed, not inferred: both halves come from event pairs the server
  // sends. Fed to rimState() to pick which palette the rim wears.
  const [activity, setActivity] = useState({ userSpeaking: false, agentBusy: false });
  const [transcript, setTranscript] = useState([]);
  const [pendingAction, setPendingActionState] = useState(null); // { name, description, args }
  const [error, setError] = useState(null);
  const [mode, setModeState] = useState("continuous"); // continuous | ptt | ptnt
  const [holding, setHolding] = useState(false);

  const sessionRef = useRef(null);
  // A minted key waiting to be redeemed. Not a session and not a connection:
  // no audio, no cost, nothing open. Just a credential with ~10 minutes on it.
  const mintedRef = useRef(null);
  const warmingRef = useRef(null);
  // Created once. Does nothing unless BOTH this flag and the relay's VOICE_LOG
  // are on -- the relay says so in its mint response and the logger obeys.
  const loggerRef = useRef(null);
  if (logToRelay && !loggerRef.current) loggerRef.current = createRelayLogger({ relayUrl });
  const pendingRef = useRef(null); // mirrors pendingAction for use inside the tool-call closure

  // Fallback nav for hosts that don't pass one: updates the URL and fires
  // popstate, which routers that listen to history will pick up. Hosts
  // with a real router should pass `navigate` so SPA nav works properly.
  const navigate = useCallback(
    (path) => {
      if (navigateProp) return navigateProp(path);
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [navigateProp],
  );

  // Callback props are read through refs so their identity churning on
  // every parent render never forces us to re-create executeTool/effects.
  const callbacksRef = useRef({});
  callbacksRef.current = { onToolCall, onTranscript, onPendingAction, onModeChange, onTransportChange, onAfterAction };

  const setPendingAction = (value) => {
    pendingRef.current = value ? { action: value.action, batch: value.batch } : null;
    const publicValue = value
      ? {
          name: value.action.name,
          description: value.action.description,
          args: value.batch[0],
          // How many things this one confirmation covers. A destructive batch
          // is approved once for the whole set -- seven separate "are you
          // sure?" rounds is what this exists to stop.
          count: value.batch.length,
        }
      : null;
    setPendingActionState(publicValue);
    callbacksRef.current.onPendingAction?.(publicValue);
  };

  useEffect(() => {
    fetch(`${relayUrl}/voice/manifest`)
      .then((r) => r.json())
      .then(setManifest)
      .catch((err) => setError(String(err)));
  }, [relayUrl]);

  useEffect(() => {
    fetch(`${relayUrl}/voice/options`)
      .then((r) => r.json())
      .then((o) => {
        setOptions(o);
        setModelState((current) => current ?? o.defaults?.model ?? null);
      })
      .catch(() => {
        // Non-fatal: without options the settings UI simply offers nothing to
        // change, and the relay's own defaults still apply.
      });
  }, [relayUrl]);

  const findQuery = (name) => manifest.queries.find((q) => q.name === name);
  const findAction = (name) => manifest.actions.find((a) => a.name === name);

  const runQuery = async (query, args) => {
    const url = buildUrl(query.endpoint, args);
    const qsParams = query.params.filter((p) => p.source === "query-string" && args[p.name] != null);
    const qs = new URLSearchParams(qsParams.map((p) => [p.name, args[p.name]])).toString();
    return apiFetch("GET", qs ? `${url}?${qs}` : url);
  };

  const runAction = async (action, args) => {
    const url = buildUrl(action.endpoint, args);
    const bodyKeys = action.bodyFields.map((f) => f.name);
    const body = Object.fromEntries(bodyKeys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
    const result = await apiFetch(action.method, url, Object.keys(body).length ? body : undefined);
    // Let the host refresh whatever cache it keeps; it knows, we don't.
    callbacksRef.current.onAfterAction?.();
    return result;
  };

  /**
   * Runs an action once per entry. Sequential rather than parallel: these are
   * writes against the host's API, and a batch of creates that races itself
   * can land in an order the user did not ask for.
   *
   * A single-item batch returns the bare result, so the model sees exactly
   * what it saw before batching existed.
   */
  const runBatch = async (action, batch) => {
    const results = [];
    for (const one of batch) {
      try {
        results.push(await runAction(action, one));
      } catch (err) {
        results.push({ error: String(err.message || err) });
      }
    }
    return batch.length === 1 ? results[0] : { count: results.length, results };
  };

  const executeTool = useCallback(
    async (name, args) => {
      if (!manifest) return { error: "Manifest not loaded yet" };

      if (name === "navigate") {
        const path = resolveRoutePath(args, manifest.routes);
        if (!path) {
          // A real message rather than a React Router stack trace. The model
          // retried an identical malformed call three times against the old
          // error, which told it nothing about what was wrong.
          return {
            error: `Could not find a route in ${JSON.stringify(args)}. Pass { "path": "/settings" }.`,
            knownRoutes: manifest.routes.map((r) => r.path),
          };
        }
        navigate(path);
        // Reporting what we did, not what was asked for, so a salvaged call is
        // visible in the log rather than looking like it worked first time.
        return { status: "navigated", path, ...(path === args.path ? {} : { interpretedFrom: args }) };
      }

      // A signal to the transport layer, already acted on before it got here;
      // surfaced so onToolCall can log what the model decided and why.
      if (name === "answer_aloud") {
        return { acknowledged: true, because: args.because };
      }

      if (name === "dom_snapshot") {
        return { elements: dom.snapshot() };
      }
      if (name === "dom_click") {
        dom.click(args.elementId);
        return { status: "clicked" };
      }
      if (name === "dom_type") {
        dom.typeText(args.elementId, args.text);
        return { status: "typed" };
      }

      if (name === "confirm_pending_action") {
        const pending = pendingRef.current;
        if (!pending) return { error: "Nothing is pending confirmation" };
        setPendingAction(null);
        return await runBatch(pending.action, pending.batch);
      }
      if (name === "cancel_pending_action") {
        setPendingAction(null);
        return { status: "cancelled" };
      }

      if (name.startsWith("query_")) {
        const query = findQuery(name.slice("query_".length));
        if (!query) return { error: `Unknown query: ${name}` };

        return await runQuery(query, args);
      }

      if (name.startsWith("action_")) {
        const action = findAction(name.slice("action_".length));
        if (!action) return { error: `Unknown action: ${name}` };

        // Always a list -- that is the only shape the schema allows, so there
        // is nothing to normalise. The fallback is for a model that ignores
        // the schema, which is not hypothetical: one sent {"/":"dashboard"} to
        // navigate against a perfectly good `path` declaration.
        const batch = Array.isArray(args.items) && args.items.length > 0 ? args.items : [args];

        if (action.requiresConfirmation) {
          setPendingAction({ action, batch });
          return {
            status: "needs_confirmation",
            staged: batch.length,
            // Deliberately does NOT echo the batch back: the model just sent
            // it, and repeating eleven objects costs tokens to tell it what it
            // already knows. It also phrases the question better than we can,
            // because it has the titles and we only have ids -- so this says
            // when to ask, not what to say.
            message:
              `Staged, NOT executed. Ask the user once to confirm ` +
              `${batch.length === 1 ? "this" : `all ${batch.length}`}, naming what will change. ` +
              `Then call confirm_pending_action (no arguments). Do not call ${name} again.`,
          };
        }
        return await runBatch(action, batch);
      }

      return { error: `Unrecognized tool: ${name}` };
    },
    [manifest, navigate],
  );

  // `overrides` exists because a reconnect triggered by changing model or
  // language has to use the NEW value, and the state update has not landed in
  // this closure yet. Reading it from state here would reconnect with exactly
  // the setting the user just changed away from -- silently, and only on the
  // reconnect path, which is the kind of bug that survives a long time.
  /**
   * Keep a usable key in hand. Called on a timer AND before every use, because
   * the timer cannot be trusted: a backgrounded tab has its intervals throttled
   * to roughly one a minute, so a 9-minute refresh may simply not fire. The
   * check at the point of use is the guarantee; the timer is an optimisation.
   */
  const ensureMinted = useCallback(async (overrides = {}) => {
    if (isUsable(mintedRef.current)) return mintedRef.current;
    try {
      mintedRef.current = await mintSession({
        relayUrl,
        model: overrides.model ?? model,
        language: overrides.language ?? language,
      });
      return mintedRef.current;
    } catch {
      // Warming must never surface an error: nobody asked for this yet, and
      // the Talk button will mint again and report properly if it still fails.
      mintedRef.current = null;
      return null;
    }
  }, [relayUrl, model, language]);

  /**
   * Connect with no microphone attached. Safe to call more than once and safe
   * to call when nobody has asked to talk: `micAttached` stays false, so
   * isListening() stays false, so the rim stays dark. That separation is the
   * whole reason the transport/listening split exists.
   */
  const warm = useCallback(async () => {
    if (warmup === "off" || sessionRef.current || warmingRef.current) return;
    warmingRef.current = (async () => {
      setTransport("connecting");
      try {
        const session = await connectRealtimeSession({
          onToolCall: async (name, args) => {
            const result = await executeTool(name, args);
            callbacksRef.current.onToolCall?.(name, args, result);
            return result;
          },
          onStatus: (st) => {
            const next = st === "closed" ? "idle" : st;
            setTransport(next);
            if (next === "idle") setMicAttached(false);
            callbacksRef.current.onTransportChange?.(next);
          },
          onTranscript: (turn) => {
            setTranscript((t) => [...t, turn]);
            callbacksRef.current.onTranscript?.(turn);
          },
          onEvent: (event) => loggerRef.current?.record(event),
          onActivity: setActivity,
          initialMode: mode,
          relayUrl,
          model,
          language,
          minted: await ensureMinted(),
          withMic: false,
        });
        sessionRef.current = session;
      } catch {
        setTransport("idle"); // silent: nobody asked for this
      } finally {
        warmingRef.current = null;
      }
    })();
    return warmingRef.current;
  }, [warmup, mode, relayUrl, model, language, ensureMinted, executeTool]);

  // "eager" mints on mount and keeps it fresh. A key is not a session: nothing
  // is open, nothing is billed, and if it expires unused it costs nothing.
  useEffect(() => {
    if (warmup !== "eager" && warmup !== "hover") return;
    ensureMinted();
    const id = setInterval(ensureMinted, 4 * 60_000);
    return () => clearInterval(id);
  }, [warmup, ensureMinted]);

  const start = async (overrides = {}) => {
    setError(null);
    // Already warm: the only thing left is the microphone.
    await warmingRef.current;
    if (sessionRef.current) {
      try {
        await sessionRef.current.attachMic();
        setMicAttached(true);
      } catch (err) {
        setError(String(err.message || err));
        setTransport("error");
      }
      return;
    }
    setTransport("connecting");
    try {
      const session = await connectRealtimeSession({
        onToolCall: async (name, args) => {
          const result = await executeTool(name, args);
          callbacksRef.current.onToolCall?.(name, args, result);
          return result;
        },
        onStatus: (s) => {
          const next = s === "closed" ? "idle" : s;
          setTransport(next);
          if (next === "idle") setMicAttached(false);
          callbacksRef.current.onTransportChange?.(next);
        },
        onTranscript: (turn) => {
          setTranscript((t) => [...t, turn]);
          callbacksRef.current.onTranscript?.(turn);
        },
        initialMode: mode,
        relayUrl,
        model: overrides.model ?? model,
        language: overrides.language ?? language,
        onEvent: (event) => loggerRef.current?.record(event),
        onActivity: setActivity,
        minted: await ensureMinted(overrides),
      });
      sessionRef.current = session;
      // Today the mic is acquired as part of connecting, so this is true as soon
      // as the session exists. It is tracked separately so that stops being an
      // assumption the rest of the widget is built on.
      setMicAttached(true);
    } catch (err) {
      setError(String(err.message || err));
      setTransport("error");
    }
  };

  const stop = () => {
    loggerRef.current?.stop();
    sessionRef.current?.stop();
    sessionRef.current = null;
    setTransport("idle");
    setMicAttached(false);
    setActivity({ userSpeaking: false, agentBusy: false });
    setHolding(false);
  };

  const sendText = (text) => {
    setTranscript((t) => [...t, { role: "user", text }]);
    callbacksRef.current.onTranscript?.({ role: "user", text });
    sessionRef.current?.sendTextTurn(text);
  };

  const confirmManually = () => executeTool("confirm_pending_action", {});
  const cancelManually = () => executeTool("cancel_pending_action", {});

  /**
   * Model and language, unlike mode, CANNOT be changed on a live session --
   * both are fixed when the session is minted. So changing one while connected
   * means tearing the session down and building a new one, which loses the
   * conversation history. Doing it silently would be worse than the reconnect:
   * the user would keep talking to a session configured the way it was before
   * they changed it.
   */
  const reconfigure = (apply, overrides) => {
    const wasLive = !!sessionRef.current;
    if (wasLive) stop();
    apply();
    if (wasLive) start(overrides);
  };

  const setModel = (next) => reconfigure(() => setModelState(next), { model: next });
  const setLanguage = (next) => reconfigure(() => setLanguageState(next), { language: next });

  // Switching modes never reconnects -- same session, same history, same
  // instructions. It just changes who decides when a turn ends (VAD vs. a
  // held button) and what the mic's resting state is.
  const setMode = (newMode) => {
    const session = sessionRef.current;
    if (session) {
      if (newMode === "ptt") {
        session.setTurnDetection(false);
        session.setMicEnabled(false); // resting state: muted, hold to talk
      } else {
        session.setTurnDetection(true);
        session.setMicEnabled(true); // resting state: live (continuous or ptnt)
      }
    }
    setHolding(false);
    setModeState(newMode);
    callbacksRef.current.onModeChange?.(newMode);
  };

  const holdStart = () => {
    const session = sessionRef.current;
    if (!session || mode === "continuous") return;
    setHolding(true);
    if (mode === "ptt") {
      session.cancelResponse(); // barge-in: stop the model if it's still talking
      session.clearInputBuffer();
      session.setMicEnabled(true);
    } else if (mode === "ptnt") {
      session.setMicEnabled(false);
    }
  };

  const holdEnd = () => {
    const session = sessionRef.current;
    if (!session || mode === "continuous" || !holding) return;
    setHolding(false);
    if (mode === "ptt") {
      session.setMicEnabled(false);
      session.commitAndRespond();
    } else if (mode === "ptnt") {
      session.setMicEnabled(true);
    }
  };

  // Ctrl+Space as a keyboard hold, mirroring the hold button. Subscribes
  // once and calls through refs so it never sees a stale `mode`/`holding`
  // closure -- holdStart/holdEnd already no-op when disconnected or in
  // continuous mode, so this listener can just stay attached globally.
  const holdStartRef = useRef(holdStart);
  const holdEndRef = useRef(holdEnd);
  holdStartRef.current = holdStart;
  holdEndRef.current = holdEnd;

  useEffect(() => {
    function isEditableTarget(el) {
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    }
    function onKeyDown(e) {
      if (e.code !== "Space" || !e.ctrlKey || e.repeat) return;
      if (isEditableTarget(document.activeElement)) return;
      e.preventDefault();
      holdStartRef.current();
    }
    function onKeyUp(e) {
      // Releasing either key ends the hold, not just Space -- matches how
      // a physical push-to-talk button behaves if you let go early.
      if (e.code !== "Space" && !e.code.startsWith("Control")) return;
      holdEndRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  return (
    <InterpreterContext.Provider
      value={{
        transport,
        micAttached,
        ...activity,
        transcript,
        pendingAction,
        error,
        manifest,
        mode,
        holding,
        options,
        model,
        language,
        setModel,
        setLanguage,
        start,
        stop,
        sendText,
        confirmManually,
        cancelManually,
        setMode,
        warm,
        warmup,
        holdStart,
        holdEnd,
      }}
    >
      {/* One overlay for all widget chrome, mounted here so consumers never
          place it and so the rim and the panel end up in the same shadow
          root. Two of them could not agree an order in the top layer without
          fighting each other for it -- see LAYERS in ScreenOverlay.jsx. */}
      <OverlayProvider>{children}</OverlayProvider>
    </InterpreterContext.Provider>
  );
}

/**
 * The public headless API. Everything the built-in UI components use is
 * available here too -- there's nothing they can do that a custom UI
 * built on this hook can't.
 */
export function useInterpreter() {
  const ctx = useContext(InterpreterContext);
  if (!ctx) throw new Error("useInterpreter must be used inside a VoiceProvider");
  return ctx;
}
