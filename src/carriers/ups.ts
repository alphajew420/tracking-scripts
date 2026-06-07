import type { Page } from "playwright";
import type { Carrier } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const TRACK_URL = (n: string) =>
  `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}&loc=en_US`;
const API_URL = "https://webapis.ups.com/track/api/Track/GetStatus";

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /delivered/i],
  ["pickup", /pickup|access point|hold for pickup/i],
  ["exception", /exception|undeliverable|returned/i],
  ["in_transit", /in transit|out for delivery|departed|arrived|origin scan|loaded|sorted/i],
];
function classify(desc: string): Status {
  for (const [s, re] of STATUS_KEYWORDS) if (re.test(desc)) return s;
  return "unknown";
}

function buildResult(status: number, json: any, num: string): ScrapeResult {
  if (status === 401 || status === 403) {
    return { ok: false, error: `UPS HTTP ${status} (session may have expired)` };
  }
  if (status !== 200 || !json) return { ok: false, error: `UPS HTTP ${status}` };

  const details = json?.trackDetails?.[0];
  if (!details) {
    const code = json?.statusCode || json?.statusText;
    return { ok: false, error: `UPS: tracking not found${code ? ` (${code})` : ""}` };
  }
  const activities: any[] = Array.isArray(details.shipmentProgressActivities)
    ? details.shipmentProgressActivities
    : [];
  const events: Event[] = activities
    .filter((a) => a?.activityScan)
    .map((a) => ({
      date: a.date && a.time ? `${a.date} ${a.time}` : a.date ?? null,
      location: typeof a.location === "string" ? a.location : "",
      description: String(a.activityScan).trim(),
      status: classify(String(a.activityScan)),
    }));
  return {
    ok: true,
    track: {
      carrier: "ups",
      trackingNumber: num,
      delivered: events.some((e) => e.status === "delivered"),
      recipient: details.receivedBy,
      events,
    },
  };
}

/**
 * After warm, call /Track/GetStatus directly via in-page XHR. UPS's Akamai
 * SDK hooks window.fetch but not XMLHttpRequest, so XHR slips through.
 */
async function runQuery(page: Page, num: string): Promise<ScrapeResult> {
  // UPS stores the anti-forgery token in cookie X-XSRF-TOKEN-ST (set on
  // .ups.com domain, so document.cookie may not see it depending on the
  // current page origin — pull via context.cookies()).
  const cookies = await page.context().cookies();
  const xsrf =
    cookies.find((c) => c.name === "X-XSRF-TOKEN-ST")?.value ??
    cookies.find((c) => c.name === "XSRF-TOKEN")?.value ??
    "";
  if (!xsrf) {
    return { ok: false, error: "UPS: XSRF token cookie missing (warm may have failed)" };
  }

  const raw = await page.evaluate(
    (args: { url: string; num: string; xsrf: string }) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${args.url}?loc=en_US`, true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
        xhr.setRequestHeader("x-xsrf-token", args.xsrf);
        xhr.withCredentials = true;
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
        xhr.onerror = () => resolve({ status: 0, body: "" });
        xhr.send(JSON.stringify({ Locale: "en_US", TrackingNumber: [args.num] }));
      }),
    { url: API_URL, num, xsrf },
  );

  if (raw.status === 0) return { ok: false, error: "UPS: XHR error (network or CORS)" };

  let json: any = null;
  try { json = raw.body ? JSON.parse(raw.body) : null; } catch { /* */ }
  return buildResult(raw.status, json, num);
}

export const upsCarrier: Carrier = {
  name: "ups",
  mode: "scraper",
  warmUrl: TRACK_URL,
  async awaitReady(page: Page) {
    // Wait for the page's own GetStatus call so we know Akamai/reCAPTCHA
    // approved the session.
    await page
      .waitForResponse(
        (r) => /\/track\/api\/Track\/GetStatus/i.test(r.url()),
        { timeout: 25000 },
      )
      .catch(() => { /* */ });
  },
  runQuery,
};

export function createUpsCarrier(): Carrier {
  return upsCarrier;
}
