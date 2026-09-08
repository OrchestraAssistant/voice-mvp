/**
 * Which routes need a `readyWhen`, and what it should be.
 *
 * The problem it solves, from a real session: the agent navigated to the right
 * schedule, snapshotted 420ms later, saw the app shell, concluded the
 * availability editor "was not on this screen", and left the one page that
 * could have done the job. The switches were not hidden. They did not exist
 * yet.
 *
 * `readyWhen` fixes that by naming an element that appears only once the real
 * content has. The question is where the name comes from, and it cannot come
 * from reading the source. In cal.diy, 0 of 79 page files contain a loading
 * state at all -- the pages are thin and the loading sits several imports away
 * -- and the marker I picked by hand, `Sunday-switch`, does not exist in the
 * source: it is written `data-testid={\`\${weekday}-switch\`}`, so deriving it
 * means evaluating a map over a weekday array rather than parsing anything.
 * 124 of cal's test ids are built from expressions like that.
 *
 * So this measures instead. Open the route, sample what exists every so often,
 * and look for an element that arrives late and stays. That is a measurement,
 * not a judgement, which is why it is a probe and not an agent: there is
 * nothing here to decide.
 *
 * Two properties come from having visited every route rather than one:
 *
 *   - the SHELL is the intersection. Elements on every page -- the sidebar,
 *     the user menu -- are useless as a readiness marker precisely because
 *     they are always there, and you can only know which those are by
 *     comparing pages.
 *   - a route whose inventory never grows needs no marker at all, so the
 *     output is a short list rather than one entry per route.
 */
import { execFileSync } from "node:child_process";

import { validateDriver } from "../../browsers/contract.js";
import { instancesFor, isPattern } from "../../core/routes.js";
import { generalize, testIdShapes } from "../../core/testidShapes.js";
import { repoRoot } from "../../core/parse.js";

/** Three seconds of watching, in twelve looks. Overridable so tests need not wait. */
const SAMPLES = 12;
const EVERY_MS = 250;

/** How an element would be named in a manifest, or null if it cannot be. */
function nameFor(el) {
  if (el.testId) return { testId: el.testId };
  if (el.domId) return { domId: el.domId };
  return null;
}

const keyOf = (el) => JSON.stringify(nameFor(el));

/**
 * How specific to ONE page a candidate marker is, measured against the source.
 *
 * A good readiness signal is a piece of THIS page's content. A bad one is a
 * gear icon or a hidden dialog that a shared component drops onto dozens of
 * pages -- exactly what the probe proposed on its own: `settings-icon`,
 * `dialog-creation`, `dialog-rejection`. Those are indistinguishable from
 * content by timing alone, since they mount late too.
 *
 * The source tells them apart cheaply. A `data-testid` written literally in
 * one or two files is page content; one written in a widely-reused component,
 * or referenced from a dozen files, is chrome. The count is the signal, and it
 * is the mechanical version of "does this look page-specific" -- no judgement,
 * just grep.
 *
 * Returns a count of files the literal appears in, or `null` when it cannot be
 * found at all (interpolated at runtime, e.g. `${weekday}-switch`, which the
 * probe sees as `Sunday-switch`). Null is NOT the same as chrome: it means the
 * literal is not knowable statically, which is a separate question the caller
 * decides on.
 */
function sourceSpread(literal, root) {
  if (!literal || !root) return null;
  try {
    const out = execFileSync(
      "grep",
      ["-rlF", "--include=*.tsx", "--include=*.jsx", "--include=*.ts", "--include=*.js",
       "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=dist", `"${literal}"`, root],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 << 20 },
    );
    const files = out.split("\n").filter(Boolean).length;
    return files || null;
  } catch {
    // grep exits non-zero when nothing matches; that is "not found", not error.
    return null;
  }
}

