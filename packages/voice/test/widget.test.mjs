import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { clickTab, launchBrowser, preparePage, recordTransition, startHarness } from "./harness.mjs";

/**
 * Every case here is a bug this widget actually shipped, and every one of them
 * looked correct in a screenshot. A transparent panel over a white page looks
 * like a white panel; a 350ms overshoot is not visible in a still; a stacking
 * failure inside a shadow root behaves perfectly at mount="inline". So these
 * assert numbers, and they run against the mount that ships.
 */

const TOLERANCE = 2; // px, for spring easing and sub-pixel layout

/** The panel never leaves the interval between where it started and where it ends. */
function assertNoOvershoot(samples, what) {
  const outers = samples.map((s) => s.outer);
  const [start, end] = [outers[0], outers.at(-1)];
  const ceiling = Math.max(start, end) + TOLERANCE;
  const floor = Math.min(start, end) - TOLERANCE;
  assert.ok(
    Math.max(...outers) <= ceiling,
    `${what}: reached ${Math.max(...outers)}px between ${start} and ${end}. The panel balloons and snaps back.`,
  );
  assert.ok(Math.min(...outers) >= floor, `${what}: dropped to ${Math.min(...outers)}px between ${start} and ${end}.`);
}

/**
 * The measured wrapper is never taller than the tallest single pane. If it is,
 * the outgoing pane is still in layout flow and the wrapper is measuring both
 * stacked -- which is popLayout's `position: absolute` rule having been
 * injected into a tree the panes are not in.
 */
function assertPanesNeverStack(samples, what) {
  for (const s of samples) {
    if (!s.panes.length) continue;
    const tallest = Math.max(...s.panes);
    assert.ok(
      s.inner <= tallest + TOLERANCE,
      `${what}: wrapper measured ${s.inner}px against a tallest pane of ${tallest}px (panes ${s.panes}). ` +
        `The outgoing pane never left the flow.`,
    );
  }
}

/** The wrapper measures at its final width, so content cannot rewrap mid-transition. */
function assertWidthStable(samples, what) {
  const widths = [...new Set(samples.map((s) => s.innerWidth))];
  assert.equal(widths.length, 1, `${what}: measured wrapper changed width across ${widths}. Content rewraps as it animates.`);
}

describe("widget", { concurrency: false }, () => {
  let browser;
  let harness;

  before(async () => {
    browser = await launchBrowser();
    harness = await startHarness();
  });

  after(async () => {
    await browser?.close();
    await harness?.server.close();
  });

  async function open(query) {
    const page = await browser.newPage();
    await preparePage(page);
    await page.goto(harness.url(query));
    await page.waitForFunction(() => window.__find?.(".interpreter-widget"));
    return page;
  }

  test("the panel has a real surface, not a transparent one", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const background = await page.evaluate(
      () => getComputedStyle(window.__find(".interpreter-widget > div")).backgroundColor,
    );
    // Semantic tokens map through `@theme inline`. Under a plain `@theme` they
    // resolve against a :root that has no --iv-* to find, every one of them
    // computes to the guaranteed-invalid value, and this reads rgba(0, 0, 0, 0).
    assert.notEqual(background, "rgba(0, 0, 0, 0)", "bg-background resolved to nothing; theme tokens are inert");
    await page.close();
  });

  test("the selected tab is highlighted", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const background = await page.evaluate(
      () => getComputedStyle(window.__find('.interpreter-widget button[aria-label="Talk"]')).backgroundColor,
    );
    // bg-foreground/4 lives in @layer utilities and has to beat our own
    // zero-specificity `button { background: transparent }` reset. It only does
    // while that reset is inside @layer base: unlayered would win regardless.
    assert.notEqual(background, "rgba(0, 0, 0, 0)", "selected tab is transparent; our reset outranks our utilities");
    await page.close();
  });

  test("opening does not overshoot", async () => {
    const page = await open("?mount=shadow");
    const samples = await recordTransition(page, () => clickTab(page, "Talk"));
    assertNoOvershoot(samples, "open");
    assertWidthStable(samples, "open");
    await page.close();
  });

  test("closing does not overshoot", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const samples = await recordTransition(page, () => clickTab(page, "Talk"));
    assertNoOvershoot(samples, "close");
    await page.close();
  });

  test("switching tabs never stacks the panes, in the shadow root", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const samples = await recordTransition(page, () => clickTab(page, "Settings"));
    assertPanesNeverStack(samples, "shadow tab switch");
    assertNoOvershoot(samples, "shadow tab switch");
    await page.close();
  });

  test("switching tabs never stacks the panes, inline", async () => {
    // The other direction of the same bug: popLayout must be pointed at
    // document.head here, not at a shadow root the panes are not in.
    const page = await open("");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const samples = await recordTransition(page, () => clickTab(page, "Settings"));
    assertPanesNeverStack(samples, "inline tab switch");
    assertNoOvershoot(samples, "inline tab switch");
    await page.close();
  });

  test("all chrome shares one overlay host", async () => {
    const page = await open("?mount=shadow&glow=1");
    const hosts = await page.evaluate(() => document.querySelectorAll("[data-interpreter-overlay]").length);
    // Two hosts cannot agree an order in the top layer without re-raising
    // themselves at each other, which is a loop, not a race.
    assert.equal(hosts, 1, "more than one overlay host; the top-layer order is up for grabs again");
    await page.close();
  });

  test("the top layer settles instead of churning", async () => {
    const page = await open("?mount=shadow&glow=1");
    await clickTab(page, "Talk");
    await page.waitForTimeout(1200);
    const toggles = await page.evaluate(() => window.__toggles);
    // The runaway measured ~1800/second. A healthy open is single digits.
    assert.ok(toggles < 20, `${toggles} toggle events with the rim and panel both up; something is re-raising in a loop`);
    await page.close();
  });

  test("an inline panel does not claim the top layer", async () => {
    const page = await open("");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const toggles = await page.evaluate(() => window.__toggles);
    assert.equal(toggles, 0, "an overlay containing nothing raised itself on behalf of an inline panel");
    await page.close();
  });

  test("clicking outside closes the panel", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    await page.click(".page h1");
    await page.waitForTimeout(700);
    const selected = await page.evaluate(() => !!window.__find('.interpreter-widget button[aria-label="Settings"]'));
    assert.equal(selected, false, "panel stayed open after a click outside it");
    await page.close();
  });

  test("pressing inside the panel does not close it", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    // The listener is on document, where target has been retargeted to the
    // shadow host, so this only stays open if the check reads composedPath().
    // `composed: true` is what real UI events carry.
    await page.evaluate(() =>
      window
        .__find(".interpreter-widget form input")
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true })),
    );
    await page.waitForTimeout(700);
    const stillOpen = await page.evaluate(() => !!window.__find('.interpreter-widget button[aria-label="Settings"]'));
    assert.equal(stillOpen, true, "a press inside the panel closed it; click-outside cannot see through the boundary");
    await page.close();
  });
});
