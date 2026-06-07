import { TrackingSession } from "./src/session.ts";
import { uspsCarrier } from "./src/carriers/usps.ts";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromium.use(StealthPlugin());

// Manually replicate the session's first warm + query so we can inspect
// exactly what page.evaluate returns.
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
const page = await ctx.newPage();

const NUM = "9400111899223816042167";
console.log("Navigating...");
await page.goto(`https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${NUM}`, { waitUntil: "load", timeout: 60000 });

console.log("In-page fetch...");
const raw = await page.evaluate(async (u) => {
  const r = await fetch(u, { credentials: "include", redirect: "follow" });
  return { status: r.status, body: await r.text() };
}, `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${NUM}`);

console.log(`status=${raw.status}, body length=${raw.body.length}`);

// Now check what the parser sees
const debug = await page.evaluate((html: string) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const banners = Array.from(doc.querySelectorAll(".banner-header"));
  const trackingWrapper = doc.querySelectorAll(".tracking-wrapper").length;
  const hasNotAvailableText = html.includes("Not Available");
  const tcSamples = banners.slice(0, 5).map((el) => ({
    tag: el.tagName,
    cls: (el as HTMLElement).className,
    textContent: el.textContent?.trim().slice(0, 100),
  }));
  return { bannerCount: banners.length, trackingWrapper, hasNotAvailableText, tcSamples };
}, raw.body);

console.log("debug:", JSON.stringify(debug, null, 2));

await ctx.close();
await browser.close();
