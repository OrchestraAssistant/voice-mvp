import { chromium } from "playwright";
process.env.LD_LIBRARY_PATH = "/workspace/.micromamba/envs/browser/lib:" + (process.env.LD_LIBRARY_PATH ?? "");
process.env.FONTCONFIG_PATH = "/workspace/.micromamba/envs/browser/etc/fonts";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1900, height: 1000 } })).newPage();
await page.goto("https://interpreter.hub.tailnet:3000/auth/login", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.fill('input[name="email"]', "pro@example.com");
await page.fill('input[name="password"]', "pro");
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes("/auth/login"), { timeout: 120000 });
await page.waitForTimeout(10000);

console.log(JSON.stringify(await page.evaluate(() => {
  const aside = document.querySelector("aside");
  const out = { asideClasses: aside ? aside.className : null, display: aside ? getComputedStyle(aside).display : null };

  // Every document-level stylesheet, in order, and whether it defines the two
  // rules that decide this element.
  out.sheets = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { out.sheets.push({ href: sheet.href, blocked: true }); continue; }
    const text = [...rules].map((r) => r.cssText).join("\n");
    out.sheets.push({
      href: sheet.href ? sheet.href.split("/").pop().slice(0, 40) : "<inline>",
      rules: rules.length,
      layerStatement: [...rules].filter((r) => r.constructor.name === "CSSLayerStatementRule").map((r) => r.cssText.slice(0, 90))[0] ?? null,
      definesHidden: /(^|[^-\w])\.hidden\s*\{/.test(text),
      definesLgFlex: text.includes(".lg\\:flex"),
    });
  }
  return out;
}), null, 1));
await browser.close();
