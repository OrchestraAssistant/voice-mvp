/**
 * How a manifest operation becomes an HTTP request.
 *
 * Two shapes so far. `rest` is a URL with parameters substituted, a query
 * string, and a JSON body. `trpc` is not REST at all: procedures are addressed
 * by path, input is superjson-wrapped as `{ json: ... }`, and it travels in a
 * query string for a query and in the body for a mutation. Sending a tRPC
 * procedure a plain REST body gets a 400 that says nothing useful.
 *
 * Pure on purpose. Building the request and reading the response are the parts
 * that are easy to get subtly wrong and impossible to check by eye, so they
 * are separated from the fetch that performs them.
 */

/** Substitutes {name} placeholders, leaving the rest of the path alone. */
export function buildUrl(template, args) {
  let url = template;
  for (const [key, value] of Object.entries(args)) {
    url = url.replace(`{${key}}`, encodeURIComponent(value));
  }
  return url;
}

export const rest = {
  request({ operation, args }) {
    const url = buildUrl(operation.endpoint, args);
    const query = (operation.params ?? [])
      .filter((p) => p.source === "query-string" && args[p.name] != null)
      .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(args[p.name])}`)
      .join("&");

    if (operation.method === "GET") return { method: "GET", url: query ? `${url}?${query}` : url };

    // Only declared body fields are sent. Anything else the model invented
    // would be passed straight through to the app's API.
    const allowed = new Set((operation.bodyFields ?? []).map((f) => f.name));
    const body = Object.fromEntries(Object.entries(args).filter(([k, v]) => allowed.has(k) && v !== undefined));
    return { method: operation.method, url, body: Object.keys(body).length ? body : undefined };
  },

  read(payload, { ok, status } = { ok: true }) {
    if (!ok) throw new Error(payload?.error || `Request failed: ${status}`);
    return payload;
  },
};

export const trpc = {
  request({ operation, args }) {
    // URL parameters are not a thing here: every value is input to the
    // procedure. Anything the endpoint template does interpolate has already
    // been substituted, so pass the rest through whole.
    /**
     * The envelope goes on ALWAYS, even with nothing in it.
     *
     * A query with no arguments used to omit `?input=` entirely, so tRPC
     * parsed the input as `undefined` -- and a zod object rejects `undefined`
     * even when every field inside it is optional:
     *
     *     z.object({ scheduleId: z.optional(z.number()) })
     *        .safeParse(undefined)  ->  REJECTED: Required
     *        .safeParse({})         ->  accepted
     *
     * So a procedure that takes nothing mandatory answered "Invalid input" to
     * a call that asked for nothing. Two of cal.diy's availability queries are
     * exactly that shape, and a session spent five tool calls and most of a
     * rate limit discovering it before giving up on the task.
     *
     * The mutation branch below already knew this -- an empty body is not "no
     * arguments" either -- and the lesson simply never crossed the two lines
     * between them. A procedure with no input parser at all ignores what it is
     * sent, so there is nothing to lose by always sending it.
     */
    const input = { json: args ?? {} };

    if (operation.method === "GET") {
      const url = buildUrl(operation.endpoint, args);
      return { method: "GET", url: `${url}?input=${encodeURIComponent(JSON.stringify(input))}` };
    }
    return { method: "POST", url: buildUrl(operation.endpoint, args), body: input };
  },

  /**
   * Unwraps `{ result: { data: { json: X } } }`, and turns
   * `{ error: { json: { message } } }` into a real error.
   *
   * tRPC answers errors with a structured body, so a caller that only checks
   * the HTTP status reports "Request failed: 401" and throws away the reason.
   */
  read(payload, { ok, status } = { ok: true }) {
    if (payload?.error) {
      const detail = payload.error.json ?? payload.error;
      throw new Error(detail?.message ?? "tRPC call failed");
    }
    if (!ok) throw new Error(`Request failed: ${status}`);
    const data = payload?.result?.data;
    return data && "json" in data ? data.json : data;
  },
};

export const TRANSPORTS = { rest, trpc };

/** Which transport an operation uses. Absent means REST, which every manifest
 *  written before tRPC existed relies on. */
export const transportFor = (operation) => TRANSPORTS[operation?.transport] ?? rest;
