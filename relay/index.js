import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import { buildTools, buildInstructions, resolveModel, resolveLanguage, MODELS, LANGUAGES } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where the manifest lives. In the real product this is a per-tenant record
// in the control plane, written by `voice-cli push`; for local dev it's just
// the file the CLI generated in the app being analyzed.
const MANIFEST_PATH =
  process.env.MANIFEST_PATH || path.resolve(__dirname, "../demo-app/.voice/manifest.json");
const PORT = process.env.PORT || 3002;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";

const app = express();
app.use(cors());
app.use(express.json());

// What the widget is allowed to offer in its settings. Served rather than
// hard-coded in the client so the list is the relay's to control: a browser
// should not be choosing which model the account pays for.
app.get("/voice/options", (req, res) => {
  res.json({ models: MODELS, languages: LANGUAGES, defaults: { model: REALTIME_MODEL, language: "auto" } });
});

app.get("/voice/manifest", (req, res) => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return res.status(404).json({ error: "No manifest found. Run `npm run generate -w @yourco/voice-cli` first." });
  }
  res.json(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")));
});

// Mints an ephemeral Realtime session token, server-side, so OPENAI_API_KEY
// never reaches the browser. The manifest-derived tool list and confirmation
// policy are attached here too, so a tampered client can't redefine its own
// tools or quietly drop a requiresConfirmation flag.
app.post("/voice/session", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not set on the relay." });
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    return res.status(400).json({ error: "No manifest found. Run the generate step first." });
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));

  // Both are session-creation parameters -- neither can be changed on a live
  // session -- so they arrive here, are validated here, and a rejected value
  // is an error rather than a quiet substitution.
  const wantedModel = resolveModel(req.body?.model, REALTIME_MODEL);
  if (wantedModel.error) return res.status(400).json({ error: wantedModel.error });
  const wantedLanguage = resolveLanguage(req.body?.language);
  if (wantedLanguage.error) return res.status(400).json({ error: wantedLanguage.error });

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
          instructions: buildInstructions(manifest, wantedLanguage.language),
          tools: buildTools(manifest),
          tool_choice: "auto",
          audio: {
            output: { voice: "marin" },
            input: {
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
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Relay listening on http://localhost:${PORT}`);
});
