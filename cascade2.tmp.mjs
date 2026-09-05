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
  const hits = [];
  const walk = (rules, sheetName, layer) => {
    for (const r of rules) {
      const kind = r.constructor.name;
      if (kind === "CSSLayerBlockRule") { walk(r.cssRules, sheetName, r.name || "(anonymous)"); continue; }
      if (kind === "CSSMediaRule" || kind === "CSSSupportsRule") { walk(r.cssRules, sheetName, layer); continue; }
      if (kind !== "CSSStyleRule") continue;
      if (/^\.hidden$/.test(r.selectorText) || /^\.md\\:flex$/.test(r.selectorText)) {
        hits.push({
          sheet: sheetName, layer,
          selector: r.selectorText,
          css: r.style.cssText.slice(0, 40),
          media: r.parentRule?.conditionText ?? null,
        });
      }
    }
  };
  [...document.styleSheets].forEach((s, i) => {
    try { walk(s.cssRules, s.href ? s.href.split("/").pop().slice(0, 30) : `inline#${i}`, null); } catch {}
  });
  // What the browser says the layer order is: the first @layer statement wins.
  const statements = [];
  for (const s of document.styleSheets) {
    try { for (const r of s.cssRules) if (r.constructor.name === "CSSLayerStatementRule") statements.push({ sheet: s.href?.split("/").pop().slice(0,30) ?? "inline", text: r.cssText }); } catch {}
  }
  return { hits, layerStatements: statements };
}), null, 1));
await browser.close();
