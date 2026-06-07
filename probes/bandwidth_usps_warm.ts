/**
 * Warm-then-fetch bandwidth probe for the USPS scraper.
 *
 * The original `bandwidth_usps.ts` measures a cold `page.goto()` — useful
 * for "how much does it cost to first hit USPS." But that's NOT what
 * production pays: TrackingSession warms once, then every subsequent
 * lookup runs as `page.evaluate(fetch ...)` inside the warm page, which
 * skips the asset reload entirely.
 *
 * This probe measures both. Run with:
 *   npx tsx bandwidth_usps_warm.ts <number1> [number2 ...]
 *
 * Output: bytes during warm phase, then per-query bytes for each
 * subsequent number, then totals + averages.
 */

import { chromium } from "playwright";
import { uspsCarrier } from "./src/carriers/usps.ts";

const NUMS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [
      "9400111899223816042167",
      "9400111899223816042167",
      "9400111899223816042167",
    ];

if (uspsCarrier.mode !== "scraper") {
  throw new Error("uspsCarrier is not a scraper — wrong import");
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

interface Counter {
  count: number;
  bytes: number;
  byType: Map<string, { count: number; bytes: number }>;
}

function newCounter(): Counter {
  return { count: 0, bytes: 0, byType: new Map() };
}

// System Chrome — bundled Chromium gets flagged by Akamai for USPS.
// Headless: false would let you watch it run; true is fine here.
// Mirror TrackingSession's full stealth setup verbatim — without these
// three knobs (UA, viewport/locale, --disable-blink-features) Akamai
// catches the bundled Playwright fingerprint and redirects to
// errors.edgesuite.net before USPS' tracking widget ever renders.
// Akamai's sensor.js detects headless Chrome even with the UA/UV/args
// stealth tweaks — the tracking widget never renders. Drop headless so
// the real browser process can answer the headless probes. Set
// HEADLESS=1 in the env to opt back in if your environment can handle
// it (or once we layer patchright stealth on top).
const headless = process.env.HEADLESS === "1";
const browser = await chromium.launch({
  headless,
  channel: "chrome",
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});

// Same blocked-set TrackingSession ships in production. Skip when
// NO_BLOCKING=1 — useful for getting past Akamai's first warm when
// the sensor JS needs the page's own stylesheets/images to finish
// minting cookies. After warm, subsequent fetch() calls don't pull
// assets anyway so the bandwidth number is unaffected.
if (process.env.NO_BLOCKING !== "1") {
  const BLOCKED_TYPES = new Set(["image", "font", "media", "stylesheet"]);
  const BLOCKED_DOMAINS = [
    "doubleclick", "googletagmanager", "google-analytics",
    "adsystem", "adservice", "scorecardresearch",
  ];
  await context.route("**/*", (route, req) => {
    const url = req.url();
    if (BLOCKED_TYPES.has(req.resourceType())) return route.abort();
    if (BLOCKED_DOMAINS.some((d) => url.includes(d))) return route.abort();
    return route.continue();
  });
}

const page = await context.newPage();

let active: Counter = newCounter();
page.on("response", async (resp) => {
  const ct = (resp.headers()["content-type"] || "other").split(";")[0].trim();
  let size = 0;
  let bodyPreview = "";
  try {
    const buf = await resp.body();
    size = buf.length;
    if (process.env.PROBE_DUMP === "1" && (ct.includes("json") || ct.includes("html"))) {
      bodyPreview = buf.toString("utf8").slice(0, 240).replace(/\s+/g, " ");
    }
  } catch { /* redirect / closed */ }
  active.count++;
  active.bytes += size;
  const e = active.byType.get(ct) ?? { count: 0, bytes: 0 };
  e.count++;
  e.bytes += size;
  active.byType.set(ct, e);
  // PROBE_DUMP=1 prints every JSON / HTML response with its URL so we
  // can identify the lightweight XHR endpoint behind USPS' SPA.
  if (process.env.PROBE_DUMP === "1" && (ct.includes("json") || resp.url().includes("track"))) {
    console.log(`    [${ct}] ${fmtBytes(size)}  ${resp.url()}`);
    if (bodyPreview) console.log(`      → ${bodyPreview}`);
  }
});

function dumpCounter(label: string, c: Counter, elapsedMs: number): void {
  console.log(`\n── ${label} ── ${elapsedMs} ms, ${c.count} responses, ${fmtBytes(c.bytes)}`);
  const rows = Array.from(c.byType.entries()).sort((a, b) => b[1].bytes - a[1].bytes);
  for (const [ct, { count, bytes }] of rows) {
    console.log(`  ${ct.padEnd(28)} ${String(count).padStart(3)}×  ${fmtBytes(bytes)}`);
  }
}

console.log(`USPS warm-then-fetch probe · ${NUMS.length} queries\n`);

// ── Warm phase ────────────────────────────────────────────────────
const warmCounter = active = newCounter();
const warmT0 = Date.now();
const resp = await page.goto(uspsCarrier.warmUrl(NUMS[0]), { waitUntil: "load", timeout: 60000 });
try {
  if (uspsCarrier.awaitReady) await uspsCarrier.awaitReady(page);
} catch (e) {
  console.error(`\n!! awaitReady failed — HTTP ${resp?.status()}, dumping page state:`);
  const title = await page.title().catch(() => "(title unreadable)");
  const url = page.url();
  const bodyLen = await page.evaluate(() => document.body?.innerHTML?.length ?? 0).catch(() => -1);
  const bodyHead = await page.evaluate(() => document.body?.innerText?.slice(0, 800) ?? "(no body)").catch(() => "(eval failed)");
  // Dump the raw page HTML to disk so we can diff what Akamai is showing.
  try {
    const html = await page.content();
    await import("node:fs").then((fs) => fs.writeFileSync("usps-probe-failure.html", html));
    console.error(`   wrote usps-probe-failure.html (${html.length} bytes)`);
  } catch { /* */ }
  console.error(`   landed URL: ${url}`);
  console.error(`   title: "${title}"`);
  console.error(`   body length: ${bodyLen}`);
  console.error(`   body[0:800]:\n${bodyHead}`);
  await browser.close();
  throw e;
}
const warmMs = Date.now() - warmT0;
dumpCounter("WARM (one-time)", warmCounter, warmMs);

// ── Per-query phase ───────────────────────────────────────────────
// MODE=raw uses context.request.get() — a raw HTTP call that reuses
// the warm context's cookies (Akamai _abck, JSESSIONID, etc.) and the
// Chrome TLS fingerprint, but SKIPS every page-level side-effect:
//   no React chrome re-render, no analytics beacons, no JS bundle
//   re-fetches. The body that comes back is just the 69 KB HTML.
// MODE=evaluate (default) matches production's `page.evaluate(fetch)`
// path for an apples-to-apples comparison.
const queryMode = process.env.MODE ?? "evaluate";
const queryCounters: Array<{ num: string; counter: Counter; ms: number; ok: boolean; bodyLen: number }> = [];
for (const num of NUMS) {
  active = newCounter();
  const t0 = Date.now();
  let ok = false;
  let bodyLen = 0;

  if (queryMode === "raw") {
    // context.request bypasses the page lifecycle entirely. Cookies
    // come from the context (set during warm); fingerprint is the
    // same UA we configured. Response is the raw 69 KB tracking page.
    // page.on("response") doesn't fire here, so we account manually.
    const r = await context.request.get(uspsCarrier.warmUrl(num), { failOnStatusCode: false });
    const body = await r.text();
    bodyLen = body.length;
    // Account manually so the counter reflects what raw mode pays.
    active.count = 1;
    active.bytes = bodyLen;
    active.byType.set("text/html", { count: 1, bytes: bodyLen });
    ok = r.ok() && (body.includes("tracking-wrapper") || body.includes("Tracking Number") || body.includes("qtc_tLabels"));
  } else {
    const result = await uspsCarrier.runQuery(page, num);
    ok = result.ok;
  }
  const ms = Date.now() - t0;
  queryCounters.push({ num, counter: active, ms, ok, bodyLen });
  dumpCounter(`QUERY ${num} (${ok ? "ok" : "fail"}${queryMode === "raw" ? `, body ${fmtBytes(bodyLen)}` : ""})`, active, ms);
}

// ── Summary ───────────────────────────────────────────────────────
const totalQueryBytes = queryCounters.reduce((a, q) => a + q.counter.bytes, 0);
const avgQueryBytes = totalQueryBytes / queryCounters.length;
const totalQueryMs = queryCounters.reduce((a, q) => a + q.ms, 0);
const avgQueryMs = totalQueryMs / queryCounters.length;

console.log("\n╔════════════════════════════════════════════════════════════════════════╗");
console.log("║                            SUMMARY                                     ║");
console.log("╚════════════════════════════════════════════════════════════════════════╝");
console.log(`Warm phase (one-time):     ${warmMs} ms, ${fmtBytes(warmCounter.bytes)}`);
console.log(`Steady-state per query:    avg ${Math.round(avgQueryMs)} ms, avg ${fmtBytes(avgQueryBytes)}`);
console.log(`Total (warm + ${NUMS.length} queries):  ${warmMs + totalQueryMs} ms, ${fmtBytes(warmCounter.bytes + totalQueryBytes)}`);
console.log(`\nIf you run N queries on one warm session:`);
console.log(`  N=1   → ${fmtBytes(warmCounter.bytes + avgQueryBytes)} total`);
console.log(`  N=10  → ${fmtBytes(warmCounter.bytes + avgQueryBytes * 10)} total · ${fmtBytes(warmCounter.bytes / 10 + avgQueryBytes)} per query`);
console.log(`  N=100 → ${fmtBytes(warmCounter.bytes + avgQueryBytes * 100)} total · ${fmtBytes(warmCounter.bytes / 100 + avgQueryBytes)} per query`);

await browser.close();
