import type { ApiCarrier } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const ENDPOINT = "https://api-eu.dhl.com/track/shipments";

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /delivered|zugestellt/i],
  ["pickup", /pickup|abholbereit|ready for collection/i],
  ["exception", /exception|delay|return|fehler|nicht zustellbar/i],
  ["in_transit", /in transit|transport|arrived|departed|sortier|in zustellung|picked up|with delivery|out for delivery/i],
];
function classify(desc: string): Status {
  for (const [s, re] of STATUS_KEYWORDS) if (re.test(desc)) return s;
  return "unknown";
}

export interface DhlApiOptions {
  /** Defaults to process.env.DHL_API_KEY. */
  apiKey?: string;
  /**
   * Optional service hint. Lets DHL route the lookup faster + reduces
   * ambiguity for tracking numbers that match multiple services.
   * Common values: "parcel-de", "express", "ecommerce", "freight".
   */
  service?: string;
  /** Override the configured carrier name (default "dhl"). */
  name?: string;
}

function parse(json: any, num: string, carrierName: string): ScrapeResult {
  const shipment = json?.shipments?.[0];
  if (!shipment) return { ok: false, error: "DHL API: no shipment data" };

  const rawEvents: any[] = Array.isArray(shipment.events) ? shipment.events : [];
  const events: Event[] = rawEvents.map((e) => {
    const desc = e.description ?? e.status?.description ?? "";
    return {
      date: e.timestamp ?? null,
      location:
        e.location?.address?.addressLocality ??
        e.location?.address?.countryCode ??
        "",
      description: String(desc).trim(),
      status: classify(String(desc)),
    };
  });

  return {
    ok: true,
    track: {
      carrier: carrierName,
      trackingNumber: num,
      delivered: events.some((e) => e.status === "delivered"),
      events,
    },
  };
}

export function createDhlApiCarrier(opts: DhlApiOptions = {}): ApiCarrier {
  const apiKey = opts.apiKey ?? process.env.DHL_API_KEY;
  const carrierName = opts.name ?? "dhl";

  return {
    name: carrierName,
    mode: "api",

    async runQuery(num: string): Promise<ScrapeResult> {
      if (!apiKey) {
        return {
          ok: false,
          error:
            "DHL API: missing key (set DHL_API_KEY env var or pass apiKey option)",
        };
      }

      const url = new URL(ENDPOINT);
      url.searchParams.set("trackingNumber", num);
      if (opts.service) url.searchParams.set("service", opts.service);

      let resp: Response;
      try {
        resp = await fetch(url, {
          headers: { "DHL-API-Key": apiKey, Accept: "application/json" },
        });
      } catch (e: any) {
        return { ok: false, error: `DHL API: network error (${e.message})` };
      }

      if (resp.status === 404)
        return { ok: false, error: "DHL: tracking number not found" };
      if (resp.status === 401)
        return { ok: false, error: "DHL API: 401 (invalid or revoked key)" };
      if (resp.status === 429)
        return { ok: false, error: "DHL API: 429 rate limited" };

      let json: any;
      try {
        json = await resp.json();
      } catch {
        return { ok: false, error: `DHL API: invalid JSON (HTTP ${resp.status})` };
      }

      if (!resp.ok) {
        const msg = json?.title || json?.detail || `HTTP ${resp.status}`;
        return { ok: false, error: `DHL API: ${msg}` };
      }

      return parse(json, num, carrierName);
    },

    isExpired: (r) => !r.ok && /401|key|revoked/i.test(r.error || ""),
  };
}
