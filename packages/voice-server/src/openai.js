/**
 * The OpenAI Realtime provider's SERVER HALF, as one mountable handler.
 *
 * This is the relay, hosted inside your own app instead of as a separate service
 * (see PROVIDERS.md). It holds OPENAI_API_KEY and does three things the browser
 * must not: serve the model/language options, mint an ephemeral session token
 * from the manifest the page sends, and accept optional session logs. Mount it
 * once at `/voice` and point the widget's `relayUrl` at that origin.
 *
 *   // Next.js App Router -- app/voice/[...path]/route.ts
 *   import { openaiVoiceHandler } from "@yourco/voice-server/openai";
 *   const handler = openaiVoiceHandler();            // reads OPENAI_API_KEY from env
 *   export const GET = handler;
 *   export const POST = handler;
 *
 *   // Express
 *   import { openaiVoiceHandler, toExpressHandler } from "@yourco/voice-server/openai";
 *   app.use("/voice", express.json(), toExpressHandler(openaiVoiceHandler()));
 *
 * Auth, rate limiting and CORS are the host's: mounted in your app, the route
 * already sits behind your session, so only your users spend your budget. The
 * standalone relay (the repo's relay/index.js) adds those guards for the
 * multi-tenant case.
 */
import { createVoiceSessionHandler } from "../../../relay/mintHandler.js";
import { MODELS, LANGUAGES } from "../../../relay/tools.js";
import { json, toExpressHandler } from "./http.js";

/**
 * @param {object} [opts]
 * @param {string} [opts.apiKey]        OpenAI key; defaults to process.env.OPENAI_API_KEY
 * @param {string} [opts.defaultModel]  default Realtime model (default "gpt-realtime")
 * @param {Array}  [opts.models]        override the model list served at /options
 * @param {Array}  [opts.languages]     override the language list
 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
 * @param {(info) => void} [opts.onMinted] called after a successful mint
 * @param {(entry) => void} [opts.onLog]  called with each posted session-log entry
 * @returns {(request: Request) => Promise<Response>}
 */
export function openaiVoiceHandler(opts = {}) {
  const { models = MODELS, languages = LANGUAGES, defaultModel = "gpt-realtime", onLog } = opts;
  const mint = createVoiceSessionHandler({ ...opts, defaultModel });

  return async function handleVoice(request) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "GET" && pathname.endsWith("/options")) {
      return json(200, { models, languages, defaults: { model: defaultModel, language: "auto" } });
    }
    if (method === "POST" && pathname.endsWith("/session")) {
      return mint(request);
    }
    if (method === "POST" && pathname.endsWith("/log")) {
      try {
        onLog?.(await request.json());
      } catch {
        /* logging is best-effort; never fail the request over it */
      }
      return new Response(null, { status: 204 });
    }
    return json(404, {
      error: `No voice route for ${method} ${pathname}. Mount this at /voice; it serves GET /options, POST /session, POST /log.`,
    });
  };
}

// The mint-only handler, for a host that wants just /session and to serve the
// options list itself. openaiVoiceHandler wraps this with the full surface.
export { createVoiceSessionHandler } from "../../../relay/mintHandler.js";
export { toExpressHandler };
