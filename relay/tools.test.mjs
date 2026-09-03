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

  test("queries batch too, and are nudged toward one unfiltered call", () => {
    // Asked to delete seven weekdays, the model made seven separate
    // query_tasks({search:"Monday"}) calls to find them.
    for (const t of tools.filter((x) => x.name.startsWith("query_"))) {
      assert.ok(t.parameters.properties.items, `${t.name} has no batch form`);
      assert.match(t.description, /call this ONCE with no filter/i);
    }
  });

  test("every action takes a list as well as a single item", () => {
    // "Create one task per month" produced four calls and then stopped, and
    // took eight more prompts to finish. One call with a list is fewer round
    // trips, fewer tokens, and no chance of stopping half way.
    for (const t of tools.filter((x) => x.name.startsWith("action_"))) {
      assert.ok(t.parameters.properties.items, `${t.name} has no batch form`);
      assert.equal(t.parameters.properties.items.type, "array");
    }
  });

  test("a batch entry takes the same fields as a single call", () => {
    const single = Object.keys(create.parameters.properties).filter((k) => k !== "items");
    assert.deepEqual(Object.keys(create.parameters.properties.items.items.properties).sort(), single.sort());
  });

  test("neither form is required, since it is one or the other", () => {
    assert.equal(create.parameters.required, undefined);
  });

  test("a destructive batch says it is confirmed once", () => {
    // Seven weekdays became seven separate stage-and-confirm rounds and forty
    // seconds of the user saying "yep".
    assert.match(del.description, /confirmed once, for the whole set/i);
    assert.match(create.description, /prefer a single call with `items`/i);
  });

  test("the instructions forbid stopping part-way through a list", () => {
    const rules = buildInstructions(manifest);
    assert.match(rules, /ONE call using `items`/);
    assert.match(rules, /Never stop part-way/i);
  });
});
