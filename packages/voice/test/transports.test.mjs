import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl, rest, transportFor, trpc } from "../src/transports.js";

/**
 * The wire format is the part that is easy to get subtly wrong and impossible
 * to check by eye. Every expectation here was confirmed against a running
 * cal.diy before it was written down.
 */
describe("REST", () => {
  const query = { method: "GET", endpoint: "/api/tasks", params: [{ name: "search", source: "query-string" }] };

  test("query-string parameters are appended, url ones substituted", () => {
    assert.equal(rest.request({ operation: query, args: { search: "yoga" } }).url, "/api/tasks?search=yoga");
    assert.equal(buildUrl("/api/tasks/{id}", { id: 7 }), "/api/tasks/7");
  });

  test("only declared body fields are sent", () => {
    // Anything else the model invented would be forwarded straight into the
    // app's own API.
    const action = { method: "PUT", endpoint: "/api/tasks/{id}", bodyFields: [{ name: "done" }], params: [] };
    const { body } = rest.request({ operation: action, args: { id: 3, done: true, sneaky: "x" } });
    assert.deepEqual(body, { done: true });
  });

  test("a failure keeps the server's message when there is one", () => {
    assert.throws(() => rest.read({ error: "Task not found" }, { ok: false, status: 404 }), /Task not found/);
    assert.throws(() => rest.read(null, { ok: false, status: 500 }), /Request failed: 500/);
  });
});

describe("tRPC", () => {
  const list = { method: "GET", endpoint: "/api/trpc/availability/list", transport: "trpc" };
  const update = { method: "POST", endpoint: "/api/trpc/availability/schedule.update", transport: "trpc" };

  test("a query carries superjson-wrapped input in the query string", () => {
    // Verified against the running app: this exact shape returns a structured
    // tRPC reply, while a plain REST call returns an HTML page.
    const { method, url } = trpc.request({ operation: list, args: { username: "pro" } });
    assert.equal(method, "GET");
    const input = JSON.parse(decodeURIComponent(url.split("input=")[1]));
    assert.deepEqual(input, { json: { username: "pro" } });
  });

  test("a query with no arguments still sends an empty envelope", () => {
    // It used to omit `?input=` entirely, so tRPC parsed the input as
    // `undefined` -- and a zod object rejects `undefined` even when every
    // field in it is optional. Two of cal.diy's availability queries take
    // nothing mandatory and answered "Invalid input" to a call that asked for
    // nothing, and a session burned five tool calls finding that out.
    const { url } = trpc.request({ operation: list, args: {} });
    const input = JSON.parse(decodeURIComponent(url.split("input=")[1]));
    assert.deepEqual(input, { json: {} });
  });

  test("a mutation puts the envelope in the body", () => {
    const { method, url, body } = trpc.request({ operation: update, args: { id: 4, name: "Weekdays" } });
    assert.equal(method, "POST");
    assert.equal(url, "/api/trpc/availability/schedule.update");
    assert.deepEqual(body, { json: { id: 4, name: "Weekdays" } });
  });

  test("a mutation with no arguments sends an empty object, not a null", () => {
    // Same reason as the query above, and `null` is not better than
    // `undefined` here: `z.object({...}).safeParse(null)` is rejected too. An
    // empty object is the one value an all-optional schema accepts.
    assert.deepEqual(trpc.request({ operation: update, args: {} }).body, { json: {} });
  });

  test("the reply is unwrapped out of result.data.json", () => {
    assert.deepEqual(trpc.read({ result: { data: { json: [{ id: 1 }] } } }, { ok: true }), [{ id: 1 }]);
  });

  test("an error keeps the reason, which the HTTP status alone throws away", () => {
    // Observed: { error: { json: { message: "UNAUTHORIZED", ... } } } with a
    // 401. Reporting "Request failed: 401" discards the half that explains it.
    assert.throws(
      () => trpc.read({ error: { json: { message: "UNAUTHORIZED" } } }, { ok: false, status: 401 }),
      /UNAUTHORIZED/,
    );
  });

  test("a transport-shaped failure with no body still fails", () => {
    assert.throws(() => trpc.read(null, { ok: false, status: 500 }), /Request failed: 500/);
  });
});

describe("choosing one", () => {
  test("no transport means REST, which every older manifest relies on", () => {
    assert.equal(transportFor({ endpoint: "/api/tasks" }), rest);
    assert.equal(transportFor(undefined), rest);
  });

  test("and a declared one is used", () => {
    assert.equal(transportFor({ transport: "trpc" }), trpc);
  });
});
