import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import { buildTools, buildInstructions } from "./tools.js";

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
          model: REALTIME_MODEL,
          instructions: buildInstructions(manifest),
          tools: buildTools(manifest),
          tool_choice: "auto",
          audio: {
            output: { voice: "marin" },
            input: { transcription: { model: "gpt-live-transcribe" } },
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
