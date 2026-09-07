// Converts the generated manifest into OpenAI Realtime function-calling
// tool definitions, plus a fixed set of generic DOM/navigation primitives
// that act as the runtime fallback for anything the manifest doesn't cover.

import { rootCatalog } from "./catalog.js";

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

/**
 * Is this a manifest at all?
 *
 * The client sends it now, so this is the only thing standing between a
 * typo and a session built on nothing. Deliberately NOT a size limit: on a
 * relay you host yourself the tokens are your own, and on one we host the
 * gate belongs at the door rather than in the shape of the payload.
 *
 * Returns a normalised copy, because "no actions" and "actions missing" mean
 * the same thing to everything downstream and should not be two cases.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { error: "Expected a manifest object. Generate one with `npx @yourco/voice-cli <srcDir> <outDir>` and pass it to VoiceProvider." };
  }
  const normalised = {};
  for (const key of ["routes", "queries", "actions"]) {
    const value = manifest[key];
    if (value !== undefined && !Array.isArray(value)) {
      return { error: `manifest.${key} must be an array, got ${typeof value}.` };
    }
    normalised[key] = value ?? [];
  }
  // A manifest with nothing in it is legitimate -- an app whose analysis found
  // nothing still gets the DOM tools -- but it is almost never intended, so it
  // is worth being able to see in a log.
  return { manifest: normalised, empty: !normalised.routes.length && !normalised.queries.length && !normalised.actions.length };
}

/** " Returns a list of items with: id, title, done." -- or nothing at all. */
function describeReturns(returns) {
  if (!returns) return "";
  if (returns.kind === "array") {
    const fields = Array.isArray(returns.of) ? returns.of : null;
    return fields?.length ? ` Returns a list; each item has: ${fields.join(", ")}.` : " Returns a list.";
  }
  if (returns.kind === "object" && returns.fields?.length) return ` Returns an object with: ${returns.fields.join(", ")}.`;
  return "";
}

