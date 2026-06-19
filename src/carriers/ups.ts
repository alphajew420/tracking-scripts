import type { Page } from "patchright";
import type { Carrier, QueryCtx } from "../session.ts";
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

async function runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
  const cookies = await page.context().cookies();
  const xsrf =
    cookies.find((c) => c.name === "X-XSRF-TOKEN-ST")?.value ??
    cookies.find((c) => c.name === "XSRF-TOKEN")?.value ??
    "";
  if (!xsrf) {
    return { ok: false, error: "UPS: XSRF token cookie missing (warm may have failed)" };
  }

  const raw = await page.evaluate(
    async ({ url, trackingNumber, token }) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, {
          method: "POST",
          credentials: "include",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "x-xsrf-token": token,
          },
          body: JSON.stringify({ Locale: "en_US", TrackingNumber: [trackingNumber] }),
        });
        const text = await response.text();
        return { status: response.status, text };
      } finally {
        window.clearTimeout(timeout);
      }
    },
    { url: `${API_URL}?loc=en_US`, trackingNumber: num, token: xsrf },
  );

  let json: any = null;
  try { json = JSON.parse(raw.text); } catch { /* */ }
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
