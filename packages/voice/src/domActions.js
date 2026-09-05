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

function labelFor(el) {
  const labelledBy = el.getAttribute("aria-label");
  if (labelledBy) return labelledBy;
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.innerText.trim();
  }
  if (el.placeholder) return el.placeholder;
  const text = el.innerText?.trim();
  if (text) return text.slice(0, 80);
  return el.getAttribute("title") || null;
}

export function snapshot() {
  registry.clear();
  const selector = 'button, a[href], input, select, textarea, [role="button"]';
  const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible);
  return elements.map((el) => {
    const id = `el-${idCounter++}`;
    registry.set(id, el);
    return {
      id,
      tag: el.tagName.toLowerCase(),
      inputType: el.type || undefined,
      label: labelFor(el),
      value: "value" in el ? el.value : undefined,
      checked: el.checked ?? undefined,
    };
  });
}

function resolve(elementId) {
  const el = registry.get(elementId);
  if (!el) throw new Error(`Unknown or stale element id: ${elementId}. Call dom_snapshot again.`);
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
  const setter = nativeValueSetter(el.tagName);
  if (setter) {
    setter.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
