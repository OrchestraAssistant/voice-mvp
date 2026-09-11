/**
 * Browser / tab orchestration -- the RELIABLE core of the extension.
 *
 * This is the layer to lean on: it is a browser API, so it is deterministic and
 * cannot be defeated by a page's obfuscated DOM. "Open these three things", "go
 * back to the one with the invoice", "close that" -- all of it works without a
 * single fragile click. An embedded widget can never do any of this.
 *
 * Each function is a tool the model calls; they run in the service worker,
 * which is the only world with `chrome.tabs`.
 */

export async function open_tab({ url, active = true }) {
  const tab = await chrome.tabs.create({ url, active });
  return { id: tab.id, url: tab.url ?? url, title: tab.title };
}

export async function close_tab({ id }) {
  await chrome.tabs.remove(id);
  return { closed: id };
}

export async function switch_tab({ id }) {
  const tab = await chrome.tabs.update(id, { active: true });
  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  return { id, url: tab?.url, title: tab?.title };
}

export async function navigate_tab({ id, url }) {
  const tab = await chrome.tabs.update(id, { url });
  return { id, url: tab?.url ?? url };
}

export async function list_tabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return {
    tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
  };
}

/**
 * Vision, WITHOUT the debugger banner.
 *
 * captureVisibleTab is a plain extension API (it needs only the host permission
 * we already hold), so this is how the model gets eyes on the page without ever
 * attaching chrome.debugger -- no "started debugging this browser" infobar. It
 * can only photograph the visible/active tab, which is exactly the one the user
 * is looking at, so that is what "look at the screen" means here. JPEG at
 * quality 55 keeps the data URL (and the vision tokens it becomes) small; a
 * chrome:// page or the store refuses capture and the model gets a clear error.
 *
 * The image is returned under `image` as a data URL; realtimeClient splits that
 * key out and injects it into the conversation as an input_image item.
 */
export async function look_at_screen() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { error: "no visible tab to capture" };
  try {
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
    return { image, of: tab.title || tab.url };
  } catch (err) {
    return { error: `could not capture the screen (${err?.message ?? err}); it may be a browser page` };
  }
}

export const TAB_HANDLERS = { open_tab, close_tab, switch_tab, navigate_tab, list_tabs, look_at_screen };
