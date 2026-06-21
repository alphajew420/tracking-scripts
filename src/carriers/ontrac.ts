import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const API_URL = (n: string) => `https://webtrack.ontrac.com/PackageServices/tracking/${encodeURIComponent(n)}`;

const STATUS_RULES: Array<[Status, RegExp]> = [
  ["delivered", /delivered|delivery completed|left at|signed/i],
  ["exception", /exception|delay|attempt|unable|returned|damaged|held|undeliverable/i],
  ["pickup", /manifest|data received|package received|picked up|accepted|shipper/i],
  ["in_transit", /transit|facility|arrived|departed|out for delivery|loaded|sort/i],
];

interface OnTracEvent {
  EventCode?: string;
  Status?: string;
  EventShortDescription?: string;
  EventLongDescription?: string;
  ZonedEventDateTime?: string;
  City?: string | null;
  State?: string | null;
}

interface OnTracPackage {
  number?: string;
  ServiceDescription?: string;
  ExpectedDeliveryDate?: string;
  ExpectedDeliveryDateFormatted?: string;
  UtcDeliveryDateTime?: string;
  Origin?: { City?: string; State?: string; Zip?: string };
  Consignee?: { City?: string; State?: string; Zip?: string };
  Events?: OnTracEvent[];
}

interface OnTracResponse {
  Packages?: OnTracPackage[];
  Message?: string;
}

function classify(description: string, code?: string): Status {
  if (/^(DN|DLVD|OK|FOTO|CL|DW)$/i.test(code ?? "")) return "delivered";
  if (/^(EX|EXRL|XX|NS)$/i.test(code ?? "")) return "exception";
  for (const [status, pattern] of STATUS_RULES) {
    if (pattern.test(description)) return status;
  }
  return "unknown";
}

function locationText(event: OnTracEvent): string {
  return [event.City, event.State].filter(Boolean).join(", ");
}

function normalize(json: OnTracResponse, trackingNumber: string, carrier: "ontrac" | "lasership"): ScrapeResult {
  const pkg = json.Packages?.[0];
  if (!pkg) {
    return { ok: false, error: `OnTrac: ${json.Message ?? "tracking number not found"}` };
  }

  const events: Event[] = (pkg.Events ?? []).map((event) => {
    const short = event.EventShortDescription ?? event.Status ?? "";
    const long = event.EventLongDescription;
    const description = long && !short.includes(long) ? `${short}: ${long}` : short;
    return {
      date: event.ZonedEventDateTime ?? null,
      location: locationText(event),
      description,
      status: classify(description, event.EventCode),
    };
  }).filter((event) => event.description);

  return {
    ok: true,
    track: {
      carrier,
      trackingNumber,
      delivered: events.some((event) => event.status === "delivered"),
      events,
      serviceLevel: pkg.ServiceDescription,
      raw: {
        number: pkg.number,
        expectedDeliveryDate: pkg.ExpectedDeliveryDate ?? pkg.ExpectedDeliveryDateFormatted,
        utcDeliveryDateTime: pkg.UtcDeliveryDateTime,
        origin: pkg.Origin,
        destination: pkg.Consignee,
      },
    },
  };
}

function makeOnTracCarrier(name: "ontrac" | "lasership"): Carrier {
  return {
    name,
    mode: "scraper",
    warmUrl: API_URL,
    async awaitReady(page) {
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
      await page.waitForSelector("body", { timeout: 20000 }).catch(() => {});
    },
    async runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
      const raw = await page.evaluate(async (url: string) => {
        const response = await fetch(url, {
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          redirect: "follow",
        });
        return { status: response.status, body: await response.text() };
      }, API_URL(num));

      if (raw.status === 404) return { ok: false, error: "OnTrac: tracking number not found" };
      if (raw.status < 200 || raw.status >= 300) return { ok: false, error: `OnTrac HTTP ${raw.status}` };

      try {
        return normalize(JSON.parse(raw.body) as OnTracResponse, num, name);
      } catch {
        return { ok: false, error: "OnTrac: invalid tracking JSON" };
      }
    },
    isExpired: (result) =>
      !result.ok && /HTTP 401|HTTP 403|Cloudflare|Access Denied|Forbidden/i.test(result.error ?? ""),
  };
}

export const ontracCarrier = makeOnTracCarrier("ontrac");
export const lasershipCarrier = makeOnTracCarrier("lasership");