export function buildTools(manifest) {
  const tools = [];

  /**
   * A DISPATCHER, not one typed function per operation.
   *
   * cal.diy has 177 operations. As typed tools that is ~15k tokens of prompt
   * prefix on every single response, and it walked a live session into a
   * per-minute rate limit -- half the turns failed. The tools cannot be
   * trimmed mid-session either (they are fixed at creation for prompt caching),
   * so a "reveal more tools" step cannot add typed functions later.
   *
   * So the operations become DATA, reached through three small tools that never
   * change. `run_query` and `run_action` call an operation by name; `expand`
   * reveals a topic's operations (see catalog.js). The base prompt carries only
   * the root operations and the topic names -- everything else is one expand
   * away, and the tool surface stays a handful of entries whatever the app's
   * size.
   *
   * The names come from the catalog in the instructions and from expand's
   * results. A name the manifest does not know is answered with an error, not a
   * guess.
   */
  tools.push(
    {
      type: "function",
      name: "run_query",
      description:
        "Read data from the app by calling one of its queries by name. Names come from the catalog " +
        "in your instructions and from expand() results. For a lookup, call ONCE with no filter and " +
        "pick from the result -- never one query per thing.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The query's name, exactly as the catalog gives it." },
          args: { type: "object", description: "Arguments for the query, or {} for none." },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "run_action",
      description:
        "Change something in the app by calling one of its actions by name. `items` is a LIST: one " +
        "entry per thing to change, a single change being a list of one. Put a whole set in ONE call " +
        "-- never call the same action repeatedly. A destructive action stages first and asks for " +
        "confirmation; a list is confirmed once for the whole set.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The action's name, exactly as the catalog gives it." },
          items: {
            type: "array",
            minItems: 1,
            description: "One entry per thing to change. For a single change, pass a list of one.",
            items: { type: "object" },
          },
        },
        required: ["name", "items"],
      },
    },
    {
      type: "function",
      name: "expand",
      description:
        "Reveal the tools grouped under a topic, when the catalog shows a topic name but not its " +
        "tools. Pass the topic exactly as listed (e.g. availability or availability/schedule). " +
        "Returns that topic's tools and any sub-topics you can expand further. Expand toward what the " +
        "user asked for; do not expand everything.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "The topic path from the catalog." } },
        required: ["topic"],
      },
    },
  );

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
      description:
        "Click one or more elements, in order, by the ids returned from dom_snapshot. Pass every " +
        "click the job needs in ONE call: turning on Saturday and Sunday is one call with two ids. " +
        "Stops at the first one that fails and says what it managed.",
      parameters: {
        type: "object",
        properties: { elementIds: { type: "array", items: { type: "string" } } },
        required: ["elementIds"],
      },
    },
    {
      type: "function",
      name: "dom_type",
      description:
        "Fill one or more inputs, in order, by the ids returned from dom_snapshot. Pass every field " +
        "in ONE call. Stops at the first one that fails and says what it managed.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { elementId: { type: "string" }, text: { type: "string" } },
              required: ["elementId", "text"],
            },
          },
        },
        required: ["items"],
      },
    },
    {
      type: "function",
      name: "dom_highlight",
      description:
        "Draw a ring around one element and scroll it into view, so the user can see where it is. " +
        "Points at it; does NOT press it. Use it to answer where something is and to show someone how " +
        "to do something themselves. Takes an id from dom_snapshot. The ring clears when they touch " +
        "the page or when you do anything else.",
      parameters: {
        type: "object",
        properties: { elementId: { type: "string" } },
        required: ["elementId"],
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
      name: "end_session",
      description:
        "Hang up: stop listening and release the microphone. Call this ONLY when the user " +
        "says they are done -- \"that's all\", \"thanks, goodbye\", \"stop listening\", " +
        "\"we're finished\". Say one short goodbye in the same turn. Do NOT call it because " +
        "you think the task is complete, because there is nothing left to do, or because " +
        "something failed: finishing a job is not the same as being dismissed, and only the " +
        "user decides when the conversation is over.",
      parameters: {
        type: "object",
        properties: {
          because: {
            type: "string",
            description:
              "The user's own words that ended the conversation, e.g. \"thanks, that's all for now\".",
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

  // The description when there is one, the component name only as a fallback.
  // A component name is frequently noise -- cal.diy's routes are called things
  // like "[type]" and "embed" -- while a description is the app's own sentence
  // about what the page is for, which is the whole reason it was harvested.
  const routeList = manifest.routes
    .map((r) => `- ${r.path}${r.description ? ` -- ${r.description}` : r.component ? ` (${r.component})` : ""}`)
    .join("\n");
  const confirmActions = manifest.actions.filter((a) => a.requiresConfirmation).map((a) => a.name);

  return `You are a voice assistant embedded in a task-management web app. You can see and control the app on the user's behalf using the tools available to you.

Known pages in this app:
${routeList}

The app's tools, by name. Call them with run_query and run_action:
${rootCatalog(manifest)}

Rules:
1. Prefer run_query and run_action -- they are reliable, direct calls into the app's own data. The catalog above lists what you can call now and the topics you can expand; if the tool you need is not there, expand the topic it belongs to before falling back. Only use dom_snapshot/dom_click/dom_type when no query or action fits at all.
2. Destructive actions (a tool marked destructive in the catalog or an expand result; currently: ${confirmActions.join(", ") || "none"}) take two steps, in this order. CALL THE TOOL FIRST: it does not execute anything, it stages the change and tells you to confirm. THEN ask the user, in plain language, naming what will change. Do not ask before calling it -- if you ask first you will ask again after staging, and the user has to say yes twice. If they agree, call confirm_pending_action (no arguments); that is what executes it. If they decline, call cancel_pending_action. Never call the destructive tool a second time to retry.
3. ACT, don't narrate. If a command maps to a tool, call it. Never describe what you could do, are about to do, or would need in order to do it -- just do it. Explaining instead of acting is the single worst thing you can do here.
4. Answer in ONE short sentence. Two or three words is usually right: "Done." / "Opened settings." / "Three tasks match." The user is looking at the screen and can see what changed, so do not describe the result in detail.
5. Never end with an offer of further help. No "anything else?", no "let me know if...", no restating the request back to the user. Say what happened and stop.
6. If something fails or no tool fits, say so in one sentence and stop. Do not propose alternatives unless asked. Say WHY it failed, not just that it did -- the tool result tells you, and it is the only thing the user can act on. This applies hardest to an action that stops part-way: report what it could not find and stop. Do not call it again, and do not finish it by hand with dom_click or dom_type. An action that stops is broken, not unlucky, and the user needs to hear which part.
7. A query result is only true for the turn it arrived in. The app changes underneath you -- the user edits things directly, and your own actions change them too -- so BEFORE stating a current value (a name, an email, a count, a status), call the query again in that same turn. Never answer from what a query told you earlier in the conversation. If the user questions an answer you gave -- "are you sure?", "double check", "really?" -- that is not a request for reassurance: re-run the query and say what it returns now, even if it contradicts what you just said.
8. run_action AND dom_click and dom_type take a LIST, so one call does the whole job. This is not tidiness: every call resends the whole conversation, and a handful of single clicks is what walks a session into a rate limit and ends it. "Create one per month" is ONE call with twelve entries; "delete all the weekdays" is ONE call with seven. A single change is a list of one entry. Never stop part-way through a list, and never call the same action twice for a set. For lookups, call the query ONCE with no filter and pick from the result -- never one query per thing.
9. When the user dismisses you -- "that's all", "thanks, goodbye", "stop listening" -- call end_session and say one short goodbye. That is the only reason to call it. Completing a task is not a dismissal, and neither is an error: if you hang up on your own judgement you take the microphone away from someone who was still talking to you.
10. Your replies are shown to the user as TEXT by default. If your next reply carries information they asked for and cannot see on screen -- an answer, a count, a value -- call answer_aloud in the same turn as the tool you are reporting on, and it will be spoken instead. Confirmations of things they just watched happen stay as text; do not call answer_aloud for those.

11. When someone asks WHERE something is, or how to do a thing themselves rather than asking you to do it, POINT AT IT: dom_snapshot, then dom_highlight on the element, then one short sentence. The ring is the answer, so do not describe the position in words as well ("top right", "under the calendar") -- that is the narration rule 3 forbids, and it is worse than the ring because the user then has to translate it. Highlighting counts as acting for rule 3. Point rather than press whenever the user is asking to learn: pressing it for them teaches nothing and takes the click away from someone who wanted to make it.${
    language
      ? `\n\n12. Speak and write in ${language.name}, always. Do not switch languages part-way through, and do not follow the language of the audio if it seems to differ -- the user has chosen ${language.name}.`
      : ""
  }`;
}
