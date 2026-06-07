/**
 * Two-phase USPS bandwidth test:
 *
 *   Phase A: Initial visit via Playwright page.goto() with aggressive
 *            route() blocking (drop images, fonts, CSS, analytics, ads).
 *
 *   Phase B: A second tracking lookup via context.request.get() — which
 *            reuses the browser's TLS fingerprint AND its Akamai cookies,
 *            but does *not* load any page assets. Just the raw HTML.
 *
 *   Phase B should be a tiny fraction of Phase A.
 */
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const NUM1 = process.argv[2] ?? "9400111899223816042167";
const NUM2 = process.argv[3] ?? "9405511899223816042168";

const fmt = (b: number) =>
  b >= 1024 * 1024
    ? `${(b / 1024 / 1024).toFixed(2)} MB`
    : `${(b / 1024).toFixed(1)} KB`;

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});

const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});

// Resource blocking: drop everything that isn't strictly needed to render
// the tracking widget HTML. Block by type AND by 3rd-party domain.
const BLOCKED_TYPES = new Set(["image", "font", "media", "stylesheet"]);
const BLOCKED_DOMAINS = [
  "googletagmanager.com",
  "google-analytics.com",
  "googleadservices.com",
  "google.com/ccm",
  "google.com/g/collect",
  "doubleclick.net",
  "facebook.com",
  "facebook.net",
  "fast.fonts.net",
  "adobe.com",
  "adobedtm.com",
  "demdex.net",
];

let blockedCount = 0;
let blockedBytesEstimate = 0;

await ctx.route("**/*", (route, req) => {
  const url = req.url();
  if (BLOCKED_TYPES.has(req.resourceType())) {
    blockedCount++;
    return route.abort();
  }
  if (BLOCKED_DOMAINS.some((d) => url.includes(d))) {
    blockedCount++;
    return route.abort();
  }
  return route.continue();
});

// Track Phase A bandwidth (page navigation).
let phaseAResponses = 0;
let phaseABytes = 0;

const page = await ctx.newPage();
page.on("response", async (resp) => {
  try {
    const buf = await resp.body();
    phaseABytes += buf.length;
    phaseAResponses++;
  } catch {
    /* aborted or redirect */
  }
});

const tA0 = Date.now();
console.log(`Phase A: navigating to USPS tracking page for ${NUM1}...`);
await page.goto(
  `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${NUM1}`,
  { waitUntil: "load", timeout: 60000 },
);
await page.waitForSelector(
  ".tracking-wrapper, .latest-update-banner-wrapper, .banner-header",
  { timeout: 20000 },
);
const tA = Date.now() - tA0;
console.log(`Phase A done: ${phaseAResponses} responses, ${fmt(phaseABytes)}, ${tA}ms`);
console.log(`           (blocked ${blockedCount} requests from network)`);

// Phase B: raw HTTP request reusing the context (cookies + Chromium TLS).
const tB0 = Date.now();
console.log(`\nPhase B: raw HTTP via context.request for ${NUM2}...`);
const resp = await ctx.request.get(
  `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${NUM2}`,
  { maxRedirects: 5 },
);
const html = await resp.text();
const tB = Date.now() - tB0;
const phaseBBytes = Buffer.byteLength(html, "utf8");
console.log(`Phase B done: HTTP ${resp.status()}, ${fmt(phaseBBytes)} body, ${tB}ms`);

const containsWidget =
  html.includes("tracking-wrapper") ||
  html.includes("trackingNum") ||
  html.includes("banner-header");
const containsBlocked = html.includes("Access Denied") || html.includes("Reference #");

console.log(
  `Phase B body has tracking widget: ${containsWidget}, has Access Denied: ${containsBlocked}`,
);

// Phase C: same page re-navigation (static assets should hit browser cache).
let phaseCBytes = 0;
let phaseCResponses = 0;
const pageCBytesAtStart = phaseABytes; // baseline; ignore — we'll use a separate counter
let pageCBytesTracker = 0;
page.removeAllListeners("response");
page.on("response", async (resp) => {
  try {
    const buf = await resp.body();
    pageCBytesTracker += buf.length;
    phaseCResponses++;
  } catch {
    /* */
  }
});

const tC0 = Date.now();
console.log(`\nPhase C: page.goto() to second tracking URL (cache should kick in)...`);
await page.goto(
  `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${NUM2}`,
  { waitUntil: "load", timeout: 60000 },
);
await page.waitForSelector(
  ".tracking-wrapper, .latest-update-banner-wrapper, .banner-header",
  { timeout: 20000 },
);
const tC = Date.now() - tC0;
phaseCBytes = pageCBytesTracker;
console.log(`Phase C done: ${phaseCResponses} responses, ${fmt(phaseCBytes)}, ${tC}ms`);

// Phase D: in-page fetch() via page.evaluate() — runs inside Chromium's JS,
// Akamai treats it as a legitimate same-origin XHR.
const tD0 = Date.now();
console.log(`\nPhase D: in-page fetch() via page.evaluate()...`);
const fetchResult = await page.evaluate(async (url) => {
  const r = await fetch(url, { credentials: "include" });
  const txt = await r.text();
  return { status: r.status, body: txt };
}, `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${NUM1}`);
const tD = Date.now() - tD0;
const phaseDBytes = Buffer.byteLength(fetchResult.body, "utf8");
console.log(`Phase D done: HTTP ${fetchResult.status}, ${fmt(phaseDBytes)} body, ${tD}ms`);
const phaseDWidget =
  fetchResult.body.includes("tracking-wrapper") ||
  fetchResult.body.includes("trackingNum");
const phaseDBlocked = fetchResult.body.includes("Access Denied");
console.log(
  `Phase D has tracking widget: ${phaseDWidget}, has Access Denied: ${phaseDBlocked}`,
);

console.log(`\n=== SUMMARY ===`);
console.log(`Phase A (initial nav + blocking):       ${fmt(phaseABytes).padStart(10)}  ${tA}ms`);
console.log(`Phase B (context.request raw HTTP):     ${fmt(phaseBBytes).padStart(10)}  ${tB}ms  ${containsBlocked ? "BLOCKED" : "ok"}`);
console.log(`Phase C (re-nav same page):             ${fmt(phaseCBytes).padStart(10)}  ${tC}ms`);
console.log(`Phase D (in-page fetch):                ${fmt(phaseDBytes).padStart(10)}  ${tD}ms  ${phaseDBlocked ? "BLOCKED" : "ok"}`);

await ctx.close();
await browser.close();
