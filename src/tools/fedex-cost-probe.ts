import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page, type Response } from "patchright";
import { fedexCarrier } from "../carriers/fedex.ts";

const numbers = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["382150811542", "521355676935"];
const pricePerGb = Number(process.env.PROXY_PRICE_PER_GB ?? 0.25);

const blockedTypes = new Set(["image", "font", "media", "stylesheet"]);
const blockedDomains = [
  "googletagmanager.com",
  "google-analytics.com",
  "googleadservices.com",
  "doubleclick.net",
  "facebook.com",
  "facebook.net",
  "fast.fonts.net",
  "adobedtm.com",
  "demdex.net",
  "digital.nuance.com",
  "media-us2.digital.nuance.com",
  "usercentrics.eu",
  "optimizely.com",
  "smetrics.fedex.com",
  "evergage.com",
];

interface Counter {
  count: number;
  bytes: number;
  byHost: Map<string, { count: number; bytes: number }>;
  byType: Map<string, { count: number; bytes: number }>;
}

function counter(): Counter {
  return { count: 0, bytes: 0, byHost: new Map(), byType: new Map() };
}

function add(map: Map<string, { count: number; bytes: number }>, key: string, bytes: number): void {
  const entry = map.get(key) ?? { count: 0, bytes: 0 };
  entry.count += 1;
  entry.bytes += bytes;
  map.set(key, entry);
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function costPer1k(bytesEach: number): string {
  return `$${(((bytesEach * 1000) / 1_000_000_000) * pricePerGb).toFixed(4)}`;
}

function proxyExtension(): string | null {
  const server = process.env.PROXY_FEDEX;
  if (!server) return null;

  const parsed = new URL(server);
  const dir = join(process.cwd(), ".browser-profiles", "proxy-extensions", "fedex-cost-probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        manifest_version: 3,
        name: "Trackified FedEx Cost Probe Proxy",
        version: "1.0.0",
        permissions: ["proxy", "webRequest", "webRequestAuthProvider", "storage"],
        host_permissions: ["<all_urls>"],
        background: { service_worker: "background.js" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "background.js"),
    `
chrome.proxy.settings.set({
  value: {
    mode: "fixed_servers",
    rules: {
      singleProxy: {
        scheme: ${JSON.stringify(parsed.protocol.replace(":", "") || "http")},
        host: ${JSON.stringify(parsed.hostname)},
        port: ${Number(parsed.port || 8080)}
      },
      bypassList: []
    }
  },
  scope: "regular"
});

chrome.webRequest.onAuthRequired.addListener(
  () => ({
    authCredentials: {
      username: ${JSON.stringify(process.env.PROXY_FEDEX_USERNAME ?? "")},
      password: ${JSON.stringify(process.env.PROXY_FEDEX_PASSWORD ?? "")}
    }
  }),
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
`.trimStart(),
  );
  return dir;
}

async function installBlocking(context: BrowserContext): Promise<void> {
  await context.route("**/*", (route, req) => {
    const url = req.url();
    if (blockedTypes.has(req.resourceType())) return route.abort();
    if (blockedDomains.some((domain) => url.includes(domain))) return route.abort();
    return route.continue();
  });
}

function attachCounter(page: Page, c: Counter): void {
  page.on("response", async (response: Response) => {
    let bytes = 0;
    try {
      bytes = (await response.body()).length;
    } catch {
      // Redirects/streamed responses may not expose a body.
    }
    c.count += 1;
    c.bytes += bytes;
    const type = (response.headers()["content-type"] ?? "other").split(";")[0] || "other";
    add(c.byType, type, bytes);
    try {
      add(c.byHost, new URL(response.url()).hostname, bytes);
    } catch {
      add(c.byHost, "unknown", bytes);
    }
  });
}

function dumpTop(label: string, c: Counter, elapsedMs: number): void {
  console.log(`\n${label}: ${fmtBytes(c.bytes)}, ${c.count} responses, ${elapsedMs} ms`);
  for (const [host, entry] of Array.from(c.byHost.entries()).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)) {
    console.log(`  ${host.padEnd(36)} ${String(entry.count).padStart(3)}x ${fmtBytes(entry.bytes)}`);
  }
}

const extension = proxyExtension();
const args = [
  "--disable-blink-features=AutomationControlled",
  ...(extension ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : []),
];
const profileDir = process.env.FEDEX_COST_PROFILE_DIR ?? ".browser-profiles/fedex-cost-probe";
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.BROWSER_CHANNEL_FEDEX === "bundled" ? undefined : "chrome",
  headless: process.env.HEADLESS === "1",
  args,
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});

try {
  await installBlocking(context);

  const sidecarWarm = counter();
  const landing = context.pages()[0] ?? await context.newPage();
  attachCounter(landing, sidecarWarm);
  const warmStart = Date.now();
  await landing.goto("https://www.fedex.com/en-us/tracking.html", {
    waitUntil: "domcontentloaded",
    timeout: Number(process.env.FEDEX_WARM_TIMEOUT_MS ?? 180000),
  });
  await landing.waitForTimeout(3000);
  dumpTop("sidecar landing warm", sidecarWarm, Date.now() - warmStart);

  const runs: Array<{ number: string; bytes: number; ok: boolean; events: number; elapsedMs: number }> = [];
  for (const number of numbers) {
    const page = await context.newPage();
    const c = counter();
    attachCounter(page, c);
    if (fedexCarrier.setupPage) await fedexCarrier.setupPage(page);
    const start = Date.now();
    await page.goto(fedexCarrier.warmUrl(number), {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.FEDEX_WARM_TIMEOUT_MS ?? 180000),
    });
    if (fedexCarrier.awaitReady) await fedexCarrier.awaitReady(page, number);
    const result = await fedexCarrier.runQuery({ page, request: context.request }, number);
    const elapsedMs = Date.now() - start;
    dumpTop(`tracking ${number}`, c, elapsedMs);
    runs.push({
      number,
      bytes: c.bytes,
      ok: Boolean(result.ok && result.track?.events.length),
      events: result.track?.events.length ?? 0,
      elapsedMs,
    });
    await page.close().catch(() => {});
  }

  const totalTrackingBytes = runs.reduce((sum, run) => sum + run.bytes, 0);
  const avgTrackingBytes = totalTrackingBytes / runs.length;
  console.log("\nSUMMARY");
  console.log(`sidecar warm one-time:       ${fmtBytes(sidecarWarm.bytes)}`);
  console.log(`avg clean-page tracking:     ${fmtBytes(avgTrackingBytes)} (${costPer1k(avgTrackingBytes)} / 1k)`);
  console.log(`amortized over 10:           ${fmtBytes(avgTrackingBytes + sidecarWarm.bytes / 10)} each (${costPer1k(avgTrackingBytes + sidecarWarm.bytes / 10)} / 1k)`);
  console.log(`amortized over 100:          ${fmtBytes(avgTrackingBytes + sidecarWarm.bytes / 100)} each (${costPer1k(avgTrackingBytes + sidecarWarm.bytes / 100)} / 1k)`);
  console.log(`amortized over 1000:         ${fmtBytes(avgTrackingBytes + sidecarWarm.bytes / 1000)} each (${costPer1k(avgTrackingBytes + sidecarWarm.bytes / 1000)} / 1k)`);
  console.log(`runs: ${JSON.stringify(runs)}`);
} finally {
  await context.close().catch(() => {});
}
