import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const NUM = process.argv[2] ?? "1ZW5244V6870200569";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on("request", (req) => {
  if (!/Track\/GetStatus/i.test(req.url())) return;
  console.log(`>>> ${req.method()} ${req.url()}`);
  const headers = req.headers();
  for (const [k, v] of Object.entries(headers)) {
    console.log(`    ${k}: ${v}`);
  }
});

await page.goto(`https://www.ups.com/track?tracknum=${NUM}&loc=en_US`, {
  waitUntil: "load",
  timeout: 60000,
});
await page.waitForTimeout(10000);

await ctx.close();
await browser.close();
