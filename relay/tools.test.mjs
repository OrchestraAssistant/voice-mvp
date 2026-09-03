import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildInstructions, resolveModel, resolveLanguage, MODELS, LANGUAGES } from "./tools.js";

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
