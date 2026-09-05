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

console.log(await page.evaluate(() => {
  const nav = [...document.querySelectorAll("nav,aside,header")].map((n) => ({
    tag: n.tagName,
    cls: String(n.className).slice(0, 90),
    display: getComputedStyle(n).display,
    w: Math.round(n.getBoundingClientRect().width),
  }));
  return {
    innerWidth: innerWidth,
    documentWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    lgMatches: matchMedia("(min-width: 1024px)").matches,
    navs: nav,
  };
}));
await page.screenshot({ path: "/tmp/claude-1000/-workspace/4a06678d-149e-4fe4-9f09-dd6f76811f80/scratchpad/wide.png" });
await browser.close();
