import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTools, buildInstructions, resolveModel, resolveLanguage, validateManifest, MODELS, LANGUAGES } from "./tools.js";

const manifest = JSON.parse(readFileSync(new URL("../demo-app/.voice/manifest.json", import.meta.url), "utf8"));

describe("session options", () => {
  test("an unknown model is rejected, not quietly substituted", () => {
    // A browser asking for a model the account did not choose is a cost
    // decision made in the wrong place. Silent fallback hides it.
    assert.match(resolveModel("gpt-5-ultra", "gpt-realtime").error, /Unsupported model/);
    assert.equal(resolveModel("gpt-5-ultra", "gpt-realtime").model, undefined);
  });

  test("an allowed model passes through, and absent means default", () => {
    assert.equal(resolveModel("gpt-realtime-mini", "gpt-realtime").model, "gpt-realtime-mini");
    assert.equal(resolveModel(undefined, "gpt-realtime").model, "gpt-realtime");
    for (const m of MODELS) assert.equal(resolveModel(m.id, "gpt-realtime").model, m.id);
  });

  test("auto-detect is null, unknown codes are rejected", () => {
    assert.equal(resolveLanguage("auto").language, null);
    assert.equal(resolveLanguage(undefined).language, null);
    assert.match(resolveLanguage("xx").error, /Unsupported language/);
  });

  test("a chosen language is pinned in the instructions", () => {
    // The transcription hint alone does not stop the model answering in
    // another language -- one measured run replied in Vietnamese to English
    // audio -- so the reply language has to be stated in the prompt too.
    const es = buildInstructions(manifest, resolveLanguage("es").language);
    assert.match(es, /Speak and write in Spanish, always/);
    assert.doesNotMatch(buildInstructions(manifest, null), /Speak and write in/);
  });

  test("every offered language has a name to put in the prompt", () => {
    for (const l of LANGUAGES.filter((x) => x.code !== "auto")) {
      assert.ok(l.name, `${l.code} has no name`);
      assert.match(buildInstructions(manifest, l), new RegExp(`Speak and write in ${l.name}`));
    }
  });
});

