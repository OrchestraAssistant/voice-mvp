/**
 * The per-tab worker: the DOM tier and the API/route tier, run IN the page.
 *
 * This is where the extension reuses the package's core wholesale -- the same
 * `domActions`, `transports`, `catalog` and route param-filling the embedded
 * widget uses. The content script is the right home for them because it has the
 * two things the service worker does not: the live DOM, and the user's auth
 * cookies for same-origin API calls.
 *
 * It answers TOOL_CALL messages the service worker forwards, and on load it
 * probes the page for a manifest and reports it up, so the session can bind the
 * high-fidelity tier when the page offers one.
 */
import * as dom from "../../voice/src/domActions.js";
import { transportFor } from "../../voice/src/transports.js";
import { expandTopic } from "../../voice/src/catalog.js";
import { planNavigation } from "../../voice/src/routes.js";
import { KIND } from "./messaging.js";
import { probeManifest } from "./manifestProbe.js";

let manifest = null; // the page's manifest, once probed; null = DOM-only tier

/** Perform an API operation with the page's own cookies. Mirrors the widget's perform(). */
async function perform(operation, args) {
  const transport = transportFor(operation);
  const { method, url, body } = transport.request({ operation, args });
  const res = await fetch(url, {
    method,
    credentials: "include", // the whole reason API calls live here: the user's session
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return transport.read(data, { ok: res.ok, status: res.status });
}

const opByName = (name) =>
  [...(manifest?.queries ?? []), ...(manifest?.actions ?? [])].find((o) => o.name === name);

/** Run one page-scoped tool and return its result. The same tool vocabulary the widget answers. */
async function runTool(name, args = {}) {
  switch (name) {
    case "navigate": {
      const plan = planNavigation(args, manifest?.routes ?? [], location.pathname);
      if (plan.error) return { error: "no route matched", knownRoutes: (manifest?.routes ?? []).map((r) => r.path) };
      if (plan.missing) return { error: `no value for ${plan.missing.join(", ")} -- resolve it or do it on screen`, needs: plan.missing };
      // TODO(spa): location.assign is a full navigation. For an in-app SPA route
      // change, dispatch to the page's router from the MAIN world instead.
      location.assign(plan.path);
      const here = (manifest?.routes ?? []).find((r) => r.path === location.pathname || dom.onPage(r.path, location.pathname));
      return { status: "navigated", path: location.pathname, context: { ...(here?.description ? { page: here.description } : {}), ...dom.pageContext() } };
    }
    case "dom_snapshot":
      return { elements: dom.snapshot() };
    case "dom_click":
      return dom.click(args.elementId), { status: "clicked" };
    case "dom_type":
      return dom.typeText(args.elementId, args.text), { status: "typed" };
    case "expand":
      return manifest ? (expandTopic(manifest, args.topic) ?? { error: "no such topic" }) : { error: "this page serves no manifest" };
    case "run_query":
    case "run_action": {
      const op = opByName(args.name);
      if (!op) return { error: `no operation named ${args.name}` };
      try {
        return { result: await perform(op, args.args ?? args.items ?? {}) };
      } catch (err) {
        return { error: err.message };
      }
    }
    default:
      return { error: `content script cannot run tool: ${name}` };
  }
}

// The service worker forwards page-scoped tool calls here.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.kind === KIND.TOOL_CALL) {
    runTool(msg.name, msg.args).then(reply, (err) => reply({ error: String(err?.message ?? err) }));
    return true; // async reply
  }
  if (msg?.kind === KIND.PROBE) {
    reply({ kind: KIND.MANIFEST, manifest });
    return false;
  }
});

// On load: probe the page and report whether it lights up the manifest tier.
probeManifest().then((m) => {
  manifest = m;
  chrome.runtime.sendMessage({ kind: KIND.MANIFEST, manifest: m, url: location.href });
});
