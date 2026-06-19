import type { Page } from "patchright";
import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status, Track } from "../types.ts";

const TRACK_URL = (n: string) =>
  `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${encodeURIComponent(n)}`;
const SEARCH_URL = (n: string) =>
  `https://www.dhl.de/int-verfolgen/data/search?piececode=${encodeURIComponent(n)}&noRedirect=true&language=en`;

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /zugestellt|delivered/i],
  ["pickup", /abholbereit|pickup|ready for collection/i],
  ["exception", /fehler|exception|problem|nicht zustellbar/i],
  ["in_transit", /in zustellung|transport|sortierzentrum|in transit|sortier/i],
];
function classify(desc: string): Status {
  for (const [s, re] of STATUS_KEYWORDS) if (re.test(desc)) return s;
  return "unknown";
}

interface DhlEvent { status?: string; datum?: string; ort?: string; }

function normalize(json: any, trackingNumber: string): Track {
  const shipment = json?.sendungen?.[0];
  const details = shipment?.sendungsdetails;
  const verlauf = details?.sendungsverlauf;
  const rawEvents: DhlEvent[] = Array.isArray(verlauf?.events) ? verlauf.events : [];
  const events: Event[] = rawEvents
    .filter((e) => e.status)
    .map((e) => ({
      date: e.datum ?? null,
      location: e.ort ?? "",
      description: (e.status ?? "").replace(/<[^>]+>/g, "").trim(),
      status: classify(e.status ?? ""),
    }));
  events.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return {
    carrier: "dhl",
    trackingNumber,
    delivered: events.some((e) => e.status === "delivered"),
    recipient: details?.zustellung?.empfaenger?.name,
    events,
  };
}

/**
 * Browser-side fetch from the warm page. This keeps the request on Chrome's
 * network path and avoids loading the full SPA for every tracking lookup.
 *
 * `maxRedirects: 0` so we see the 303 (tracking-not-found) instead of
 * silently following it to a generic HTML error page.
 */
async function runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
  const raw = await page.evaluate(async (url: string) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        signal: controller.signal,
        headers: { Accept: "application/json, text/plain, */*" },
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        finalUrl: response.url,
        body: await response.text(),
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }, SEARCH_URL(num));

  const status = raw.status;
  if (status >= 300 && status < 400) {
    return { ok: false, error: "DHL: tracking number not found" };
  }
  if (status === 404) return { ok: false, error: "DHL: tracking number not found" };
  if (status !== 200) return { ok: false, error: `DHL HTTP ${status}` };

  const ct = raw.contentType;
  if (!ct.includes("json")) {
    if (/not.?found|keine sendung|no shipment|no result|nicht gefunden/i.test(raw.body)) {
      return { ok: false, error: "DHL: tracking number not found" };
    }
    return { ok: false, error: "DHL: session expired (got HTML)" };
  }

  let json: any;
  try { json = JSON.parse(raw.body); } catch {
    return { ok: false, error: "DHL: invalid JSON" };
  }

  return { ok: true, track: normalize(json, num) };
}

export const dhlCarrier: Carrier = {
  name: "dhl",
  mode: "scraper",
  // Warm with the actual tracking page so Akamai mints cookies for the
  // /int-verfolgen/ path.
  warmUrl: TRACK_URL,
  async awaitReady(page: Page) {
    // Wait for the page's own search XHR to complete — that means Akamai
    // approved the session for /int-verfolgen/data/search.
    await page
      .waitForResponse(
        (r) => r.url().includes("/int-verfolgen/data/search"),
        { timeout: 20000 },
      )
      .catch(() => { /* */ });
  },
  runQuery,
};
