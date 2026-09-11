import express from "express";
import cors from "cors";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { summaryEvent, tallySession } from "./usage.js";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import { buildTools, buildInstructions, resolveModel, resolveLanguage, validateManifest, MODELS, LANGUAGES } from "./tools.js";
import { listSessions, readSession, priceEvents } from "./observer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The manifest is NOT here. It is an artifact of the app -- generated from
// the app's own source, committed beside it, bundled with it -- and it
// arrives with each mint request from the page that owns it.
//
// It used to be a file path on this server, defaulting to the demo app's.
// A relay restarted without MANIFEST_PATH silently served a task manager's
// manifest to a calendar app, and the agent politely explained that the app
// had no bookings page. Nothing errored, because a wrong-but-plausible answer
// is what a default produces. There is nothing to misconfigure now.
const PORT = process.env.PORT || 3002;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";

/**
 * Session logging, OFF unless VOICE_LOG=1.
 *
 * The relay is not in the data path -- it mints a token and steps out, and the
 * conversation goes browser to OpenAI directly over WebRTC. So it cannot
 * observe a session on its own; the widget has to post what happened. That is
 * the widget's job rather than the host app's: both ends of this are ours, and
 * a customer should not have to wire up callbacks to get their own logs.
 *
 * Two switches, both off by default, because this is a recording of what
 * people said out loud. The relay needs VOICE_LOG=1 and the widget needs
 * logToRelay. Neither alone does anything.
 */
const LOGGING = process.env.VOICE_LOG === "1";
const LOG_DIR = process.env.VOICE_LOG_DIR || path.resolve(__dirname, "logs");

const app = express();
app.use(cors());
app.use(express.json());

// What the widget is allowed to offer in its settings. Served rather than
// hard-coded in the client so the list is the relay's to control: a browser
// should not be choosing which model the account pays for.
/**
 * Append one JSON line. Files are per session, named by the handle handed out
 * at mint, so a run is one greppable file.
 */
function appendLog(logId, event) {
  if (!/^[\w.-]+$/.test(logId)) return; // it lands in a path; keep it boring
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // `at` is when the widget says it happened and `receivedAt` is when the
  // batch reached us. Both, because they answer different questions and used
  // to be the same field: events are batched for a couple of seconds, so
  // arrival time collapses a whole turn onto one instant. The spread sits
  // between them so a widget-supplied `at` wins and `receivedAt` cannot be
  // overwritten by the payload.
  const now = new Date().toISOString();
  fs.appendFileSync(
    path.join(LOG_DIR, `${logId}.jsonl`),
    JSON.stringify({ at: now, ...event, receivedAt: now }) + "\n",
  );
}

// The widget posts here. Batched, so a busy turn is one request.
/**
 * Running totals per session, so a finished session ends with its own cost.
 *
 * Kept here rather than in the widget on purpose: this is instrumentation for
 * comparing providers, and none of it should reach the package's public API.
 * The relay already sees every event, so it is the one place that can total a
 * session without the client knowing it is being measured.
 *
 * "Finished" has to be inferred. A browser tab can be closed, killed or put to
 * sleep, and only the polite case sends a final beacon -- so a session is done
 * when nothing has arrived from it for a while, which covers all of them.
 */
const SUMMARY_AFTER_MS = Number(process.env.VOICE_LOG_SUMMARY_MS || 120_000);
const openSessions = new Map(); // logId -> { events, lastSeen }

function sweepSessions(now = Date.now()) {
  for (const [logId, live] of openSessions) {
    if (now - live.lastSeen < SUMMARY_AFTER_MS) continue;
    openSessions.delete(logId);
    const tally = tallySession(live.events);
    // A session that never produced a response is a warm connection nobody
    // used. It costs nothing and a summary line saying so is just noise.
    if (tally.responses === 0) continue;
    appendLog(logId, summaryEvent(tally));
  }
}

if (LOGGING) setInterval(sweepSessions, 30_000).unref();

app.post("/voice/log", (req, res) => {
  if (!LOGGING) return res.status(404).json({ error: "Logging is off. Start the relay with VOICE_LOG=1." });
  const { logId, events } = req.body ?? {};
  if (!logId || !Array.isArray(events)) return res.status(400).json({ error: "Expected { logId, events[] }" });
  for (const e of events) appendLog(logId, e);

  if (LOGGING) {
    const live = openSessions.get(logId) ?? { events: [], lastSeen: 0 };
    live.events.push(...events);
    live.lastSeen = Date.now();
    openSessions.set(logId, live);
  }
  res.json({ written: events.length });
});

app.get("/voice/options", (req, res) => {
  res.json({ models: MODELS, languages: LANGUAGES, defaults: { model: REALTIME_MODEL, language: "auto" } });
});

