import type { Page } from "playwright";
import type { Carrier } from "../session.ts";
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
 * Lightweight path: after warm, call DHL's /int-verfolgen/data/search endpoint
 * directly via in-page fetch (reuses the warm session's Akamai cookies + TLS).
 * Crucial detail: redirect: "manual" so we see the 303 (not-found) instead of
 * silently following it to an HTML error page.
 */
async function runQuery(page: Page, num: string): Promise<ScrapeResult> {
  const raw = await page.evaluate(async (u: string) => {
    const r = await fetch(u, { credentials: "include", redirect: "manual" });
    const ct = r.headers.get("content-type") || "";
    // r.type === "opaqueredirect" when fetch hits a 3xx with redirect: "manual"
    return {
      status: r.status,
      type: r.type,
      contentType: ct,
      body: r.type === "opaqueredirect" ? "" : await r.text(),
    };
  }, SEARCH_URL(num));

  if (raw.type === "opaqueredirect" || (raw.status >= 300 && raw.status < 400)) {
    return { ok: false, error: "DHL: tracking number not found" };
  }
  if (raw.status === 404) return { ok: false, error: "DHL: tracking number not found" };
  if (raw.status !== 200) return { ok: false, error: `DHL HTTP ${raw.status}` };
  if (!raw.contentType.includes("json")) {
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
