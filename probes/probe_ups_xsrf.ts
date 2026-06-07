import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromium.use(StealthPlugin());

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.goto(`https://www.ups.com/track?tracknum=1ZW5244V6870200569&loc=en_US`, {
  waitUntil: "load",
});
await page.waitForSelector("body");
// Give the page time to do its initial calls + token fetch
await page.waitForResponse(
  (r) => /Track\/GetStatus/i.test(r.url()),
  { timeout: 25000 },
).catch(() => {});

const cookies = await ctx.cookies();
console.log("=== ALL cookies after page load ===");
for (const c of cookies) {
  console.log(`  ${c.name} = ${c.value.slice(0, 60)}${c.value.length > 60 ? "..." : ""}  (httpOnly=${c.httpOnly}, domain=${c.domain})`);
}

// Where else might xsrf live?
const tokenInfo = await page.evaluate(() => {
  const meta = document.querySelector('meta[name*="xsrf"], meta[name*="csrf"], meta[name*="token"]');
  const inputs = Array.from(document.querySelectorAll('input[name*="token" i], input[name*="xsrf" i], input[name*="verification" i]'))
    .map((i: any) => ({ name: i.name, value: String(i.value).slice(0, 60) }));
  return {
    metas: Array.from(document.querySelectorAll("meta")).map((m: any) => ({ name: m.name, content: (m.content || "").slice(0, 60) })).filter(m => /token|xsrf|csrf/i.test(m.name)),
    inputs,
    documentCookie: document.cookie.slice(0, 300),
    localStorageKeys: Object.keys(localStorage),
    sessionStorageKeys: Object.keys(sessionStorage),
  };
});
console.log("\n=== page-side state ===");
console.log(JSON.stringify(tokenInfo, null, 2));

await ctx.close();
await browser.close();
