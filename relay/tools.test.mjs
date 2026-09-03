import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTools, buildInstructions, resolveModel, resolveLanguage, MODELS, LANGUAGES } from "./tools.js";

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
