// Tier-1 runtime fallback: perceive and act on whatever's actually
// rendered right now, for anything the static manifest doesn't cover.

let idCounter = 0;
const registry = new Map();

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

/** A rich-text editor: contenteditable, but not an input or textarea. */
function isRichText(el) {
  return el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA";
}

function labelFor(el) {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText?.trim())
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }

  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.innerText.trim();
  }
  // Rich-text editors carry their placeholder in a data attribute, because the
  // real one only exists on inputs.
  const placeholder = el.placeholder || el.getAttribute("data-placeholder");
  if (placeholder) return placeholder;

  const wrapping = el.closest("label");
  if (wrapping) {
    const text = wrapping.innerText?.trim();
    if (text) return text.slice(0, 80);
  }

  // An editor's own text is its CONTENT, not its name, and using it as a label
  // means a field renamed itself every time someone typed. cal.diy's
  // description editor has no aria-label and no label element, so the visible
  // heading above it is the only thing that names it.
  if (isRichText(el)) return headingAbove(el);

  const text = el.innerText?.trim();
  if (text) return text.slice(0, 80);
  return el.getAttribute("title") || null;
}

/** The nearest short piece of text rendered directly above an element. */
function headingAbove(el) {
  let node = el;
  for (let hops = 0; hops < 4 && node; hops++) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      const text = sibling.innerText?.trim();
      // Short enough to be a name rather than a paragraph.
      if (text && text.length <= 40) return text;
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * What the agent can see.
 *
 * The contenteditable entries are not decoration. Asked to fill in a
 * description, the agent found Title, URL and Duration in this list, no
 * description field at all, and typed the description into the URL. The field
 * was a `<div contenteditable role="textbox">` -- a rich-text editor, which is
 * how most apps render a description -- and it matched none of the tags here.
 *
 * `contenteditable="false"` is excluded deliberately: it marks a region as NOT
 * editable inside one that is.
 */
const SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(", ");

export function snapshot() {
  registry.clear();
  const elements = Array.from(document.querySelectorAll(SELECTOR)).filter(isVisible);
  return elements.map((el) => {
    const id = `el-${idCounter++}`;
    registry.set(id, el);
    const rich = isRichText(el);
    return {
      id,
      tag: el.tagName.toLowerCase(),
      // The role is what tells a div holding text apart from a div you press,
      // now that both can appear here.
      role: el.getAttribute("role") || (rich ? "textbox" : undefined),
      inputType: el.type || undefined,
      editable: rich || undefined,
      label: labelFor(el),
      value: rich ? el.innerText?.trim().slice(0, 200) : "value" in el ? el.value : undefined,
      checked: el.checked ?? undefined,
    };
  });
}

function resolve(elementId) {
  const el = registry.get(elementId);
  if (!el) throw new Error(`Unknown or stale element id: ${elementId}. Call dom_snapshot again.`);
  // An element captured before a re-render is still a perfectly good object
  // that is no longer in the page. Clicking it does nothing, silently, and
  // reports success -- which reads to the user as the agent ignoring them.
  // React replaces nodes on almost every state change, so this is the common
  // case after any action, not an edge one.
  if (!el.isConnected) {
    throw new Error(`Element ${elementId} is no longer on the page; it was replaced after the last snapshot. Call dom_snapshot again.`);
  }
  return el;
}

export function click(elementId) {
  const el = resolve(elementId);
  el.scrollIntoView({ block: "center" });
  el.click();
}

/**
 * React installs its own `value` setter on the element, so assigning
 * `el.value` updates the DOM without the component ever hearing about it. The
 * prototype's original setter is the one React's onChange listens behind.
 *
 * Read on first use rather than at module scope. At module scope this touched
 * `window` the instant the bundle was evaluated, which made the whole package
 * unimportable anywhere there is no DOM -- it threw "window is not defined"
 * during a server render before a single component was used. Found by
 * installing the built tarball into a Next.js app, which is the only place
 * that could have found it: every test we had runs in a browser or imports
 * the source directly.
 */
let nativeValueSetters = null;
function nativeValueSetter(tagName) {
  nativeValueSetters ??= {
    INPUT: Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set,
    TEXTAREA: Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set,
  };
  return nativeValueSetters[tagName];
}

export function typeText(elementId, text) {
  const el = resolve(elementId);
  el.focus();

  /**
   * A rich-text editor has no `value` to set. Its content is DOM, and the
   * editor keeps its own model of that DOM -- Lexical, ProseMirror and Quill
   * all do -- so assigning textContent changes what is on screen and leaves
   * the model behind it untouched, which the next keystroke overwrites.
   *
   * They all listen for beforeinput/input instead, which is what
   * execCommand("insertText") produces. Deprecated, and still the only
   * instruction every one of them understands.
   */
  if (isRichText(el)) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    if (!document.execCommand("insertText", false, text)) {
      // Last resort. Visibly correct, and possibly not what the editor thinks.
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  const setter = nativeValueSetter(el.tagName);
  if (setter) {
    setter.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
