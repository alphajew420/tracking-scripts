import type { Page } from "playwright";
import type { Carrier } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const URL_FOR = (n: string) =>
  `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}&submit=1`;

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /delivered/i],
  ["pickup", /pickup|hold for collection/i],
  ["exception", /exception|delay|return/i],
  ["in_transit", /in transit|arrived|departed|clearance|out for delivery|with delivery|picked up/i],
];
function classify(desc: string): Status {
  for (const [s, re] of STATUS_KEYWORDS) if (re.test(desc)) return s;
  return "unknown";
}

/**
 * DHL Express's modern site is a SPA — for invalid numbers it renders the
 * "not successful" message inline without firing an obvious tracking XHR.
 * Strategy: navigate via in-page fetch to grab the page HTML, parse it for
 * either the error message or the event timeline.
 *
 * If a stable JSON XHR is identified later we can swap to that — the strategy
 * lives behind the Carrier interface.
 */
async function runQuery(page: Page, num: string): Promise<ScrapeResult> {
  const raw = await page.evaluate(async (u: string) => {
    const r = await fetch(u, { credentials: "include", redirect: "follow" });
    return { status: r.status, body: await r.text() };
  }, URL_FOR(num));

  if (raw.status !== 200) {
    return { ok: false, error: `DHL Express HTTP ${raw.status}` };
  }
  if (raw.body.includes("Access Denied")) {
    return { ok: false, error: "DHL Express: Access Denied (session expired)" };
  }
  if (
    /tracking attempt was not successful|no shipment found|please check your tracking number/i.test(
      raw.body,
    )
  ) {
    return { ok: false, error: "DHL Express: tracking number not found" };
  }

  // Parse events from the SPA-rendered HTML, if present.
  const parsed = await page.evaluate((html: string) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out: Array<{ date: string | null; location: string; description: string }> = [];
    const candidates = doc.querySelectorAll(
      "[class*='event'], [class*='checkpoint'], [class*='timeline-item']",
    );
    for (const node of Array.from(candidates)) {
      const text = (node as HTMLElement).textContent?.trim() ?? "";
      if (!text) continue;
      const dateEl = node.querySelector("[class*='date'], time");
      const locEl = node.querySelector("[class*='location']");
      const descEl = node.querySelector(
        "[class*='description'], [class*='status']",
      );
      out.push({
        date: dateEl ? (dateEl as HTMLElement).textContent.trim() : null,
        location: locEl ? (locEl as HTMLElement).textContent.trim() : "",
        description: descEl
          ? (descEl as HTMLElement).textContent.trim()
          : text.slice(0, 200),
      });
    }
    return out;
  }, raw.body);

  if (parsed.length === 0) {
    return {
      ok: false,
      error:
        "DHL Express: page rendered but no events parsed (selector heuristics may need updating)",
    };
  }

  const events: Event[] = parsed.map((e) => ({
    date: e.date,
    location: e.location,
    description: e.description,
    status: classify(e.description),
  }));

  return {
    ok: true,
    track: {
      carrier: "dhl-express",
      trackingNumber: num,
      delivered: events.some((e) => e.status === "delivered"),
      events,
    },
  };
}

export const dhlExpressCarrier: Carrier = {
  name: "dhl-express",
  mode: "scraper",
  warmUrl: URL_FOR,
  runQuery,
};
