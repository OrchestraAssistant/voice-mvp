// Converts the generated manifest into OpenAI Realtime function-calling
// tool definitions, plus a fixed set of generic DOM/navigation primitives
// that act as the runtime fallback for anything the manifest doesn't cover.

function jsonType(manifestType) {
  if (manifestType === "boolean") return "boolean";
  if (manifestType === "number") return "number";
  return "string"; // string, enum, and anything unrecognized default to string
}

function paramsToJsonSchema(params = [], bodyFields = []) {
  const properties = {};
  const required = [];
  for (const p of [...params, ...bodyFields]) {
    properties[p.name] = {
      type: jsonType(p.type),
      description: p.source ? `(${p.source})` : undefined,
      ...(p.enumValues ? { enum: p.enumValues } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, required };
}

export function buildTools(manifest) {
  const tools = [];

  for (const q of manifest.queries) {
    tools.push({
      type: "function",
      name: `query_${q.name}`,
      description: q.description,
      parameters: paramsToJsonSchema(q.params),
    });
  }

  for (const a of manifest.actions) {
    tools.push({
      type: "function",
      name: `action_${a.name}`,
      description:
        a.description + (a.requiresConfirmation ? " (destructive: requires user confirmation before executing)" : ""),
      parameters: paramsToJsonSchema(a.params, a.bodyFields),
    });
  }

  // Generic runtime fallback primitives -- used when the manifest doesn't
  // cover what's needed (an element with no corresponding manifest action,
  // or a page state the static analysis couldn't see).
  tools.push(
    {
      type: "function",
      name: "navigate",
      description: "Navigate the app to a known route path, e.g. /settings or /tasks/3",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      type: "function",
      name: "dom_snapshot",
      description:
        "List the currently visible, interactive elements on screen (buttons, links, inputs, selects) with their labels and ids. Use this when you need to click or type into something that isn't covered by a query/action tool.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "dom_click",
      description: "Click a specific element by the id returned from dom_snapshot.",
      parameters: { type: "object", properties: { elementId: { type: "string" } }, required: ["elementId"] },
    },
    {
      type: "function",
      name: "dom_type",
      description: "Type text into a specific input/textarea element by the id returned from dom_snapshot.",
      parameters: {
        type: "object",
        properties: { elementId: { type: "string" }, text: { type: "string" } },
        required: ["elementId", "text"],
      },
    },
    {
      type: "function",
      name: "confirm_pending_action",
      description:
        "Confirm and actually execute the destructive action that is currently awaiting confirmation. Only call this after the user has clearly said yes.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "cancel_pending_action",
      description: "Cancel the destructive action that is currently awaiting confirmation.",
      parameters: { type: "object", properties: {} },
    },
  );

  return tools;
}

/**
 * What a client is allowed to ask for. The relay owns this list rather than
 * the widget because both fields are cost and safety decisions: `model` picks
 * how much a minute of conversation costs, and a browser is not the place to
 * decide that. A tampered client asking for something not on this list gets a
 * 400 rather than a silent downgrade -- silent fallbacks are how you end up
 * running a model you did not choose.
 */
export const MODELS = [
  { id: "gpt-realtime", label: "Realtime", note: "Most capable" },
  { id: "gpt-realtime-mini", label: "Realtime mini", note: "~4x cheaper" },
  { id: "gpt-realtime-2.1", label: "Realtime 2.1", note: "Pinned version" },
  { id: "gpt-realtime-2.1-mini", label: "Realtime 2.1 mini", note: "Pinned, cheapest" },
];

/**
 * Pinning a language fixes two separate things. It tells the transcriber what
 * to expect, and it tells the model what to answer in -- and the second is not
 * optional. Left to itself on one measured run the flagship answered four of
 * six turns in Vietnamese, having been spoken to in English throughout.
 */
export const LANGUAGES = [
  // `flag` is a display detail the widget shows instead of an icon. Auto-detect
  // has none on purpose: it is not a place, and any flag would be a lie about
  // which one. The rest are a convenient shorthand rather than a claim -- a
  // language is not a country, and es/pt in particular are spoken by far more
  // people outside the flag than inside it.
  { code: "auto", label: "Auto-detect", name: null, flag: null },
  { code: "en", label: "English", name: "English", flag: "\u{1F1EC}\u{1F1E7}" },
  { code: "es", label: "Espanol", name: "Spanish", flag: "\u{1F1EA}\u{1F1F8}" },
  { code: "fr", label: "Francais", name: "French", flag: "\u{1F1EB}\u{1F1F7}" },
  { code: "de", label: "Deutsch", name: "German", flag: "\u{1F1E9}\u{1F1EA}" },
  { code: "pt", label: "Portugues", name: "Portuguese", flag: "\u{1F1F5}\u{1F1F9}" },
  { code: "it", label: "Italiano", name: "Italian", flag: "\u{1F1EE}\u{1F1F9}" },
];

/** Returns { model } or { error }. */
export function resolveModel(requested, fallback) {
  if (!requested) return { model: fallback };
  if (!MODELS.some((m) => m.id === requested)) return { error: `Unsupported model: ${requested}` };
  return { model: requested };
}

/** Returns { language } (null means auto-detect) or { error }. */
export function resolveLanguage(requested) {
  if (!requested || requested === "auto") return { language: null };
  const match = LANGUAGES.find((l) => l.code === requested);
  if (!match) return { error: `Unsupported language: ${requested}` };
  return { language: match };
}

export function buildInstructions(manifest, language = null) {

  const routeList = manifest.routes.map((r) => `- ${r.path} (${r.component})`).join("\n");
  const confirmActions = manifest.actions.filter((a) => a.requiresConfirmation).map((a) => a.name);

  return `You are a voice assistant embedded in a task-management web app. You can see and control the app on the user's behalf using the tools available to you.

Known pages in this app:
${routeList}

Rules:
1. Prefer the query_* and action_* tools -- they are reliable, direct calls into the app's own data. Only fall back to dom_snapshot/dom_click/dom_type when there's no query/action tool that does what's needed.
2. For any action tool marked "(destructive: requires user confirmation before executing)" (currently: ${confirmActions.join(", ") || "none"}), calling it the first time does NOT execute it -- it only stages it and tells you what to confirm with the user. Ask the user to confirm in plain language. If they agree, call confirm_pending_action (no arguments) to actually run it. If they decline, call cancel_pending_action. Never call the same destructive action tool twice to "retry" -- use confirm_pending_action instead.
3. ACT, don't narrate. If a command maps to a tool, call it. Never describe what you could do, are about to do, or would need in order to do it -- just do it. Explaining instead of acting is the single worst thing you can do here.
4. Answer in ONE short sentence. Two or three words is usually right: "Done." / "Opened settings." / "Three tasks match." The user is looking at the screen and can see what changed, so do not describe the result in detail.
5. Never end with an offer of further help. No "anything else?", no "let me know if...", no restating the request back to the user. Say what happened and stop.
6. If something fails or no tool fits, say so in one sentence and stop. Do not propose alternatives unless asked.${
    language
      ? `\n7. Speak and write in ${language.name}, always. Do not switch languages part-way through, and do not follow the language of the audio if it seems to differ -- the user has chosen ${language.name}.`
      : ""
  }`;
}
