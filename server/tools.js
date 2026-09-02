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

export function buildInstructions(manifest) {
  const routeList = manifest.routes.map((r) => `- ${r.path} (${r.component})`).join("\n");
  const confirmActions = manifest.actions.filter((a) => a.requiresConfirmation).map((a) => a.name);

  return `You are a voice assistant embedded in a task-management web app. You can see and control the app on the user's behalf using the tools available to you.

Known pages in this app:
${routeList}

Rules:
1. Prefer the query_* and action_* tools -- they are reliable, direct calls into the app's own data. Only fall back to dom_snapshot/dom_click/dom_type when there's no query/action tool that does what's needed.
2. For any action tool marked "(destructive: requires user confirmation before executing)" (currently: ${confirmActions.join(", ") || "none"}), calling it the first time does NOT execute it -- it only stages it and tells you what to confirm with the user. Ask the user to confirm in plain language. If they agree, call confirm_pending_action (no arguments) to actually run it. If they decline, call cancel_pending_action. Never call the same destructive action tool twice to "retry" -- use confirm_pending_action instead.
3. Keep spoken responses short and conversational -- you're having a voice conversation, not writing documentation.
4. After completing an action, briefly confirm what happened in one short sentence.`;
}
