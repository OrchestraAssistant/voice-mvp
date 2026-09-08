---
name: enrich-voice-manifest
description: Enrich a generated @yourco/voice manifest — resolve the review/unknown flags into real descriptions, group/tier assignments, and readiness notes, written into manifest.overlay.json and confirmed with the probe. Use after `voice-cli` has generated a manifest, when operations are flagged for review or a voice session mis-calls an API (silent no-ops, wrong argument shapes).
---

# Enriching a voice manifest — the judgement pass

`voice-cli` extracts what static analysis can see, and the probe measures what a
running app confirms. Neither can JUDGE: which of two hundred operations a person
would actually speak to, what a tool is FOR in one sentence, or the contract a
handler enforces but the schema does not state. That is this pass — the third
stage. You are the judging actor, working against the app's own source.

You do NOT need an API key or a separate model. You are the agent the developer
already has open, with the repo loaded. Read the code; write the judgement down.

## The one rule about where to write

**Never edit `.voice/manifest.json`.** It is regenerated from source and your
edits would be erased. Write into **`.voice/manifest.overlay.json`**, which is
merged last and OUTRANKS the generated file. Patches are matched by identity:
routes by `path`, queries and actions by `name`. A patch carries only the fields
you are changing. Regenerating (`voice-cli`) applies the overlay; the probe
confirms it.

## The worklist is already in the manifest

Do not review all 200 operations. The generator has flagged the ones that need
you. Open `.voice/manifest.json` and find:

- **`review` on an operation** — an array of `{ field, kind, reason }`. `kind` is
  `opaque` (a convention rides on a shape — a positional array, an unlabelled
  code), `unknown` (the shape itself is undetermined — `z.any`, or a write whose
  body could not be read), or `truncated` (a nested shape shown only partway).
  **The `reason` points you at the source** — an unresolved schema symbol to
  chase, a hook's form to read, or the handler itself.
- **`confidence: "review" | "unknown"`** — the operation the runtime distrusts.
  `known` is the default and is left off.
- **empty `bodyFields` on a write action** — the input shape was not resolvable.

Those are your list. Everything else the machine already knows well enough.

## The loop, per flagged operation

1. **Read the reason, follow it to the source.** The reason names where to look.
   Open that file. Read the handler, the schema, the form. Understand what the
   operation is FOR and what it truly requires — including anything the schema
   lies about.
2. **Write a real `description` into the overlay.** It reaches the model in the
   catalog, so write it FOR the model: what the operation does, in a sentence,
   plus any trap or convention the model cannot infer. Not
   "Auto-detected tRPC mutation schedule.update" — that is what you are replacing.
3. **Confirm a write with the read-back probe.** Write a fixture holding the
   NATURAL call a model would make, run `voice-probe --writes --effects fx.json`
   against a throwaway instance, and read the verdict. A `2xx` that changed
   nothing is a silent no-op — the description must then name the load-bearing
   field. A verified change earns the operation `known`.
4. **Assign a `group` (tier).** A freshly generated manifest has everything at
   the root, so it all ships in the base prompt. Move niche operations down into
   `group` paths (`["availability","schedule"]`) so the base prompt lists ~20
   things a person would actually speak, and the rest are an `expand` away. Give
   each topic a one-line entry in `groups`.

## The worked example (cal.diy, and why this stage exists)

`availabilityScheduleUpdate` came out flagged `opaque` (a nested array) and its
runtime call kept silently doing nothing. Reading `ScheduleService.ts` shows
two things no schema states:

- The handler does `if (!input.name) return` — **`name` is required in practice**
  though the schema marks it optional. Omit it and the write is a silent no-op.
- `schedule` is a **7-element array, index 0 = Sunday … 6 = Saturday**, each
  element a list of `{ start, end }` windows, `[]` for a closed day.

Neither is extractable; both are judgement. The note that closes it:

```json
{
  "actions": [
    {
      "name": "availabilityScheduleUpdate",
      "group": ["availability", "schedule"],
      "description": "Update a schedule's weekly availability. ALWAYS include `name` (the schedule's current name) — without it the update is silently ignored. `schedule` is a 7-element array, index 0=Sunday..6=Saturday; each element is a list of {start, end} windows, [] for a closed day."
    }
  ],
  "groups": [
    { "path": ["availability"], "description": "when you are bookable" }
  ]
}
```

Then a fixture WITH `name` verifies through the probe, and the flag is resolved.

## The honesty rules

- **Read the source; do not invent.** A description you guessed is worse than the
  auto-generated one, because it reads as authoritative. If you cannot determine
  a contract from the code, leave the operation flagged and say so — a probe or a
  human can take it further.
- **A description is for the model, not for docs.** Lead with what it does; spend
  the rest only on what the model would otherwise get wrong.
- **Prefer promoting `known` via the probe over asserting it.** A verified
  read-back is proof; your confidence is a guess until it passes.
- **Leave `readyWhen` to the probe** unless you have a reason it got one wrong;
  the probe measures the running page and you are reading static source.

## When you are done

Re-run `voice-cli` (applies the overlay) and, for the writes you touched, the
read-back probe (confirms them). The manifest's flag count should drop, the
catalog descriptions should read like a person wrote them, and a voice session
should stop guessing at the contracts you just wrote down.
