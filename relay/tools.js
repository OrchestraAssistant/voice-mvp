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

  // Queries stay a plain schema, deliberately unlike actions below. Wrapping
  // them would make the commonest call -- "list everything" -- into
  // {"items":[{}]}, an array holding one empty object, which reads like a bug.
  // The model ignored the batch form for queries anyway; what it needs here is
  // not a batch but the advice to stop filtering one thing at a time.
  for (const q of manifest.queries) {
    tools.push({
      type: "function",
      name: `query_${q.name}`,
      description:
        q.description.replace(/\s*$/, "").replace(/\.?$/, ".") +
        " When you need several things, call this ONCE with no filter and pick from the result" +
        " -- never one query per thing.",
      parameters: paramsToJsonSchema(q.params),
    });
  }

  for (const a of manifest.actions) {
    // Every action takes a batch as well as a single item. Measured: "create
    // one task per month" produced four tool calls and then stopped, and it
    // took eight more prompts to get the other eight; "delete the seven
    // weekdays" became seven separate stage-and-confirm rounds and forty
    // seconds of the user saying "yep". One call with a list is fewer
    // round trips, fewer tokens, and -- for destructive actions -- one
    // question instead of seven.
    // ONE shape, always a list -- a single change is a list of one.
    //
    // The first attempt offered `items` ALONGSIDE the plain fields, which
    // meant the schema had to say "either these or that", and that is exactly
    // what it cannot say: anyOf/oneOf/allOf/not are rejected at the root of a
    // tool's parameters (they are fine anywhere nested). So the root `required`
    // had to be dropped and `action_createTask({})` became schema-valid
    // nonsense.
    //
    // Making the list the only form removes the either/or, and with it the
    // need to compose anything. `required: ["items"]` comes back at the root,
    // `required` still applies inside each entry, and minItems stops an empty
    // batch -- stricter than before batching existed, and a third smaller than
    // carrying both forms.
    tools.push({
      type: "function",
      name: `action_${a.name}`,
      description:
        a.description.replace(/\s*$/, "").replace(/\.?$/, ".") +
        " Takes a LIST: one entry per thing to change, and a single change is a list of one." +
        " Never call this repeatedly for a set -- put them all in one call." +
        (a.requiresConfirmation
          ? " (destructive: requires user confirmation before executing. A list is confirmed once, for the whole set.)"
          : ""),
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            description: "One entry per thing to change. For a single change, pass a list of one.",
            items: paramsToJsonSchema(a.params, a.bodyFields),
          },
        },
        required: ["items"],
      },
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
      name: "answer_aloud",
      description:
        "Call this when your NEXT reply carries information the user asked for and cannot " +
        "already see on screen -- an answer to a question, a count, a value they requested. " +
        "Call it in the SAME turn as the tool whose result you are about to report. Do NOT " +
        "call it to confirm an action the user just watched happen; those replies are shown " +
        "as text and speaking them tells the user nothing new.",
      parameters: {
        type: "object",
        properties: {
          because: {
            type: "string",
            description:
              "One short phrase saying why this needs to be heard rather than read, " +
              "e.g. \"the user asked how many tasks there are\".",
          },
        },
        required: ["because"],
        additionalProperties: false,
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
2. Destructive tools (marked "(destructive: ...)"; currently: ${confirmActions.join(", ") || "none"}) take two steps, in this order. CALL THE TOOL FIRST: it does not execute anything, it stages the change and tells you to confirm. THEN ask the user, in plain language, naming what will change. Do not ask before calling it -- if you ask first you will ask again after staging, and the user has to say yes twice. If they agree, call confirm_pending_action (no arguments); that is what executes it. If they decline, call cancel_pending_action. Never call the destructive tool a second time to retry.
3. ACT, don't narrate. If a command maps to a tool, call it. Never describe what you could do, are about to do, or would need in order to do it -- just do it. Explaining instead of acting is the single worst thing you can do here.
4. Answer in ONE short sentence. Two or three words is usually right: "Done." / "Opened settings." / "Three tasks match." The user is looking at the screen and can see what changed, so do not describe the result in detail.
5. Never end with an offer of further help. No "anything else?", no "let me know if...", no restating the request back to the user. Say what happened and stop.
6. If something fails or no tool fits, say so in one sentence and stop. Do not propose alternatives unless asked.
7. Every action_* tool takes a LIST of changes, so one call does the whole job. "Create one per month" is ONE call with twelve entries; "delete all the weekdays" is ONE call with seven. A single change is a list of one entry. Never stop part-way through a list, and never call the same action twice for a set. For lookups, call the query ONCE with no filter and pick from the result -- never one query per thing.
8. Your replies are shown to the user as TEXT by default. If your next reply carries information they asked for and cannot see on screen -- an answer, a count, a value -- call answer_aloud in the same turn as the tool you are reporting on, and it will be spoken instead. Confirmations of things they just watched happen stay as text; do not call answer_aloud for those.${
    language
      ? `\n7. Speak and write in ${language.name}, always. Do not switch languages part-way through, and do not follow the language of the audio if it seems to differ -- the user has chosen ${language.name}.`
      : ""
  }`;
}
