import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFile } from "node:fs/promises";

chromium.use(StealthPlugin());

const NUM = process.argv[2] ?? "1ZW5244V6870200569";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.goto(`https://www.ups.com/track?tracknum=${NUM}&loc=en_US`, {
  waitUntil: "load",
  timeout: 60000,
});
await page.waitForTimeout(8000);

console.log(`final url: ${page.url()}`);
console.log(`title: ${await page.title()}`);

const html = await page.content();
await writeFile("ups-page.html", html);
console.log(`saved ${html.length} bytes`);

// Search for tracking-data markers
for (const marker of [
  "shipmentProgressActivities",
  "trackDetails",
  "activityScan",
  "Tracking Number",
  "not found",
  "could not be located",
  "no tracking information",
  "We could not locate",
]) {
  if (html.toLowerCase().includes(marker.toLowerCase())) {
    console.log(`  ✓ marker: "${marker}"`);
  }
}

const text = await page.evaluate(() => document.body.innerText);
console.log("\n=== visible body text (first 800 chars) ===");
console.log(text.slice(0, 800));

await ctx.close();
await browser.close();
