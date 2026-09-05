/**
 * Not everything an app exposes is something a person would ask for.
 *
 * Reading Next.js route handlers turned up 84 endpoints in cal.diy, and the
 * list included `createCronBookingReminder`, `createAuthOauthToken` and
 * `createWebhookAppCredential`. Those are machinery: schedulers calling
 * themselves, OAuth handshakes, provider callbacks. Nobody says them out loud,
 * and handing them to a model is cost and risk with no upside.
 *
 * It IS cost, measurably. The tool list rides in the session prompt, so those
 * 84 endpoints took the prefix from ~2,500 tokens to ~10,900 -- paid in full
 * on the first response of every session.
 *
 * So discovery and exposure are separated. Everything found is reported;
 * infrastructure is left out by default and can be put back by naming it in
 * the overlay, which is the same escape hatch that adds what detection missed.
 */
const INFRASTRUCTURE = [
  { pattern: /^\/api\/auth\//, why: "authentication handshakes" },
  { pattern: /^\/api\/cron\//, why: "scheduled jobs the app calls itself" },
  { pattern: /^\/api\/webhooks?\b/, why: "inbound webhooks from other services" },
  { pattern: /^\/api\/trpc\//, why: "the tRPC transport, not an endpoint a user means" },
  { pattern: /^\/api\/integrations\//, why: "third-party integration callbacks" },
  { pattern: /\/callback\b/, why: "an OAuth or provider callback" },
  { pattern: /^\/api\/_/, why: "private by naming convention" },
  { pattern: /^\/api\/(health|status|ping|metrics)\b/, why: "operational probes" },
];

/** Splits what was found into what to ship and what to leave out, with reasons. */
export function excludeInfrastructure(manifest, keep = []) {
  const excluded = [];
  for (const kind of ["queries", "actions"]) {
    manifest[kind] = (manifest[kind] ?? []).filter((item) => {
      if (keep.includes(item.name)) return true;
      const hit = INFRASTRUCTURE.find((rule) => rule.pattern.test(item.endpoint ?? ""));
      if (!hit) return true;
      excluded.push({ name: item.name, endpoint: item.endpoint, why: hit.why });
      return false;
    });
  }
  return excluded;
}
