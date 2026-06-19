/**
 * FedEx warm-sidecar bandwidth probe.
 *
 * Measures:
 *  - one-time browser warm bytes
 *  - page-owned tracking POST bytes during warm, if FedEx fires one
 *  - repeated same-session tracking POST bytes via page.evaluate(fetch)
 *
 * Run:
 *   npm run probe:bandwidth-fedex -- 123456789012 123456789012 123456789012
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page, type Response } from "patchright";
import { fedexCarrier } from "../src/carriers/fedex.ts";

const NUMS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["123456789012", "123456789012", "123456789012"];

const API_URL = "https://api.fedex.com/track/v2/shipments";
const PRICE_PER_GB = Number(process.env.PROXY_PRICE_PER_GB ?? 0.25);

interface Counter {
  count: number;
  bytes: number;
  byType: Map<string, { count: number; bytes: number }>;
  byHost: Map<string, { count: number; bytes: number }>;
}

function newCounter(): Counter {
  return { count: 0, bytes: 0, byType: new Map(), byHost: new Map() };
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function costFor1000(bytesPerQuery: number): string {
  const gb = (bytesPerQuery * 1000) / 1_000_000_000;
  return `$${(gb * PRICE_PER_GB).toFixed(4)}`;
}

function addToMap(map: Map<string, { count: number; bytes: number }>, key: string, bytes: number): void {
  const entry = map.get(key) ?? { count: 0, bytes: 0 };
  entry.count += 1;
  entry.bytes += bytes;
  map.set(key, entry);
}

function dumpCounter(label: string, c: Counter, elapsedMs: number): void {
  console.log(`\n-- ${label} -- ${elapsedMs} ms, ${c.count} responses, ${fmtBytes(c.bytes)}`);
  const byType = Array.from(c.byType.entries()).sort((a, b) => b[1].bytes - a[1].bytes);
  for (const [type, { count, bytes }] of byType.slice(0, 10)) {
    console.log(`  ${type.padEnd(32)} ${String(count).padStart(3)}x  ${fmtBytes(bytes)}`);
  }
  const byHost = Array.from(c.byHost.entries()).sort((a, b) => b[1].bytes - a[1].bytes);
  if (byHost.length) {
    console.log("  top hosts:");
    for (const [host, { count, bytes }] of byHost.slice(0, 8)) {
      console.log(`    ${host.padEnd(36)} ${String(count).padStart(3)}x  ${fmtBytes(bytes)}`);
    }
  }
}

function proxyExtension(): string | null {
  const server = process.env.PROXY_FEDEX;
  if (!server || process.env.PROXY_FEDEX_MODE !== "extension") return null;

  const parsed = new URL(server);
  const scheme = parsed.protocol.replace(":", "") || "http";
  const host = parsed.hostname;
  const port = Number(parsed.port || (scheme === "https" ? 443 : 80));
  const dir = join(process.cwd(), ".browser-profiles", "proxy-extensions", "fedex-bandwidth-probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        manifest_version: 3,
        name: "Trackified FedEx Probe Proxy",
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
const config = {
  mode: "fixed_servers",
  rules: {
    singleProxy: {
      scheme: ${JSON.stringify(scheme)},
      host: ${JSON.stringify(host)},
      port: ${JSON.stringify(port)}
    },
    bypassList: []
  }
};

chrome.proxy.settings.set({ value: config, scope: "regular" });

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

function fedexPayload(num: string) {
  return {
    appType: "WTRK",
    appDeviceType: "WTRK",
    supportHTML: true,
    supportCurrentLocation: true,
    uniqueKey: "",
    guestAuthenticationToken: "",
    trackingInfo: [
      {
        trackNumberInfo: {
          trackingNumber: num,
          trackingQualifier: "",
          trackingCarrier: "",
        },
      },
    ],
  };
}

async function postFedExTrack(page: Page, token: string, num: string) {
  return page.evaluate(
    async ({ url, bearer, body }) => {
      const startedAt = performance.now();
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${bearer}`,
          "X-Requested-With": "XMLHttpRequest",
          "X-clientid": "WTRK",
          "X-locale": "en_US",
          "X-version": "1.0.0",
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        ms: Math.round(performance.now() - startedAt),
        bodyBytes: new TextEncoder().encode(text).length,
        ok: response.ok,
        hasPackageData: /completeTrackResults|scanEvents|trackResults/.test(text),
      };
    },
    { url: API_URL, bearer: token, body: fedexPayload(num) },
  );
}

let active = newCounter();
let bearerToken: string | null = null;

const extension = proxyExtension();
const browserArgs = [
  "--disable-blink-features=AutomationControlled",
  ...(extension ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : []),
];
const profileDir = process.env.FEDEX_PROFILE_DIR ?? ".browser-profiles/fedex-bandwidth-probe";
const context = await chromium.launchPersistentContext(profileDir, {
  headless: process.env.HEADLESS === "1",
  channel: process.env.BROWSER_CHANNEL_FEDEX === "bundled" ? undefined : (process.env.BROWSER_CHANNEL_FEDEX as "chrome" | "msedge" | undefined) ?? "chrome",
  args: browserArgs,
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});
const page = await context.newPage();

page.on("response", async (resp: Response) => {
  const url = resp.url();
  const type = (resp.headers()["content-type"] || "other").split(";")[0].trim() || "other";
  let bytes = 0;
  try {
    const body = await resp.body();
    bytes = body.length;
    if (/api\.fedex\.com\/auth\/oauth\/v\d\/token/.test(url) && resp.status() === 200) {
      const json = JSON.parse(body.toString("utf8"));
      if (json?.access_token) bearerToken = json.access_token;
    }
  } catch {
    // Redirects and streamed/cached responses can fail body reads.
  }

  active.count += 1;
  active.bytes += bytes;
  addToMap(active.byType, type, bytes);
  try {
    addToMap(active.byHost, new URL(url).hostname, bytes);
  } catch {
    addToMap(active.byHost, "unknown", bytes);
  }

  if (process.env.PROBE_DUMP === "1" && (/fedex\.com/.test(url) || /api\.fedex\.com/.test(url))) {
    console.log(`  [${type}] ${resp.status()} ${fmtBytes(bytes)} ${url}`);
  }
});

try {
  console.log(`FedEx bandwidth probe - ${NUMS.length} same-session queries`);
  console.log(`Proxy mode: ${extension ? "extension" : process.env.PROXY_FEDEX ? "native/none" : "none"}`);

  const warm = active = newCounter();
  const warmT0 = Date.now();
  await page.goto(fedexCarrier.warmUrl(NUMS[0]!), {
    waitUntil: process.env.FEDEX_WARM_WAIT_UNTIL === "load" ? "load" : "domcontentloaded",
    timeout: Number(process.env.FEDEX_WARM_TIMEOUT_MS ?? 180000),
  });
  if (fedexCarrier.awaitReady) await fedexCarrier.awaitReady(page, NUMS[0]!);
  const warmMs = Date.now() - warmT0;
  dumpCounter("WARM one-time browser/session", warm, warmMs);

  const waitStart = Date.now();
  while (!bearerToken && Date.now() - waitStart < 15000) {
    await page.waitForTimeout(250);
  }
  if (!bearerToken) throw new Error("FedEx bearer token was not captured during warm");

  const queryCounters: Array<{ num: string; counter: Counter; fetchMs: number; ok: boolean; status: number; bodyBytes: number }> = [];
  for (const num of NUMS) {
    const counter = active = newCounter();
    const t0 = Date.now();
    const result = await postFedExTrack(page, bearerToken, num);
    const elapsedMs = Date.now() - t0;
    queryCounters.push({
      num,
      counter,
      fetchMs: result.ms,
      ok: result.ok && result.hasPackageData,
      status: result.status,
      bodyBytes: result.bodyBytes,
    });
    const paidBytes = Math.max(counter.bytes, result.bodyBytes);
    dumpCounter(
      `QUERY ${num} (${result.status}, ${result.ok && result.hasPackageData ? "package data" : "no package data"}, fetch body ${fmtBytes(result.bodyBytes)}, fetch ${result.ms} ms)`,
      counter,
      elapsedMs,
    );
    if (paidBytes !== counter.bytes) {
      console.log(`  accounted bytes: ${fmtBytes(paidBytes)} (fetch body used because page response event did not include it)`);
    }
  }

  const totalQueryBytes = queryCounters.reduce(
    (sum, row) => sum + Math.max(row.counter.bytes, row.bodyBytes),
    0,
  );
  const avgQueryBytes = totalQueryBytes / queryCounters.length;
  const avgFetchMs = queryCounters.reduce((sum, row) => sum + row.fetchMs, 0) / queryCounters.length;

  console.log("\nSUMMARY");
  console.log(`Warm phase:              ${fmtBytes(warm.bytes)} one-time`);
  console.log(`Steady-state avg query:  ${fmtBytes(avgQueryBytes)} counted network, ${Math.round(avgFetchMs)} ms fetch`);
  console.log(`Cost / 1,000 steady:     ${costFor1000(avgQueryBytes)} at $${PRICE_PER_GB}/GB`);
  console.log(`Amortized N=10:          ${fmtBytes(warm.bytes / 10 + avgQueryBytes)} each, ${costFor1000(warm.bytes / 10 + avgQueryBytes)} / 1,000`);
  console.log(`Amortized N=100:         ${fmtBytes(warm.bytes / 100 + avgQueryBytes)} each, ${costFor1000(warm.bytes / 100 + avgQueryBytes)} / 1,000`);
  console.log(`Amortized N=1000:        ${fmtBytes(warm.bytes / 1000 + avgQueryBytes)} each, ${costFor1000(warm.bytes / 1000 + avgQueryBytes)} / 1,000`);
} finally {
  await context.close().catch(() => {});
}
