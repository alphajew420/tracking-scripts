import type { Page } from "playwright";
import type { Carrier } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const TRACK_URL = (n: string) =>
  `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`;
const API_URL = "https://api.fedex.com/track/v2/shipments";

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /delivered/i],
  ["pickup", /pickup|hold at location/i],
  ["exception", /exception|delay|return/i],
  ["in_transit", /in transit|on fedex vehicle|departed|arrived|picked up|tendered/i],
];
function classify(desc: string): Status {
  for (const [s, re] of STATUS_KEYWORDS) if (re.test(desc)) return s;
  return "unknown";
}

function buildResult(status: number, json: any, num: string): ScrapeResult {
  if (status === 401) return { ok: false, error: "FedEx HTTP 401 (token expired)" };
  if (status !== 200 || !json) return { ok: false, error: `FedEx HTTP ${status}` };

  const pkg =
    json?.output?.completeTrackResults?.[0]?.trackResults?.[0] ||
    json?.output?.packages?.[0] ||
    json?.TrackPackagesResponse?.packageList?.[0];
  if (!pkg) return { ok: false, error: "FedEx: no package data" };
  if (pkg?.error || pkg?.errorList?.length) {
    return {
      ok: false,
      error: `FedEx: ${pkg.errorList?.[0]?.message || pkg.error || "tracking not found"}`,
    };
  }

  const scanEvents: any[] = pkg.scanEvents || pkg.events || pkg.scanEventList || [];
  const events: Event[] = scanEvents
    .map((e) => {
      const desc =
        e.eventDescription || e.derivedStatus || e.statusBarText || e.status || "";
      return {
        date:
          e.date && e.time ? `${e.date} ${e.time}` : e.date ?? e.scanDate ?? null,
        location:
          e.scanLocation ||
          e.scanCity ||
          [e.scanCity, e.scanStateOrProvinceCode].filter(Boolean).join(", ") ||
          "",
        description: String(desc).trim(),
        status: classify(String(desc)),
      };
    })
    .filter((e) => e.description);

  return {
    ok: true,
    track: {
      carrier: "fedex",
      trackingNumber: num,
      delivered: events.some((e) => e.status === "delivered"),
      recipient: pkg.receivedByName || pkg.signedForByName,
      events,
    },
  };
}

/**
 * FedEx flow:
 *  - warm: load the tracking page; during load FedEx fires
 *      POST api.fedex.com/auth/oauth/v2/token → JSON {access_token}
 *    Our setupPage listener captures the bearer token from that response.
 *  - runQuery: send our own XHR to /track/v2/shipments with the bearer header.
 *    XHR slips past the Akamai fetch hook.
 */
export function createFedexCarrier(): Carrier {
  let bearerToken: string | null = null;

  return {
    name: "fedex",
    mode: "scraper",
    warmUrl: TRACK_URL,

    setupPage(page: Page) {
      bearerToken = null;
      page.on("response", async (resp) => {
        if (
          !/api\.fedex\.com\/auth\/oauth\/v\d\/token/.test(resp.url()) ||
          resp.status() !== 200
        ) return;
        try {
          const json: any = await resp.json();
          if (json?.access_token) bearerToken = json.access_token;
        } catch { /* */ }
      });
    },

    async awaitReady(page: Page) {
      const start = Date.now();
      while (!bearerToken && Date.now() - start < 25000) {
        if (page.url().includes("no-results-found")) return;
        await page.waitForTimeout(200);
      }
    },

    async runQuery(page: Page, num: string): Promise<ScrapeResult> {
      // If the page landed on /no-results-found (because the warm number was
      // invalid), the XHR-from-that-origin fails CORS. Surface it directly.
      if (page.url().includes("no-results-found")) {
        return { ok: false, error: "FedEx: no results found (tracking number invalid)" };
      }
      if (!bearerToken) {
        return { ok: false, error: "FedEx: bearer token never captured during warm" };
      }
      if (process.env.FEDEX_DEBUG) {
        console.error(`[fedex] querying with page.url=${page.url()}`);
        console.error(`[fedex] token len=${bearerToken.length}`);
      }

      const raw = await page.evaluate(
        (args: { url: string; num: string; token: string }) =>
          new Promise<{ status: number; body: string }>((resolve) => {
            const body = {
              appType: "WTRK",
              appDeviceType: "DESKTOP",
              uniqueKey: "",
              processingParameters: {},
              trackingInfo: [
                {
                  trackNumberInfo: {
                    trackingNumber: args.num,
                    trackingQualifier: "",
                    trackingCarrier: "",
                  },
                },
              ],
            };
            const xhr = new XMLHttpRequest();
            xhr.open("POST", args.url, true);
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.setRequestHeader("Authorization", `Bearer ${args.token}`);
            xhr.setRequestHeader("x-clientid", "WTRK");
            xhr.setRequestHeader("x-locale", "en_US");
            xhr.withCredentials = true;
            xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
            xhr.onerror = () => resolve({ status: 0, body: "" });
            xhr.send(JSON.stringify(body));
          }),
        { url: API_URL, num, token: bearerToken },
      );

      if (raw.status === 0) {
        return { ok: false, error: "FedEx: XHR error (network or CORS)" };
      }
      if (raw.status === 401) {
        bearerToken = null;
        return { ok: false, error: "FedEx HTTP 401 (token expired)" };
      }

      let json: any = null;
      try { json = raw.body ? JSON.parse(raw.body) : null; } catch { /* */ }
      return buildResult(raw.status, json, num);
    },

    isExpired: (r) =>
      !r.ok && /401|token expired|Access Denied/i.test(r.error || ""),
  };
}

export const fedexCarrier: Carrier = createFedexCarrier();
