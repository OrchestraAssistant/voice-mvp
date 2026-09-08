---
name: yourco-voice
description: Set up and maintain @yourco/voice for an app — generate the manifest from source, probe it against the running app, then run the judgement pass that turns flagged operations into real descriptions and tiers. Use when adding voice control to an app, or when a voice session misbehaves (silent no-ops, wrong argument shapes, a page read before it loaded).
---

# Using @yourco/voice — generate, probe, judge

`@yourco/voice` gives an app voice control from a **manifest**: a description of
the app's operations — queries, actions, routes — that the voice agent drives.
This skill is how you BUILD and MAINTAIN that manifest well.

You are the code-literate agent already open with the repo. There is no API key
and no separate model to provision: you run the package's own tools and read the
app's source. That is the whole point.

The manifest is built in three stages, each doing only what it can, in order:

- **Static analysis** (`voice-cli`) finds the operations from source. Exhaustive,
  cheap, and knows nothing about what matters.
- **Probing** (`voice-probe`) confirms them against the running app and measures
  what source cannot — which routes are real, when a page is ready, what a write
  truly requires.
- **The judgement pass** (you) does the one thing neither can: judge which
  operations a person would speak to, what each is FOR in a sentence, and the
  contracts a handler enforces but the schema never states.

## 1. Generate

From the app root:

```
npx @yourco/voice-cli [srcDir] [outDir]     # defaults: ./src (or .) -> ./.voice
```

This writes `.voice/manifest.json`. Read the output — every stage that fired,
and every one that found nothing and why. The manifest also carries the
**worklist** for stage 3: the operations it could not fully understand, tagged
`review` / `confidence` / empty `bodyFields` (see stage 3).

## 2. Probe — recommended, and it needs the running app

```
npx voice-probe .voice/manifest.json http://localhost:3000 \
    --login spec.json --browser [--writes] [--effects fixtures.json] [--fix]
```

- `--login spec.json` signs in first (credentials in a FILE, never on the command
  line — they end up in shell history otherwise).
- `--browser` uses a real browser to measure readiness (`readyWhen` markers, so
  navigate waits for a page instead of guessing). Skip it and pages are inferred,
  not confirmed. CI with no browser is fine — the probe says so and carries on.
- `--writes` probes write actions by performing them, so point it at a **seeded,
  throwaway instance**.
- `--effects fixtures.json` verifies a write actually CHANGES state: it sends a
  call and reads the result back. A `2xx` that changed nothing is a silent no-op
  — the most dangerous failure, because it looks like success.
- `--fix` writes what it learned into `.voice/manifest.overlay.json`.

## 3. The judgement pass — where you come in

Static analysis reads structure and probing measures behaviour; neither can
JUDGE. This stage is judgement, done against the app's own source.

### The one rule about where to write

**Never edit `.voice/manifest.json`.** It is regenerated from source and your
edits would be erased. Write into **`.voice/manifest.overlay.json`**, which is
merged last and OUTRANKS the generated file. Patches match by identity: routes
by `path`, queries and actions by `name`. A patch carries only the fields you are
changing. Re-running `voice-cli` applies the overlay; the probe confirms it.

### The worklist is already in the manifest

Do not review all 200 operations. The generator flagged the ones that need you.
Open `.voice/manifest.json` and find:

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

### The loop, per flagged operation

1. **Read the reason, follow it to the source.** Open that file. Read the
   handler, the schema, the form. Understand what the operation is FOR and what it
   truly requires — including anything the schema lies about.
2. **Write a real `description` into the overlay.** It reaches the model in the
   catalog, so write it FOR the model: what it does, in a sentence, plus any trap
   or convention the model cannot infer. Not "Auto-detected tRPC mutation
   schedule.update" — that is what you are replacing.
3. **Confirm a write with the read-back probe.** Write a fixture holding the
   NATURAL call a model would make, run `voice-probe --writes --effects fx.json`,
   and read the verdict. A `2xx` that changed nothing means the description must
   name the load-bearing field. A verified change earns the operation `known`.
4. **Assign a `group` (tier).** A fresh manifest has everything at the root, so it
   all ships in the base prompt. Move niche operations down into `group` paths
   (`["availability","schedule"]`) so the base prompt lists ~20 things a person
   would actually speak, and the rest are an `expand` away. Give each topic a
   one-line entry in `groups`.

### The worked example (cal.diy, and why this stage exists)

`availabilityScheduleUpdate` came out flagged `opaque` (a nested array) and its
runtime call kept silently doing nothing. Reading `ScheduleService.ts` shows two
things no schema states:

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
  "groups": [{ "path": ["availability"], "description": "when you are bookable" }]
}
```

Then a fixture WITH `name` verifies through the probe, and the flag is resolved.

### The honesty rules

- **Read the source; do not invent.** A guessed description is worse than the
  auto-generated one, because it reads as authoritative. If you cannot determine a
  contract from the code, leave the operation flagged and say so.
- **A description is for the model, not for docs.** Lead with what it does; spend
  the rest only on what the model would otherwise get wrong.
- **Prefer promoting `known` via the probe over asserting it.** A verified
  read-back is proof; your confidence is a guess until it passes.
- **Leave `readyWhen` to the probe** unless you have a reason it got one wrong —
  it measures the running page; you are reading static source.

## When you are done

Re-run `voice-cli` (applies the overlay) and, for the writes you touched, the
read-back probe (confirms them). The flag count should drop, the catalog
descriptions should read like a person wrote them, and a voice session should
stop guessing at the contracts you just wrote down.
