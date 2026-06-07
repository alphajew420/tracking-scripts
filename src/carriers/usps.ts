import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const URL_FOR = (n: string) =>
  `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${encodeURIComponent(n)}`;

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /delivered/i],
  ["pickup", /available for pickup|ready for pickup|notice left/i],
  ["exception", /undeliverable|returned to sender|delivery exception/i],
  [
    "in_transit",
    /in transit|departed|arrived|out for delivery|processed|acceptance|sorting/i,
  ],
];

function classify(desc: string): Status {
  for (const [s, re] of STATUS_KEYWORDS) if (re.test(desc)) return s;
  return "unknown";
}

async function runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
  // page.evaluate(fetch) — the only path Akamai accepts, because the
  // fetch runs from inside the real Chrome process (correct JA3 + bot
  // score + browser fingerprint). context.request uses Node's TLS so
  // its JA3 hash doesn't match Chrome and Akamai 403's it even with
  // valid session cookies.
  //
  // To kill the 1+ MB of SPA chrome that USPS' page would normally
  // re-pull, the session ALSO installs a tightened route blocker after
  // warm — see TrackingSession.ensureWarm post-warm hook.
  const raw = await page.evaluate(async (u: string) => {
    const r = await fetch(u, { credentials: "include", redirect: "follow" });
    return { status: r.status, body: await r.text() };
  }, URL_FOR(num));

  if (raw.status !== 200) {
    return { ok: false, error: `USPS fetch HTTP ${raw.status}` };
  }
  const body = raw.body;
  if (body.includes("Access Denied") || body.includes("edgesuite")) {
    return { ok: false, error: "USPS: Access Denied (Akamai session expired)" };
  }

  // Parse inside the browser via DOMParser — keeps Node free of an HTML
  // parser dep, and the IPC roundtrip is tiny (just the response body).
  type RawEvent = { date: string | null; location: string; description: string };
  const parsed = await page.evaluate((html: string): {
    notAvailable: boolean;
    events: RawEvent[];
  } => {
    const doc = new DOMParser().parseFromString(html, "text/html");

    const notAvailable = !!Array.from(
      doc.querySelectorAll(".banner-header"),
    ).find((el) => /Not Available/i.test((el as HTMLElement).textContent ?? ""));

    const events: RawEvent[] = [];
    const stepSelectors = [
      ".tb-step",
      ".tracking-progress-bar-status-container",
      ".tracking_history_details",
      "[class*='tracking-step']",
      "[class*='step-details']",
    ];
    const seen = new Set<string>();
    for (const sel of stepSelectors) {
      for (const node of Array.from(doc.querySelectorAll(sel))) {
        const text = (node as HTMLElement).textContent?.trim() ?? "";
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const dateEl = node.querySelector("[class*='date'], [class*='Date'], time");
        const locEl = node.querySelector("[class*='location'], [class*='Location']");
        const descEl = node.querySelector(
          "[class*='description'], [class*='status'], [class*='Status']",
        );
        events.push({
          date: dateEl ? (dateEl as HTMLElement).textContent?.trim() ?? null : null,
          location: locEl ? (locEl as HTMLElement).textContent?.trim() ?? "" : "",
          description: descEl
            ? (descEl as HTMLElement).textContent?.trim() ?? ""
            : text.slice(0, 200),
        });
      }
    }
    return { notAvailable, events };
  }, body);

  if (parsed.notAvailable && parsed.events.length === 0) {
    return {
      ok: false,
      error:
        "USPS: tracking not available (number invalid, expired, or item not yet scanned)",
    };
  }

  const events: Event[] = parsed.events.map((e) => ({
    date: e.date,
    location: e.location,
    description: e.description,
    status: classify(e.description),
  }));

  return {
    ok: true,
    track: {
      carrier: "usps",
      trackingNumber: num,
      delivered: events.some((e) => e.status === "delivered"),
      events,
    },
  };
}

export const uspsCarrier: Carrier = {
  name: "usps",
  mode: "scraper",
  warmUrl: URL_FOR,
  // Wait until the tracking widget renders — that's our signal that Akamai
  // has minted valid cookies for the session.
  async awaitReady(page) {
    await page.waitForSelector(
      ".tracking-wrapper, .latest-update-banner-wrapper, .banner-header",
      { timeout: 20000 },
    );
  },
  runQuery,
  isExpired: (r) =>
    !r.ok &&
    /Access Denied|Akamai session|HTTP 403/i.test(r.error || ""),
};
