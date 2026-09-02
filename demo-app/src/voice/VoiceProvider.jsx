import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { connectRealtimeSession } from "./realtimeClient.js";
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
 *   onStatusChange(status)          -- fires on connection status change.
 */
export function VoiceProvider({ children, onToolCall, onTranscript, onPendingAction, onModeChange, onStatusChange }) {
  const [manifest, setManifest] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | disconnected | error
  const [transcript, setTranscript] = useState([]);
  const [pendingAction, setPendingActionState] = useState(null); // { name, description, args }
  const [error, setError] = useState(null);
  const [mode, setModeState] = useState("continuous"); // continuous | ptt | ptnt
  const [holding, setHolding] = useState(false);

  const sessionRef = useRef(null);
  const pendingRef = useRef(null); // mirrors pendingAction for use inside the tool-call closure
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Callback props are read through refs so their identity churning on
  // every parent render never forces us to re-create executeTool/effects.
  const callbacksRef = useRef({});
  callbacksRef.current = { onToolCall, onTranscript, onPendingAction, onModeChange, onStatusChange };

  const setPendingAction = (value) => {
    pendingRef.current = value ? { action: value.action, args: value.args } : null;
    const publicValue = value ? { name: value.action.name, description: value.action.description, args: value.args } : null;
    setPendingActionState(publicValue);
    callbacksRef.current.onPendingAction?.(publicValue);
  };

  useEffect(() => {
    fetch("/voice/manifest")
      .then((r) => r.json())
      .then(setManifest)
      .catch((err) => setError(String(err)));
  }, []);

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
    queryClient.invalidateQueries();
    return result;
  };

  const executeTool = useCallback(
    async (name, args) => {
      if (!manifest) return { error: "Manifest not loaded yet" };

      if (name === "navigate") {
        navigate(args.path);
        return { status: "navigated", path: args.path };
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
        return await runAction(pending.action, pending.args);
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

        if (action.requiresConfirmation) {
          setPendingAction({ action, args });
          return {
            status: "needs_confirmation",
            message: `Ask the user to confirm: ${action.description} with ${JSON.stringify(args)}. Call confirm_pending_action once they agree.`,
          };
        }
        return await runAction(action, args);
      }

      return { error: `Unrecognized tool: ${name}` };
    },
    [manifest, navigate, queryClient],
  );

  const start = async () => {
    setError(null);
    setStatus("connecting");
    try {
      const session = await connectRealtimeSession({
        onToolCall: async (name, args) => {
          const result = await executeTool(name, args);
          callbacksRef.current.onToolCall?.(name, args, result);
          return result;
        },
        onStatus: (s) => {
          setStatus(s);
          callbacksRef.current.onStatusChange?.(s);
        },
        onTranscript: (turn) => {
          setTranscript((t) => [...t, turn]);
          callbacksRef.current.onTranscript?.(turn);
        },
        initialMode: mode,
      });
      sessionRef.current = session;
    } catch (err) {
      setError(String(err.message || err));
      setStatus("error");
    }
  };

  const stop = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setStatus("idle");
    setHolding(false);
  };

  const sendText = (text) => {
    setTranscript((t) => [...t, { role: "user", text }]);
    callbacksRef.current.onTranscript?.({ role: "user", text });
    sessionRef.current?.sendTextTurn(text);
  };

  const confirmManually = () => executeTool("confirm_pending_action", {});
  const cancelManually = () => executeTool("cancel_pending_action", {});

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
        status,
        transcript,
        pendingAction,
        error,
        manifest,
        mode,
        holding,
        start,
        stop,
        sendText,
        confirmManually,
        cancelManually,
        setMode,
        holdStart,
        holdEnd,
      }}
    >
      {children}
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