export const readiness = {
  name: "readiness",
  role: "probe",
  describe: "which routes render late, and what to wait for",
  needsBrowser: true,

  async run({ manifest, browser, baseUrl, cookies = [], headers = {}, srcRoot = null, samples = SAMPLES, everyMs = EVERY_MS }) {
    if (!browser) {
      return { notes: ["no browser driver was provided; run with --browser"] };
    }
    const wrong = validateDriver(browser);
    if (wrong.length) return { problems: [`browser driver: ${wrong.join(", ")}`] };

    const ready = await browser.available();
    if (!ready.ok) return { notes: [`skipped: ${ready.why}`] };

    /**
     * Two passes, because a route with a parameter cannot be visited until
     * something supplies a value, and inventing one probes a 404.
     *
     * The first pass takes the routes that need nothing, and collects every
     * same-origin link it sees on the way. The app links to its own instances
     * -- cal.diy's availability list renders `/availability/${schedule.id}` for
     * each row -- so the second pass gets real, valid URLs handed to it by the
     * app rather than guessed from a query result or written by hand.
     *
     * Reporting the ones nothing links to is a small bonus: a page the app
     * never points at, which the agent has nonetheless been told exists.
     */
    const all = manifest.routes ?? [];
    const plain = all.filter((r) => !isPattern(r.path));
    const patterned = all.filter((r) => isPattern(r.path));
    const seen = new Map(); // route -> { early:Set, late:Map, final:Set }
    const problems = [];
    const notes = [];
    const links = new Set();

    /** Watch one URL, and record what it did under the route it belongs to. */
    const watch = async (label, url) => {
      let page;
      try {
        page = await browser.open(new URL(url, baseUrl).toString(), { cookies, headers });
      } catch (err) {
        problems.push(`${label}: could not open (${err.message})`);
        return;
      }
      // Where we ACTUALLY are. A route that redirects has not been measured,
      // and recording a marker against the path we asked for would teach the
      // agent to wait for an element of the login page on every protected one.
      const landed = page.url();
      if (!landed.includes(url)) {
        await page.close();
        notes.push(`${label}: redirected to ${landed}, not measured`);
        return;
      }

      // How many of the samples each nameable element appeared in, and which
      // were present at the end. NOT "which arrived late" -- that was the
      // original mistake. A marker's job is to be present WHEN the page is
      // ready, and content that renders immediately (cal.diy's day switches
      // are there by 300ms) satisfies that at once. Ranking then picks the
      // page-SPECIFIC one; whether it was early or late says nothing about
      // whether it is content or chrome, where specificity says everything.
      const times = new Map();
      let final = new Set();
      for (let i = 0; i < samples; i++) {
        const inventory = await page.inventory();
        const now = new Set();
        for (const el of inventory) {
          // Harvested on every page, for the second pass below.
          if (el.href) links.add(el.href);
          const key = keyOf(el);
          if (key === "null") continue; // nothing stable to name it by
          now.add(key);
          times.set(key, (times.get(key) ?? 0) + 1);
        }
        final = now;
        if (i < samples - 1) await new Promise((r) => setTimeout(r, everyMs));
      }

      // Checked again at the END, not only at the start. Cal.diy's redirect to
      // its login page happens after DOMContentLoaded, so the first check still
      // saw the requested path and the route was measured as though it had
      // rendered -- when what it rendered was somebody else's page.
      const ended = page.url();
      await page.close();
      if (!ended.includes(url)) {
        notes.push(`${label}: redirected to ${ended} while loading, not measured`);
        return;
      }
      seen.set(label, { times, final });
    };

    try {
      for (const route of plain) await watch(route.path, route.path);

      // Second pass: the app has now told us where its own instances are.
      const instances = instancesFor(patterned.map((r) => r.path), links, {
        reserved: plain.map((r) => r.path),
      });
      for (const route of patterned) {
        const instance = instances.get(route.path);
        if (!instance) {
          notes.push(`${route.path}: nothing links to an instance of it, so it was not measured`);
          continue;
        }
        notes.push(`${route.path}: measured as ${instance}`);
        await watch(route.path, instance);
      }
    } finally {
      await browser.close();
    }

    const measured = seen.size || 1;
    // Harvest from the MONOREPO root, not the one workspace we generated from.
    // cal.diy's `${weekday}-switch` lives in packages/features, outside apps/web,
    // so scoping the grep to apps/web found no `*-switch` shape and left the
    // marker as the day-specific, locale-bound `Sunday-switch`. The repo root
    // sees every package; source spread below uses it for the same reason.
    const scanRoot = srcRoot ? repoRoot(srcRoot) : srcRoot;
    // The test-id templates in the source, harvested once, so a measured id
    // can be traded for the shape it was built from. Empty when there is no
    // source to read, which just leaves every marker as its literal.
    const shapes = testIdShapes(scanRoot);

    /**
     * How many measured routes each marker ends up on. This is the whole of
     * specificity: a readiness signal is a piece of ONE page's content, so a
     * marker that shows up on many pages is furniture no matter how late it
     * arrives. The first version only caught markers present on 60% of routes,
     * which let `dialog-creation` -- shared across seven /settings pages, 23%
     * -- through as the answer for all seven.
     */
    const across = new Map();
    for (const { final } of seen.values()) {
      for (const key of final) across.set(key, (across.get(key) ?? 0) + 1);
    }
    // Definite furniture: present, at the end, on most routes.
    const shell = new Set([...across.entries()].filter(([, n]) => n > 1 && n >= measured * 0.6).map(([key]) => key));

    // A marker has to be present through most of the watch, or it is a
    // flicker and worse than nothing. It need not be LATE -- fast content is
    // still a fine "ready" signal, it simply makes navigate return at once.
    const isStable = (count) => count >= samples - 2;
    const specificEnough = Math.max(2, Math.ceil(measured * 0.25));
    // A testId in more files than this is a shared component's, not a page's,
    // whatever the crawl saw -- `new_webhook` turned up in 124 files.
    const CHROME_FILES = 20;
    // Markers that describe a page's ABSENCE, not its readiness. `404-page` is
    // the not-found template: proposing it says "wait for this route to fail",
    // which is a reachability finding wearing the wrong hat.
    const NOT_READINESS = new Set(["404-page", "error-page", "maintenance"]);

    const corrections = { routes: [], queries: [], actions: [] };
    for (const [path, { times }] of seen) {
      const candidates = [...times.entries()]
        .filter(([key, count]) => isStable(count) && !shell.has(key))
        .map(([key]) => ({ want: JSON.parse(key), onRoutes: across.get(key) ?? 1 }))
        .filter((c) => !NOT_READINESS.has(c.want.testId));
      if (!candidates.length) {
        if (times.size) notes.push(`${path}: nothing stable and page-specific to wait for`);
        continue;
      }

      /**
       * Rank by specificity, source breaking ties.
       *
       * `onRoutes` first: the marker on the fewest OTHER pages is the most
       * page-specific, which is exactly what a readiness signal should be, and
       * is why the sidebar and the settings sub-nav lose. `sourceSpread`
       * refines it -- a testId in one file beats one in twenty, so `Sunday`
       * from the schedule component beats a shared icon even when both happen
       * to be rare in this crawl.
       *
       * A literal found NOWHERE in source (null) sits mid-pack rather than
       * being penalised: it is almost certainly interpolated -- the schedule's
       * `${weekday}-switch` reaches the page as `Sunday-switch` -- and a
       * runtime-built id on one route is a perfectly good marker the crawl
       * just cannot confirm from source.
       */
      for (const c of candidates) {
        c.spread = sourceSpread(c.want.testId ?? c.want.domId, scanRoot);
      }
      const specific = candidates
        .filter((c) => c.onRoutes <= specificEnough && (c.spread ?? 0) <= CHROME_FILES)
        .sort((a, b) => a.onRoutes - b.onRoutes || (a.spread ?? 4) - (b.spread ?? 4));

      if (!specific.length) {
        const best = candidates.sort((a, b) => a.onRoutes - b.onRoutes)[0];
        notes.push(
          `${path}: only shared chrome is stable (best was ${JSON.stringify(best.want)} on ${best.onRoutes} routes` +
            `${best.spread ? `, in ${best.spread} files` : ""}), nothing page-specific to wait for`,
        );
        continue;
      }
      const best = specific[0];

      /**
       * Store the SHAPE, not the sample, when the id was built from a
       * template. The probe can only measure `Sunday-switch`; the source holds
       * `${weekday}-switch`. Writing the literal would key the wait to one
       * locale and one row of data, so the day the app renders in Spanish, or
       * the first schedule differs, the marker never appears. `generalize`
       * swaps in `*-switch` when a source template produced it, and leaves a
       * genuinely literal id alone.
       */
      const readyWhen = { ...best.want };
      if (readyWhen.testId) {
        const shape = generalize(readyWhen.testId, shapes);
        if (shape !== readyWhen.testId) {
          notes.push(`${path}: ${JSON.stringify(readyWhen.testId)} is one of a template ${JSON.stringify(shape)}; storing the shape`);
          readyWhen.testId = shape;
        }
      }
      corrections.routes.push({ path, readyWhen });
      notes.push(
        `${path}: wait for ${JSON.stringify(readyWhen)}` +
          (best.spread ? ` (in ${best.spread} source file${best.spread > 1 ? "s" : ""})` : " (runtime-generated)"),
      );
    }

    notes.unshift(
      `${seen.size} of ${all.length} routes watched with ${ready.using ?? browser.name}; ` +
        `${corrections.routes.length} got a page-specific signal`,
    );
    // Telling which elements are page-specific means comparing pages. Say so
    // rather than quietly returning a weaker answer.
    if (measured < 3) {
      notes.push(`only ${measured} route(s) measured, so page furniture could not be told from page content`);
    }
    return { problems, notes, corrections };
  },
};
