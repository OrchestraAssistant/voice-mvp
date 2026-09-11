/**
 * The per-tab DOM/API bridge for the PERSISTENT-session build.
 *
 * The session lives in the offscreen document (it survives page navigations);
 * this content script is the limb that runs in each page, executing the DOM and
 * API tools the session routes to it and reporting the page's manifest. It is
 * re-created on every page load -- which is fine, because it holds no session
 * state; it just reconnects to the one that is already running.
 *
 * Headless for now (no visible rim): this build exists to prove the session
 * persists across reloads. The rim is ported on next, re-mounted per page and
 * driven by the offscreen session's state over messages.
 */
import * as dom from "../../voice/src/domActions.js";
import { transportFor } from "../../voice/src/transports.js";
import { expandTopic } from "../../voice/src/catalog.js";
import { planNavigation } from "../../voice/src/routes.js";
import { KIND } from "./messaging.js";
import { probeManifest } from "./manifestProbe.js";

let manifest = null;

async function perform(operation, args) {
  const transport = transportFor(operation);
  const { method, url, body } = transport.request({ operation, args });
  const res = await fetch(url, {
    method,
    credentials: "include", // the user's own session
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

const opByName = (name) => [...(manifest?.queries ?? []), ...(manifest?.actions ?? [])].find((o) => o.name === name);

async function runTool(name, args = {}) {
  switch (name) {
    case "navigate": {
      const plan = planNavigation(args, manifest?.routes ?? [], location.pathname);
      if (plan.error) return { error: "no route matched", knownRoutes: (manifest?.routes ?? []).map((r) => r.path) };
      if (plan.missing) return { error: `no value for ${plan.missing.join(", ")} -- resolve it or do it on screen`, needs: plan.missing };
      location.assign(plan.path);
      return { status: "navigated", path: plan.path, context: dom.pageContext() };
    }
    case "dom_snapshot":
      return { elements: dom.snapshot() };
    case "dom_click":
      dom.click(args.elementId);
      return { status: "clicked" };
    case "dom_type":
      dom.typeText(args.elementId, args.text);
      return { status: "typed" };
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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.kind === KIND.TOOL_CALL) {
    runTool(msg.name, msg.args).then(reply, (err) => reply({ error: String(err?.message ?? err) }));
    return true;
  }
  if (msg?.kind === KIND.PROBE) {
    reply({ kind: KIND.MANIFEST, manifest });
    return false;
  }
});

probeManifest().then((m) => {
  manifest = m;
  chrome.runtime.sendMessage({ kind: KIND.MANIFEST, manifest: m, url: location.href }).catch(() => {});
});
