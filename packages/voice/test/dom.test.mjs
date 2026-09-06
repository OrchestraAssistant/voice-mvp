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

/**
 * Flows: several interactions that together do one thing.
 *
 * Some of what an app can do has no URL and no endpoint. Creating an event
 * type in cal.diy opens a dialog with four fields, and the address bar never
 * changes. The agent could reach it only by snapshotting, guessing which
 * element was which, and clicking around -- which is how it typed a
 * description into a URL field.
 */
describe("running a flow", { concurrency: false }, () => {
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

  async function fresh() {
    const page = await browser.newPage();
    await page.goto(harness.url("?mount=shadow"));
    await page.addScriptTag({ content: `${source}\nwindow.__dom = { snapshot, typeText, click, runFlow };`, type: "module" });
    await page.waitForFunction(() => window.__dom);
    return page;
  }
  const run = (page, steps, args) =>
    page.evaluate(([s, a]) => window.__dom.runFlow(s, a, { timeoutMs: 2000 }), [steps, args]);

  test("named inputs land in labelled fields", async () => {
    const page = await fresh();
    const result = await run(page, [{ type: "Title", from: "title" }, { type: "Description", from: "description" }],
      { title: "Quick chat", description: "A short one." });

    assert.equal(result.status, "completed");
    assert.equal(await page.inputValue("#host-title"), "Quick chat");
    assert.equal(await page.evaluate(() => document.getElementById("host-editor").innerText.trim()), "A short one.");
    await page.close();
  });

  test("a field with no value is skipped, which is what makes it optional", async () => {
    // The model omits `description` and the flow simply does not visit it,
    // rather than typing "undefined" into the page.
    const page = await fresh();
    const result = await run(page, [{ type: "Title", from: "title" }, { type: "Description", from: "description" }],
      { title: "Only a title" });

    assert.equal(result.status, "completed");
    assert.match(result.steps[1].skipped, /no value for description/);
    assert.equal(await page.evaluate(() => document.getElementById("host-editor").innerText.trim()), "");
    await page.close();
  });

  test("it waits for what a click opens", async () => {
    // Clicking "New" opens a dialog, and the dialog is not there on the next
    // line of JavaScript. Without waiting, every flow whose first step opens
    // something fails on its second.
    const page = await fresh();
    const result = await run(page, [{ click: "Add detail" }, { type: "Notes", from: "notes" }], { notes: "later" });

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(await page.inputValue("#host-notes"), "later");
    await page.close();
  });

  test("stopping partway says where it got to, not just that it failed", async () => {
    // A flow that filled one field and could not find the next has left a
    // half-completed form on screen. "It failed" invites the model to start
    // again from the top, which fills the first field twice.
    const page = await fresh();
    const result = await run(page, [{ type: "Title", from: "title" }, { click: "Nonexistent Button" }], { title: "Half" });

    assert.equal(result.status, "stopped");
    assert.match(result.at, /step 2 of 2/);
    assert.match(result.because, /could not find "Nonexistent Button"/);
    assert.deepEqual(result.completed[0], { step: 1, typed: "Title" });
    assert.match(result.hint, /rather than starting over/);
    assert.equal(await page.inputValue("#host-title"), "Half", "the partial state is real, and stays");
    await page.close();
  });

  test("a shorter label wins over a longer one containing it", async () => {
    // "Title" must not match "Title of the recurring event" when both exist.
    const page = await fresh();
    await page.evaluate(() => {
      const extra = document.createElement("label");
      extra.textContent = "Title of the recurring event";
      const input = document.createElement("input");
      input.id = "host-decoy";
      extra.setAttribute("for", "host-decoy");
      document.getElementById("host-form").append(extra, input);
    });
    await run(page, [{ type: "Title", from: "title" }], { title: "right one" });
    assert.equal(await page.inputValue("#host-title"), "right one");
    assert.equal(await page.inputValue("#host-decoy"), "");
    await page.close();
  });
});