/**
 * The session observer: a page and its data, for watching a run turn by turn.
 * Behind VOICE_LOG like everything that touches transcripts -- with logging off
 * there is nothing recorded to look at, and nothing to serve.
 */
if (LOGGING) {
  app.get("/voice/observer", (req, res) => res.sendFile(path.join(__dirname, "public", "observer.html")));
  app.get("/voice/observer/sessions", (req, res) => res.json(listSessions(LOG_DIR)));
  app.get("/voice/observer/session/:id", (req, res) => {
    const events = readSession(LOG_DIR, req.params.id);
    if (!events) return res.status(404).json({ error: "no such session" });
    // Events with a per-message cost attached, plus the session total.
    res.json(priceEvents(events));
  });
}

// Mints an ephemeral Realtime session token, server-side, so OPENAI_API_KEY
// never reaches the browser. That key is the only reason this endpoint exists.
//
// The tool list is built here because instructions and tools are attached at
// session CREATION and cannot be changed afterwards -- prompt caching is
// session-scoped. It is built from the manifest the caller sends, which is the
// same object the widget uses to execute those tools. One object, one commit,
// no way for the two to disagree.
app.post("/voice/session", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not set on the relay." });
  }

  const checked = validateManifest(req.body?.manifest);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const manifest = checked.manifest;

  // Both are session-creation parameters -- neither can be changed on a live
  // session -- so they arrive here, are validated here, and a rejected value
  // is an error rather than a quiet substitution.
  const wantedModel = resolveModel(req.body?.model, REALTIME_MODEL);
  if (wantedModel.error) return res.status(400).json({ error: wantedModel.error });
  const wantedLanguage = resolveLanguage(req.body?.language);
  if (wantedLanguage.error) return res.status(400).json({ error: wantedLanguage.error });

  // Which client is calling. Only the extension can drive the browser (open a
  // URL in the tab), so only it is handed the browser tools; anything else is
  // the in-page widget. Unknown values collapse to the widget rather than
  // erroring -- a surface it cannot honour is not a reason to refuse a session.
  const surface = req.body?.surface === "extension" ? "extension" : null;

  try {
    const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: wantedModel.model,
          instructions: buildInstructions(manifest, wantedLanguage.language, { surface }),
          tools: buildTools(manifest, { surface }),
          tool_choice: "auto",
          audio: {
            output: { voice: "marin" },
            input: {
              // The detector stays theirs -- it still hears where speech starts
              // and stops, still commits the buffer, and interrupt_response is
              // untouched so barge-in still cancels an in-flight reply. Only
              // the GENERATING moves to us. Left at its default,
              // create_response makes the server reply in the same instant it
              // decides the turn ended, which means the modality of the first
              // response of every turn is not ours to pick, and the completed
              // transcript lands 300ms after the model is already talking.
              //
              // The obligation this takes on: nothing is produced until the
              // client asks. A turn we fail to answer is silence, with no
              // error and no timeout. See requestResponse() in realtimeClient.
              turn_detection: { type: "server_vad", create_response: false },
              // The `language` key has to be ABSENT for auto-detect, not null:
              // sending null is a 400 ("expected one of 'af', 'ar', ..."), so
              // the obvious spelling breaks the default path for every user who
              // never opens settings. The API also normalises what you send
              // into `languages: ["es"]` on the way back, so do not look for
              // `language` in the echoed session to check it took.
              transcription: {
                model: "gpt-live-transcribe",
                ...(wantedLanguage.language ? { language: wantedLanguage.language.code } : {}),
              },
            },
          },
        },
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error("OpenAI client_secrets error:", data);
      return res.status(upstream.status).json(data);
    }
    // A handle the client can attach its log to, so a transcript can be tied
    // back to the session config that produced it -- which model answered,
    // which language was pinned.
    const logId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    if (LOGGING) {
      const header = {
        type: "session",
        model: wantedModel.model,
        language: wantedLanguage.language?.code ?? null,
        // Which app this session was for. The relay holds no manifest now, so
        // without this a log could not say -- and the failure it replaces was
        // precisely a session built on the wrong app's manifest, which nothing
        // recorded and nothing detected.
        manifest: {
          routes: manifest.routes.length,
          queries: manifest.queries.length,
          actions: manifest.actions.length,
          empty: checked.empty,
        },
      };
      appendLog(logId, header);
      // Seeds the tally with the model, which is known here and nowhere else:
      // the client asked for a name or for nothing, and this is what it
      // resolved to.
      openSessions.set(logId, { events: [header], lastSeen: Date.now() });
    }
    res.json({ ...data, logId, logging: LOGGING });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Relay listening on http://localhost:${PORT}`);
});