describe("answer_aloud", () => {
  const tools = buildTools(manifest);
  const aloud = tools.find((t) => t.name === "answer_aloud");

  test("is offered, and asks for a reason", () => {
    // The reason is not decoration. A no-op tool with no payload is an odd
    // thing for a model to call; making it state why improves the odds it is
    // called deliberately, and gives one log line per decision to tune on.
    assert.ok(aloud, "answer_aloud is missing from the tool list");
    assert.deepEqual(aloud.parameters.required, ["because"]);
    assert.equal(aloud.parameters.properties.because.type, "string");
  });

  test("its description says when NOT to call it", () => {
    // Left to "call this when speech is warranted", the model finds a
    // justification every time -- measured at 6 spoken turns out of 6.
    assert.match(aloud.description, /same turn/i);
    assert.match(aloud.description, /do not|don't/i);
  });

  test("the session keeps the server's detector but not its response", () => {
    const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
    assert.match(index, /turn_detection: \{ type: "server_vad", create_response: false \}/);
  });
});

describe("batching", () => {
  const tools = buildTools(manifest);
  const create = tools.find((t) => t.name === "action_createTask");
  const del = tools.find((t) => t.name === "action_deleteTask");

  test("queries stay a plain schema, and are told to fetch once", () => {
    // Wrapping them would make "list everything" into {"items":[{}]}, an array
    // holding one empty object. The model ignored the query batch form anyway.
    for (const t of tools.filter((x) => x.name.startsWith("query_"))) {
      assert.equal(t.parameters.properties.items, undefined, `${t.name} should not take a list`);
      assert.match(t.description, /call this ONCE with no filter/i);
    }
  });

  test("actions take a list, and the schema can say so strictly again", () => {
    // Offering items ALONGSIDE the plain fields meant the schema had to say
    // "either these or that", which is the one thing it cannot say: anyOf and
    // friends are rejected at the ROOT of a tool's parameters. One shape
    // removes the either/or, and required comes back at both levels.
    for (const t of tools.filter((x) => x.name.startsWith("action_"))) {
      assert.deepEqual(t.parameters.required, ["items"], `${t.name} root required`);
      assert.equal(t.parameters.properties.items.minItems, 1, `${t.name} allows an empty batch`);
      assert.ok(t.parameters.properties.items.items.properties, `${t.name} entries are unconstrained`);
    }
    assert.deepEqual(create.parameters.properties.items.items.required, ["title"]);
  });

  test("a destructive batch says it is confirmed once", () => {
    // Seven weekdays became seven separate stage-and-confirm rounds and forty
    // seconds of the user saying "yep".
    assert.match(del.description, /confirmed once, for the whole set/i);
    assert.match(create.description, /Never call this repeatedly for a set/i);
  });

  test("the instructions forbid stopping part-way through a list", () => {
    const rules = buildInstructions(manifest);
    assert.match(rules, /takes a LIST of changes/);
    assert.match(rules, /Never stop part-way/i);
  });
});

describe("destructive ordering", () => {
  test("the rule states the order, and names the failure", () => {
    // Observed live: the model asked "would you like to confirm?", the user
    // said yes, THEN it staged -- which asks again. The user confirmed twice.
    const rules = buildInstructions(manifest);
    assert.match(rules, /CALL THE TOOL FIRST/);
    assert.match(rules, /Do not ask before calling it/);
    assert.match(rules, /say yes twice/);
  });
});

describe("staleness", () => {
  const rules = buildInstructions(manifest);

  test("a query result expires at the end of its turn", () => {
    // Observed live: it read settings once, then answered questions 130 and
    // 160 seconds later from that snapshot. Both answers were wrong -- the
    // name had changed to "Steve Branson Jr" in between.
    assert.match(rules, /only true for the turn it arrived in/i);
    assert.match(rules, /Never answer from what a query told you earlier/i);
  });

  test("being challenged means re-checking, not repeating", () => {
    // The worst moment in that session: asked "You sure?", it re-asserted the
    // wrong name with an added "Yes" and no tool call. A wrong answer that
    // survives being questioned teaches the user not to question.
    assert.match(rules, /are you sure\?", "double check"/i);
    assert.match(rules, /re-run the query/i);
  });

  test("the batching rule cannot be read as licence to reuse an old result", () => {
    // Rule 8 says call a query ONCE rather than once per item. Read across
    // turns instead of within one, that argues for exactly the wrong thing,
    // so the staleness rule comes first.
    const staleness = rules.indexOf("only true for the turn it arrived in");
    const batching = rules.indexOf("call the query ONCE with no filter");
    assert.ok(staleness > 0 && batching > 0);
    assert.ok(staleness < batching, "the staleness rule must come before the batching one");
  });
});

describe("the rule list", () => {
  test("numbers run 1..n once each, in every language", () => {
    // The language rule carries its own hardcoded number, so it silently
    // collided with a rule in the main list the moment one was inserted --
    // it shipped as a second "7" for as long as there were six rules.
    for (const language of [undefined, { code: "es", name: "Spanish" }]) {
      const numbers = [...buildInstructions(manifest, language).matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
      assert.deepEqual(numbers, numbers.map((_, i) => i + 1), `numbering broke for ${language?.name ?? "auto"}`);
    }
  });
});

describe("hanging up", () => {
  const rules = buildInstructions(manifest);
  const endSession = buildTools(manifest).find((t) => t.name === "end_session");

  test("the tool exists and asks why", () => {
    // `because` carries the user's own words. Without it a hang-up in the log
    // is indistinguishable from a dropped connection.
    assert.ok(endSession);
    assert.deepEqual(endSession.parameters.required, ["because"]);
  });

  test("only the user ends the conversation", () => {
    // The terseness rules already push it toward wrapping up. Left vaguer than
    // this, "act, don't narrate" plus "never offer further help" reads a lot
    // like permission to hang up the moment a task succeeds.
    assert.match(endSession.description, /ONLY when the user/);
    assert.match(endSession.description, /Do NOT call it because you think the task is complete/);
    assert.match(rules, /Completing a task is not a dismissal, and neither is an error/);
  });

  test("the goodbye is part of the same turn", () => {
    assert.match(rules, /call end_session and say one short goodbye/);
  });
});

describe("the manifest comes from the app", () => {
  test("a missing one is refused, not defaulted", () => {
    // The bug this replaces: MANIFEST_PATH fell back to the demo app's file,
    // so a relay restarted without it served a task manager's manifest to a
    // calendar app. The agent then correctly explained the app had no
    // bookings page. A wrong-but-plausible default is the worst outcome
    // available, so there is no default any more.
    for (const bad of [undefined, null, "", 0, [], "not-an-object"]) {
      assert.ok(validateManifest(bad).error, `${JSON.stringify(bad)} was accepted as a manifest`);
    }
  });

  test("the three sections are optional but must be arrays if present", () => {
    assert.ok(validateManifest({ routes: {} }).error);
    assert.ok(validateManifest({ queries: "none" }).error);
    assert.match(validateManifest({ actions: 3 }).error, /manifest\.actions must be an array/);
  });

  test("missing sections normalise to empty, so downstream has one case", () => {
    const checked = validateManifest({ routes: [{ path: "/" }] });
    assert.equal(checked.error, undefined);
    assert.deepEqual(checked.manifest.queries, []);
    assert.deepEqual(checked.manifest.actions, []);
  });

  test("an empty manifest is legal, and says so", () => {
    // Legitimate: an app whose analysis found nothing still gets the DOM
    // tools. Almost never intended, though, so it is worth seeing in a log.
    const checked = validateManifest({});
    assert.equal(checked.error, undefined);
    assert.equal(checked.empty, true);
    assert.equal(validateManifest({ routes: [{ path: "/" }] }).empty, false);
  });

  test("no size limit", () => {
    // Deliberate. On a relay you host, the tokens are your own; on one we
    // host, the gate belongs at the door rather than in the payload's shape.
    const huge = { routes: Array.from({ length: 5000 }, (_, i) => ({ path: `/r${i}` })), queries: [], actions: [] };
    assert.equal(validateManifest(huge).error, undefined);
  });

  test("tools are still built from whatever arrives", () => {
    const checked = validateManifest(JSON.parse(JSON.stringify(manifest)));
    const names = buildTools(checked.manifest).map((t) => t.name);
    assert.ok(names.includes("query_tasks"));
    assert.ok(names.includes("navigate"), "the generic fallbacks do not depend on the manifest");
  });
});

describe("what a query returns", () => {
  test("reaches the model when something has found it out", () => {
    // Static analysis cannot say this at all, so the model was inferring the
    // shape from the tool's name and whatever arrived at runtime. Probing the
    // running app answers it in one call, and a dozen tokens removes a guess.
    const probed = JSON.parse(JSON.stringify(manifest));
    probed.queries.find((q) => q.name === "tasks").returns = { kind: "array", of: ["id", "title", "done"] };
    const tool = buildTools(probed).find((t) => t.name === "query_tasks");
    assert.match(tool.description, /Returns a list; each item has: id, title, done\./);
  });

  test("an object shape reads differently from a list", () => {
    const probed = JSON.parse(JSON.stringify(manifest));
    probed.queries.find((q) => q.name === "settings").returns = { kind: "object", fields: ["name", "theme"] };
    assert.match(buildTools(probed).find((t) => t.name === "query_settings").description, /Returns an object with: name, theme\./);
  });

  test("a manifest that has never been probed reads exactly as before", () => {
    // Most manifests will not have this. It has to be additive.
    const tool = buildTools(manifest).find((t) => t.name === "query_tasks");
    assert.doesNotMatch(tool.description, /Returns/);
  });

  test("a shape with no fields adds nothing rather than an empty sentence", () => {
    const probed = JSON.parse(JSON.stringify(manifest));
    probed.queries.find((q) => q.name === "tasks").returns = { kind: "object", fields: [] };
    assert.doesNotMatch(buildTools(probed).find((t) => t.name === "query_tasks").description, /Returns/);
  });
});

describe("a flow is an action that runs in the page", () => {
  const withFlow = () => {
    const m = JSON.parse(JSON.stringify(manifest));
    m.actions.push({
      name: "createEventType",
      description: "Create a new event type",
      transport: "dom",
      params: [],
      bodyFields: [{ name: "title", required: true, type: "string" }, { name: "duration", type: "number" }],
      requiresConfirmation: false,
      steps: [{ click: "New" }, { type: "Title", from: "title" }],
    });
    return m;
  };

  test("it becomes an ordinary action tool", () => {
    // The whole point of modelling it this way: the model calls
    // action_createEventType with named fields and never learns a dialog is
    // involved. Nothing in the tool list is new.
    const tool = buildTools(withFlow()).find((t) => t.name === "action_createEventType");
    assert.ok(tool);
    const entry = tool.parameters.properties.items.items;
    assert.deepEqual(Object.keys(entry.properties), ["title", "duration"]);
    assert.deepEqual(entry.required, ["title"]);
  });

  test("but the description says it happens on screen", () => {
    // "It stopped at step 3" means something different from a failed HTTP
    // call, and the model has to know that is possible.
    const tool = buildTools(withFlow()).find((t) => t.name === "action_createEventType");
    assert.match(tool.description, /on screen, one step at a time/);
    assert.match(tool.description, /stop partway/);
  });

  test("an HTTP action says nothing of the kind", () => {
    const tool = buildTools(manifest).find((t) => t.name === "action_createTask");
    assert.doesNotMatch(tool.description, /on screen/);
  });

  test("steps are not exposed to the model", () => {
    // They are execution detail. Putting them in the prompt would cost tokens
    // and invite the model to reason about clicking, which is the thing this
    // exists to stop it doing.
    const tool = buildTools(withFlow()).find((t) => t.name === "action_createEventType");
    assert.doesNotMatch(JSON.stringify(tool), /steps|dom_snapshot|click/i);
  });
});

describe("what the model is told about routes", () => {
  test("a description is used when there is one", () => {
    // Built the harvest, then found it never reached the model: the prompt
    // said "- /:user/:type/embed (embed)" and nothing else, so 53 harvested
    // sentences were inert.
    const m = JSON.parse(JSON.stringify(manifest));
    m.routes[0] = { path: "/event-types", component: "[type]", description: "Event types. Configure different events." };
    assert.match(buildInstructions(m), /- \/event-types -- Event types\. Configure different events\./);
  });

  test("the component name is only a fallback", () => {
    // It is frequently noise -- cal.diy's routes are called "[type]" and
    // "embed" -- while a description is the app's own sentence.
    const m = JSON.parse(JSON.stringify(manifest));
    m.routes[0] = { path: "/x", component: "Thing", description: "What this page is for." };
    const line = buildInstructions(m).split("\n").find((l) => l.startsWith("- /x"));
    assert.equal(line, "- /x -- What this page is for.");
    assert.ok(!line.includes("Thing"));
  });

  test("a route with neither reads as just its path", () => {
    const m = JSON.parse(JSON.stringify(manifest));
    m.routes[0] = { path: "/bare" };
    assert.ok(buildInstructions(m).includes("\n- /bare\n"));
  });

  test("call-site counts never reach the model", () => {
    // Diagnostic, for whoever writes the include list. In the prompt it would
    // be tokens spent on a number the model cannot use.
    const m = JSON.parse(JSON.stringify(manifest));
    m.queries[0].callSites = 7;
    const payload = JSON.stringify({ i: buildInstructions(m), t: buildTools(m) });
    assert.ok(!payload.includes("callSites"));
  });
});
