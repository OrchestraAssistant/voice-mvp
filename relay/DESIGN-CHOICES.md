
---

## 17. Cost measurement lives in the relay, not in the package

**Chosen:** the relay totals every session it logs and appends a `summary`
line; `relay/usage-report.mjs` compares sessions and models. Nothing reaches
the widget's public API.

**Why not the hook.** This is a bench instrument for choosing a provider, not
a feature a host app needs. The relay already receives every event a session
produces, so it is the one place that can total a session without the client
knowing it is being measured, and without adding a field somebody later
depends on.

**Two things make this harder than summing a column.**

Cached input is *inside* `input_tokens`, not additional to it. Adding both
charges the prompt prefix twice, and the prefix is the largest thing in these
sessions: one measured session carried 4,160 cached tokens inside 6,431 input
tokens. The tally subtracts it out at fold time, using
`cached_tokens_details`, so every field afterwards means what it says.

Audio and text price differently in both directions, by roughly an order of
magnitude. A single "input tokens" total cannot answer the only question worth
asking here, which is what the audio costs.

**Unpriced is not free.** A model with no entry returns `priced: false` rather
than a total of zero, because a silent zero makes an unknown provider look
like the cheapest thing in the comparison.

**Providers do not agree on the unit.** An entry may price per million tokens,
per minute of transcription, per minute of connected time, or any combination,
so a provider that bills by the clock can be compared against one that bills by
the token. `--prices mine.json` replaces the whole table without touching the
source.

**Calibration.** Totalled across the six real sessions on disk, the busiest one
comes out near the figure the OpenAI dashboard reported for it, which is the
only external check available. The rates in `PRICES` are list prices, they go
stale, and the report says so every time it runs.
