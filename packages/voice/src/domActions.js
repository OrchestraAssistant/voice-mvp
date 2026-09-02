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

const NATIVE_VALUE_SETTERS = {
  INPUT: Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set,
  TEXTAREA: Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set,
};

export function typeText(elementId, text) {
  const el = resolve(elementId);
  el.focus();
  const setter = NATIVE_VALUE_SETTERS[el.tagName];
  if (setter) {
    setter.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
