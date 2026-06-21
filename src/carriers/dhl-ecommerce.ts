import type { Page } from "patchright";
import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status, Track } from "../types.ts";

const TRACK_URL = (n: string) =>
  `https://webtrack.dhlglobalmail.com/?trackingNumber=${encodeURIComponent(n)}`;
const TRACKING_ENDPOINT = "https://api.dhlecs.com/webtrack/v4/tracking";

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /delivered|delivery complete/i],
  ["pickup", /ready for pickup|available for pickup|pickup/i],
  ["exception", /exception|delay|held|return|failed|undeliverable|insufficient|missent/i],
  ["in_transit", /en route|out for delivery|arrival|arrived|processed|tendered|departed|transit|facility|label created|manifested/i],
];

function classify(desc: string): Status {
  for (const [status, pattern] of STATUS_KEYWORDS) {
    if (pattern.test(desc)) return status;
  }
  return "unknown";
}

function eventDescription(event: any): string {
  return [
    event?.primaryEventDescription,
    event?.secondaryEventDescription,
  ].filter(Boolean).join(" - ").trim();
}

function eventDate(event: any): string | null {
  if (!event?.date) return null;
  if (!event?.time) return String(event.date);
  return `${event.date}T${event.time}${event.timeZone ? ` ${event.timeZone}` : ""}`;
}

function weightGrams(weight: any): number | undefined {
  const value = Number(weight?.value);
  if (!Number.isFinite(value)) return undefined;
  const unit = String(weight?.unitOfMeasure ?? weight?.unit ?? "").toLowerCase();
  if (unit === "lb" || unit === "lbs") return Math.round(value * 453.59237);
  if (unit === "oz") return Math.round(value * 28.349523125);
  if (unit === "kg") return Math.round(value * 1000);
  if (unit === "g") return Math.round(value);
  return undefined;
}

function normalize(json: any, trackingNumber: string): ScrapeResult {
  const packages: any[] = Array.isArray(json?.packages) ? json.packages : [];
  const shipment =
    packages.find((item) => item?.trackedValue === trackingNumber) ??
    packages.find((item) => Array.isArray(item?.events) && item.events.length > 0) ??
    packages[0];

  if (!shipment) {
    return { ok: false, error: "DHL eCommerce: tracking number not found" };
  }

  const events: Event[] = (Array.isArray(shipment.events) ? shipment.events : [])
    .map((event: any) => {
      const description = eventDescription(event);
      return {
        date: eventDate(event),
        location: String(event?.location ?? ""),
        description,
        status: classify(description || String(shipment.status ?? "")),
      };
    })
    .filter((event: Event) => event.description);

  const track: Track = {
    carrier: "dhl-ecommerce",
    trackingNumber,
    delivered:
      String(shipment.status ?? "").toLowerCase() === "delivered" ||
      events.some((event: Event) => event.status === "delivered"),
    events,
    serviceLevel: shipment.productName,
    weightGrams: weightGrams(shipment.weight),
    raw: {
      trackingId: shipment.trackingId,
      tmiUid: shipment.tmiUid,
      packageId: shipment.packageId,
      dhlPackageId: shipment.dhlPackageId,
      deliveryConfirmationNumber: shipment.deliveryConfirmationNumber,
      deliveryServiceProvider: shipment.dspName,
      deliveryServiceProviderUrl: shipment.dspUrl,
      estimatedDeliveryDate: shipment.estimatedDeliveryDate,
      sender: shipment.sender,
      recipient: shipment.recipient,
    },
  };

  return { ok: true, track };
}

export function createDhlEcommerceCarrier(): Carrier {
  let captures = new Map<string, { status: number; json: any }>();

  async function captureResponse(response: Awaited<ReturnType<Page["waitForResponse"]>>): Promise<void> {
    const ct = response.headers()["content-type"] ?? "";
    if (!ct.includes("json")) return;
    const requestBody = response.request().postDataJSON() as { trackedValue?: string };
    const trackedValue = requestBody?.trackedValue;
    if (!trackedValue) return;
    captures.set(trackedValue, {
      status: response.status(),
      json: await response.json(),
    });
  }

  async function waitForTrackingResponse(page: Page, num: string): Promise<boolean> {
    const response = await page
      .waitForResponse(
        (candidate) => {
          if (candidate.url() !== TRACKING_ENDPOINT || candidate.status() !== 200) return false;
          try {
            const requestBody = candidate.request().postDataJSON() as { trackedValue?: string };
            return requestBody?.trackedValue === num;
          } catch {
            return false;
          }
        },
        { timeout: Number(process.env.DHL_ECOMMERCE_READY_TIMEOUT_MS ?? 30000) },
      )
      .catch(() => null);
    if (!response) return false;
    await captureResponse(response);
    return true;
  }

  return {
    name: "dhl-ecommerce",
    mode: "scraper",
    warmUrl: TRACK_URL,
    setupPage() {
      captures = new Map();
    },
    async awaitReady(page, num) {
      await waitForTrackingResponse(page, num);
    },
    async runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
      let captured = captures.get(num);
      if (!captured) {
        await page.fill("#dhl-search-input", num);
        await page.click("button.track-btn");
        await waitForTrackingResponse(page, num);
        captured = captures.get(num);
      }
      if (!captured) return { ok: false, error: "DHL eCommerce: tracking response not captured" };
      if (captured.status < 200 || captured.status >= 300) {
        return { ok: false, error: `DHL eCommerce HTTP ${captured.status}` };
      }
      return normalize(captured.json, num);
    },
    isExpired: (result) =>
      !result.ok && /HTTP 401|HTTP 403|session|blocked|Failed to fetch/i.test(result.error ?? ""),
  };
}

export const dhlEcommerceCarrier = createDhlEcommerceCarrier();
