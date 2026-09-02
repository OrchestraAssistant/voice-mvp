import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import { api } from "./api.js";
import { buildTools, buildInstructions } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, "../.voice/manifest.json");
const PORT = process.env.PORT || 3001;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", api);

app.get("/voice/manifest", (req, res) => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return res.status(404).json({ error: "No manifest found. Run `npm run generate` in voice-cli first." });
  }
  res.json(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")));
});

// Mints an ephemeral Realtime session token, server-side, so the main
// OPENAI_API_KEY never reaches the browser. The manifest-derived tool
// list and confirmation policy are attached here too, so the browser
// can't redefine its own tool list to bypass it.
app.post("/voice/session", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not set on the server." });
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    return res.status(400).json({ error: "No manifest found. Run `npm run generate` in voice-cli first." });
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  const tools = buildTools(manifest);
  const instructions = buildInstructions(manifest);

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
          instructions,
          tools,
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
  console.log(`Server listening on http://localhost:${PORT}`);
});
