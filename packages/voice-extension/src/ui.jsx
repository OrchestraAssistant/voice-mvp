/**
 * The visible panel, in the page, driven by the offscreen session over messages.
 *
 * Purpose-built rather than the widget's full Interpreter: the session lives in
 * another process, so the panel can only hold state it is TOLD (streamed status
 * + transcripts) and can only act by SENDING commands. A chat log + a text box +
 * a status dot is the honest shape of that. On (re)mount after a navigation it
 * asks the offscreen doc for a snapshot, so the ongoing conversation reappears.
 */
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { KIND } from "./messaging.js";

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

function Panel() {
  const [status, setStatus] = useState("idle");
  const [activity, setActivity] = useState({ userSpeaking: false, agentBusy: false });
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    const onMsg = (msg) => {
      if (msg?.kind === KIND.SNAPSHOT) {
        setStatus(msg.status ?? "idle");
        setMessages(msg.transcripts ?? []);
      } else if (msg?.kind === KIND.STATE) {
        if (msg.status !== undefined) setStatus(msg.status);
        if (msg.userSpeaking !== undefined || msg.agentBusy !== undefined) {
          setActivity((a) => ({
            userSpeaking: msg.userSpeaking ?? a.userSpeaking,
            agentBusy: msg.agentBusy ?? a.agentBusy,
          }));
        }
      } else if (msg?.kind === KIND.TRANSCRIPT) {
        setMessages((m) => [...m, { role: msg.role, text: msg.text }]);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    send({ kind: KIND.UI_READY }); // ask the offscreen session for the current state
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo(0, 1e9);
  }, [messages]);

  const submit = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    send({ kind: KIND.CMD, cmd: "sendText", text });
  };

  const live = status === "ready" || status === "connected";
  const dot = activity.agentBusy ? "#f59e0b" : activity.userSpeaking ? "#22c55e" : live ? "#3b82f6" : "#9ca3af";
  const label = activity.agentBusy ? "thinking…" : activity.userSpeaking ? "listening…" : status;

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={{ ...S.dot, background: dot }} />
        <span style={S.title}>Voice</span>
        <span style={S.status}>{label}</span>
      </div>
      <div ref={listRef} style={S.list}>
        {messages.length === 0 ? (
          <div style={S.empty}>Talk, or type below. This session keeps running across page reloads.</div>
        ) : (
          messages.map((m, i) => (
            <div key={i} style={m.role === "user" ? S.user : S.assistant}>{m.text}</div>
          ))
        )}
      </div>
      <form onSubmit={submit} style={S.form}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a command…"
          style={S.input}
        />
        <button type="submit" style={S.send}>Send</button>
      </form>
    </div>
  );
}

const S = {
  panel: { position: "fixed", bottom: "16px", right: "16px", width: "320px", maxHeight: "60vh", zIndex: 2147483647,
    display: "flex", flexDirection: "column", background: "#fff", color: "#111", border: "1px solid #e5e7eb",
    borderRadius: "14px", boxShadow: "0 10px 30px rgba(0,0,0,.18)", font: "14px system-ui, sans-serif", overflow: "hidden" },
  header: { display: "flex", alignItems: "center", gap: "8px", padding: "10px 12px", borderBottom: "1px solid #f0f0f0" },
  dot: { width: "9px", height: "9px", borderRadius: "50%", display: "inline-block" },
  title: { fontWeight: 600 },
  status: { marginLeft: "auto", color: "#888", fontSize: "12px" },
  list: { flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px" },
  empty: { color: "#999", fontSize: "13px", lineHeight: 1.5 },
  user: { alignSelf: "flex-end", background: "#111", color: "#fff", padding: "7px 11px", borderRadius: "13px 13px 3px 13px", maxWidth: "85%" },
  assistant: { alignSelf: "flex-start", background: "#f3f4f6", color: "#111", padding: "7px 11px", borderRadius: "13px 13px 13px 3px", maxWidth: "85%" },
  form: { display: "flex", gap: "6px", padding: "10px 12px", borderTop: "1px solid #f0f0f0" },
  input: { flex: 1, font: "inherit", padding: "8px 10px", border: "1px solid #ddd", borderRadius: "9px", outline: "none" },
  send: { font: "inherit", padding: "8px 12px", border: "none", background: "#111", color: "#fff", borderRadius: "9px", cursor: "pointer" },
};

/** Mount the panel into an isolated shadow root at the corner of the page. */
export function mountPanel() {
  if (!document.body || document.getElementById("yourco-voice-panel")) return;
  const host = document.createElement("div");
  host.id = "yourco-voice-panel";
  const shadow = host.attachShadow({ mode: "open" });
  const root = document.createElement("div");
  shadow.appendChild(root);
  document.body.appendChild(host);
  createRoot(root).render(<Panel />);
}
