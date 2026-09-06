/**
 * Checking the manifest against the running app.
 *
 * Static analysis reads structure, and structure is not behaviour. It can see
 * that a route file exists and that a schema marks a field optional; it cannot
 * see that the route redirects, that the endpoint moved, or that the server
 * rejects the request without a field the schema calls optional. Only asking
 * the app settles those.
 *
 * Probing also DISCOVERS things static analysis cannot express at all. The
 * manifest has no way to say what a query returns, and the agent has to guess
 * from the name. One call answers it.
 *
 * Pure here, performed by probe.js. Deciding what to ask and reading the
 * answer is the part worth testing; making an HTTP request is not.
 */

/** A route with a parameter cannot be visited without inventing a value, and
 *  an invented id is a 404 that means nothing about the manifest. */
export const isProbeableRoute = (route) => !/[:{*]/.test(route.path);

/**
 * What to ask of each route and query.
 *
 * Actions are absent on purpose. Probing a write means performing one, and
 * that is a decision the caller makes explicitly rather than a default.
 */
export function readOnlyPlan(manifest) {
  const plan = [];
  for (const route of manifest.routes ?? []) {
    if (!isProbeableRoute(route)) {
      plan.push({ kind: "route", name: route.path, skipped: "has a parameter; no value to put in it" });
      continue;
    }
    plan.push({ kind: "route", name: route.path, method: "GET", url: route.path });
  }
  for (const query of manifest.queries ?? []) {
    const needed = (query.params ?? []).filter((p) => p.required && p.source === "url");
    if (needed.length) {
      plan.push({ kind: "query", name: query.name, skipped: `needs ${needed.map((p) => p.name).join(", ")}` });
      continue;
    }
    plan.push({ kind: "query", name: query.name, method: "GET", url: query.endpoint, operation: query });
  }
  return plan;
}

/**
 * Whether a page answered.
 *
 * A redirect is not a failure: plenty of real routes bounce to a canonical
 * path or to a login page, and following it would only prove that the app has
 * authentication. What matters is that the path is KNOWN -- a 404 means the
 * agent has been told about a page that is not there, and will send someone to
 * it with confidence.
 */
export function readRoute(status) {
  if (status === 404 || status === 410) return { ok: false, why: `the page is not there (${status})` };
  if (status >= 500) return { ok: false, why: `the page errors (${status})` };
  if (status === 401 || status === 403) return { ok: true, note: "exists, behind authentication" };
  if (status >= 300 && status < 400) return { ok: true, note: "redirects" };
  return { ok: true };
}

/**
 * A compact description of what a query returns.
 *
 * The manifest cannot say this today, so the model infers it from the tool
 * name and whatever comes back at runtime. Naming the fields costs a dozen
 * tokens and removes the guess. Deliberately shallow: a full JSON Schema of a
 * booking would cost more than every other entry combined.
 */
export function describeShape(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const first = value.find((v) => v && typeof v === "object");
    return { kind: "array", of: first ? describeShape(first, depth + 1)?.fields ?? [] : typeof value[0] };
  }
  if (typeof value === "object") {
    // One level of unwrapping for the envelopes every API uses.
    if (depth === 0) {
      for (const key of ["data", "result", "items", "results"]) {
        if (value[key] !== undefined) return describeShape(value[key], depth + 1);
      }
    }
    return { kind: "object", fields: Object.keys(value).slice(0, 20) };
  }
  return { kind: typeof value };
}

/**
 * One request per declared-required field, each missing exactly that field.
 *
 * The declaration is a guess: Zod's `.optional()` and TypeScript's `?:` say
 * what the CLIENT believes, and the server is the one that decides. A request
 * missing a genuinely required field is rejected before anything is written,
 * which is what makes this safe to ask.
 */
export function omissionProbes(operation) {
  const fields = operation.bodyFields ?? [];
  const required = fields.filter((f) => f.required);
  if (!required.length) return [];

  const full = Object.fromEntries(fields.map((f) => [f.name, sampleFor(f)]));
  return required.map((field) => ({
    omitted: field.name,
    body: Object.fromEntries(Object.entries(full).filter(([k]) => k !== field.name)),
  }));
}

/** A value of the right type, so a rejection is about absence and not shape. */
function sampleFor(field) {
  if (field.enumValues?.length) return field.enumValues[0];
  switch (field.type) {
    case "number": return 1;
    case "boolean": return false;
    case "array": return [];
    default: return "probe";
  }
}

/**
 * What an omission proved.
 *
 * A rejection confirms the field is required. Anything else means it is not,
 * and the manifest is telling the model to always send something the app does
 * not need -- which is how an agent ends up inventing a value to fill a field
 * nobody asked for.
 */
export function readOmission(field, status) {
  if (status >= 400 && status < 500) return { field, required: true };
  if (status >= 500) return { field, required: null, note: "the server errored; nothing learned" };
  return { field, required: false, note: "accepted without it" };
}
