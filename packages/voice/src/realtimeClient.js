// Browser-side WebRTC connection to the OpenAI Realtime API. The server
// mints the ephemeral token (and owns the manifest-derived tool list +
// confirmation policy); this module only ever holds a short-lived key
// scoped to one session.

// mode: "continuous" (server VAD decides turn boundaries, mic always live),
// "ptt" (mic starts muted; caller unmutes while held, then commits + asks
// for a response on release), or "ptnt" ("push to not talk" -- the mirror
// image: mic starts live and VAD keeps driving turns, caller mutes only
// while held, e.g. to say something off to the side without being heard).
export async function connectRealtimeSession({ onToolCall, onStatus, onTranscript, initialMode = "continuous", relayUrl = "" }) {
  // Transport states only. Whether the user is actually being listened to is
  // a separate question -- see isListening() -- because a connection can be
  // up with no microphone attached to it.
  onStatus?.("connecting");
  const sessionRes = await fetch(`${relayUrl}/voice/session`, { method: "POST" });
  const sessionData = await sessionRes.json();
  if (!sessionRes.ok) {
    throw new Error(sessionData.error?.message || sessionData.error || "Failed to create realtime session");
  }
  const ephemeralKey = sessionData.value;

  const pc = new RTCPeerConnection();

  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  pc.ontrack = (event) => {
    audioEl.srcObject = event.streams[0];
  };

  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const micTrack = micStream.getAudioTracks()[0];
  micTrack.enabled = initialMode !== "ptt"; // ptt starts muted (hold to talk); others start live
  micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));

  const dc = pc.createDataChannel("oai-events");

  dc.addEventListener("open", () => {
    onStatus?.("ready");
    if (initialMode === "ptt") {
      // Session is minted with server_vad by default; ptt needs manual
      // turn detection so button-release (not silence) decides the turn.
      dc.send(
        JSON.stringify({ type: "session.update", session: { audio: { input: { turn_detection: null } } } }),
      );
    }
  });
  dc.addEventListener("close", () => onStatus?.("closed"));

  dc.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      onTranscript?.({ role: "user", text: msg.transcript });
    }

    if (msg.type === "response.done") {
      const output = msg.response?.output || [];

      for (const item of output) {
        if (item.type === "message") {
          const text = (item.content || [])
            .map((c) => c.transcript || c.text)
            .filter(Boolean)
            .join(" ");
          if (text) onTranscript?.({ role: "assistant", text });
        }
      }

      const calls = output.filter((o) => o.type === "function_call");
      if (calls.length === 0) return;

      for (const call of calls) {
        let args = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          // leave args empty if the model sent malformed JSON
        }
        let result;
        try {
          result = await onToolCall(call.name, args);
        } catch (err) {
          result = { error: String(err.message || err) };
        }
        dc.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: call.call_id,
              output: JSON.stringify(result ?? {}),
            },
          }),
        );
      }
      dc.send(JSON.stringify({ type: "response.create" }));
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      "Content-Type": "application/sdp",
    },
    body: offer.sdp,
  });
  if (!sdpRes.ok) {
    throw new Error(`Realtime SDP exchange failed: ${sdpRes.status}`);
  }
  const answerSdp = await sdpRes.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return {
    stop() {
      dc.close();
      pc.getSenders().forEach((s) => s.track?.stop());
      pc.close();
      onStatus?.("closed");
    },
    sendTextTurn(text) {
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        }),
      );
      dc.send(JSON.stringify({ type: "response.create" }));
    },

    // --- PTT / PTNT primitives, all on this same connection + history ---

    setMicEnabled(enabled) {
      micTrack.enabled = enabled;
    },
    // auto=true restores server VAD (continuous); auto=false switches to
    // manual turn detection (push-to-talk decides turn end itself).
    setTurnDetection(auto) {
      dc.send(
        JSON.stringify({
          type: "session.update",
          session: { audio: { input: { turn_detection: auto ? { type: "server_vad" } : null } } },
        }),
      );
    },
    // Reset any buffered input audio -- call on PTT press so a stale/empty
    // buffer from before the button was held doesn't bleed into the turn.
    clearInputBuffer() {
      dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    },
    // Call on PTT release: finalizes the held-down turn and asks the model
    // to respond now, without waiting on VAD (which is disabled anyway).
    commitAndRespond() {
      dc.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      dc.send(JSON.stringify({ type: "response.create" }));
    },
    // Barge-in: stop whatever the model is currently saying/generating.
    cancelResponse() {
      dc.send(JSON.stringify({ type: "response.cancel" }));
    },
  };
}
