import { chromium } from "playwright";
process.env.LD_LIBRARY_PATH = "/workspace/.micromamba/envs/browser/lib:" + (process.env.LD_LIBRARY_PATH ?? "");
process.env.FONTCONFIG_PATH = "/workspace/.micromamba/envs/browser/etc/fonts";

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
await page.goto("http://localhost:5174/bubble.html");

// Typed turns only -- which is what the live session was, so no microphone and
// no transcription to muddy the comparison.
const out = await page.evaluate(async () => {
  const { connectRealtimeSession } = await import("/@fs/workspace/voice-mvp/packages/voice/src/realtimeClient.js");
  const log = [];
  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(1);

  // The state changes UNDERNEATH the session between turns -- exactly what
  // happened live, where the name became "Steve Branson Jr" after the model
  // had already read "Steve Branson" into its history.
  let settings = { name: "Steve Branson", email: "stevebranson@example.com", theme: "light", notifications: true };

  let usage = { input: 0, cachedInput: 0, output: 0 };
  let idle = null;

  const session = await connectRealtimeSession({
    withMic: false,
    initialMode: "continuous",
    onStatus: () => {},
    onToolCall: async (name, args) => {
      log.push({ at: at(), tool: name, args });
      if (name === "query_settings") return settings;
      if (name === "answer_aloud") return { acknowledged: true };
      if (name === "query_tasks") return [{ id: 1, title: "Ship the widget", done: false }];
      if (name === "navigate") return { status: "navigated", path: args.path };
      return { ok: true };
    },
    onTranscript: (t) => { if (t.role === "assistant" && t.text) log.push({ at: at(), reply: t.text }); },
    onEvent: (e) => {
      if (e.type === "usage" && e.usage) {
        const d = e.usage.input_token_details ?? {};
        usage.input += e.usage.input_tokens ?? 0;
        usage.cachedInput += d.cached_tokens ?? 0;
        usage.output += e.usage.output_tokens ?? 0;
        log.push({ at: at(), modalities: e.modalities });
      }
      if (e.type === "api_error") log.push({ at: at(), error: JSON.stringify(e.error).slice(0, 120) });
      // Every event resets the clock; the turn is over when nothing has
      // happened for a beat. Waiting on response.done alone would cut off a
      // second response triggered by a tool result.
      idle = Date.now();
    },
  });

  const say = async (text, quietMs = 2500, capMs = 25000) => {
    log.push({ at: at(), user: text });
    idle = Date.now();
    session.sendTextTurn(text);
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline && Date.now() - idle < quietMs) {
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  await say("what does the settings page entail?");
  settings = { name: "Steve Branson Jr", email: "stevebransonjr@example.com", theme: "light", notifications: true };
  log.push({ at: at(), note: "settings edited underneath: Steve Branson -> Steve Branson Jr" });
  await say("what is my currently set email?");
  await say("and the name?");
  await say("You sure?");
  await say("Double check");

  session.stop();
  return { log, usage };
});

for (const e of out.log) {
  const t = `${String(e.at).padStart(6)}s`;
  if (e.user) console.log(`\n${t}  USER   "${e.user}"`);
  else if (e.note) console.log(`${t}         [${e.note}]`);
  else if (e.tool) console.log(`${t}    TOOL  ${e.tool}(${JSON.stringify(e.args)})`.slice(0, 130));
  else if (e.reply) console.log(`${t}    REPLY "${e.reply}"`);
  else if (e.error) console.log(`${t}    ERROR ${e.error}`);
  else if (e.modalities) console.log(`${t}          [response out: ${e.modalities}]`);
}
console.log("\ntokens", JSON.stringify(out.usage));
await browser.close();
