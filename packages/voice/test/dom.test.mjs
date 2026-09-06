import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, startHarness } from "./harness.mjs";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/domActions.js"), "utf8");

/**
 * The DOM tools are what carries the product on an app whose data layer we
 * cannot read, and every case here is a failure observed on a real one.
 */
describe("what the agent can see and touch", { concurrency: false }, () => {
  let browser;
  let harness;
  let page;

  before(async () => {
    browser = await launchBrowser();
    harness = await startHarness();
    page = await browser.newPage();
    await page.goto(harness.url("?mount=shadow"));
    await page.addScriptTag({ content: `${source}\nwindow.__dom = { snapshot, typeText, click };`, type: "module" });
    await page.waitForFunction(() => window.__dom);
  });
  after(async () => {
    await browser?.close();
    await harness?.server.close();
  });

  const field = (label) =>
    page.evaluate((wanted) => window.__dom.snapshot().find((e) => e.label === wanted), label);

  test("a rich-text editor is visible at all", async () => {
    // It is a <div contenteditable role="textbox">, which matched none of the
    // tags collected before. Asked to fill in a description on cal.diy, the
    // agent saw Title, URL and Duration, no description, and typed the
    // description into the URL.
    const editor = await field("Description");
    assert.ok(editor, "the editor is still invisible to dom_snapshot");
    assert.equal(editor.role, "textbox");
    assert.equal(editor.editable, true, "nothing distinguishes it from a div you press");
  });

  test("it is named by the heading above it", async () => {
    // It has no aria-label, no <label for>, and no placeholder attribute. The
    // visible heading is the only thing that names it.
    assert.equal((await field("Description")).label, "Description");
  });

  test("its own text is reported as content, never as its name", async () => {
    // Using innerText as the label meant the field renamed itself the moment
    // anyone typed into it.
    const editor = await field("Description");
    await page.evaluate((id) => window.__dom.typeText(id, "A quick video meeting."), editor.id);
    const after = await field("Description");
    assert.equal(after.label, "Description", "the label followed the content");
    assert.equal(after.value, "A quick video meeting.");
  });

  test("typing reaches it through events, not by assignment", async () => {
    // A rich-text editor keeps its own model of its DOM, so assigning
    // textContent changes the screen and leaves the model behind it, which the
    // next keystroke overwrites. execCommand("insertText") is the instruction
    // every editor understands.
    assert.match(source, /execCommand\("insertText"/);
    const editor = await field("Description");
    const events = await page.evaluate((id) => {
      const el = document.getElementById("host-editor");
      const seen = [];
      for (const type of ["beforeinput", "input", "change"]) el.addEventListener(type, () => seen.push(type));
      window.__dom.typeText(id, "hello");
      return seen;
    }, editor.id);
    assert.ok(events.includes("input"), `an editor listening for input heard nothing (${events})`);
  });

  test("an ordinary input still works the old way", async () => {
    const title = await field("Title");
    await page.evaluate((id) => window.__dom.typeText(id, "Quick chat"), title.id);
    assert.equal(await page.inputValue("#host-title"), "Quick chat");
  });

  test("an element that left the page says so instead of doing nothing", async () => {
    // React replaces nodes on almost every state change, so an id captured
    // before an action is routinely detached after it. Clicking a detached
    // node does nothing, silently, and reports success -- which reads to the
    // user as the agent ignoring them.
    const failure = await page.evaluate(() => {
      const snapshot = window.__dom.snapshot();
      const target = snapshot.find((e) => e.label === "Title");
      document.getElementById("host-title").remove();
      try {
        window.__dom.click(target.id);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    assert.ok(failure, "clicking a detached element reported success");
    assert.match(failure, /no longer on the page/);
    assert.match(failure, /dom_snapshot again/, "the message has to say what to do next");
  });
});
