import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status, Track } from "../types.ts";

const API_URL = "https://track.purolator.com/tracking-ext/v1/search";

const STATUS_RULES: Array<[Status, RegExp]> = [
  ["delivered", /delivered|shipment delivered|signed/i],
  ["pickup", /picked up|label|shipment created|created a label/i],
  ["exception", /exception|delay|unable|attempted|returned|address correction|weather|refused/i],
  ["in_transit", /in transit|sort facility|arrived|departed|on vehicle|out for delivery|terminal/i],
];

interface PurolatorLocation {
  city?: string;
  provinceState?: string;
  countryCode?: string;
}

interface PurolatorEvent {
  dateTime?: string;
  description?: string;
  location?: PurolatorLocation;
}

interface PurolatorPackage {
  pin?: string;
  status?: { code?: string; description?: string };
  estimatedDeliveryDate?: string;
  events?: PurolatorEvent[];
  details?: {
    weight?: {
      declaredUnit?: string;
      declaredValue?: number;
    };
    deliveryDetails?: {
      deliveryDateTime?: string;
    };
  };
}

interface PurolatorShipment {
  shipmentPin?: string;
  status?: { code?: string; description?: string };
  pieceTotalCount?: number;
  details?: {
    product?: { description?: string };
    shipper?: PurolatorLocation;
    receiver?: PurolatorLocation;
    weight?: { unit?: string; value?: number };
    references?: string[];
  };
  package?: PurolatorPackage[];
}

interface PurolatorSearchResult {
  trackingId?: string;
  status?: string;
  shipmentIndex?: number;
  packageIndex?: number;
}

interface PurolatorResponse {
  searchResult?: PurolatorSearchResult[];
  shipment?: PurolatorShipment[];
}

const captures = new Map<string, { status: number; json: PurolatorResponse }>();

function trackUrl(num: string): string {
  return `https://www.purolator.com/en/shipping/tracker?pin=${encodeURIComponent(num)}`;
}

function classify(description: string): Status {
  for (const [status, pattern] of STATUS_RULES) {
    if (pattern.test(description)) return status;
  }
  return "unknown";
}

function locationText(location?: PurolatorLocation): string {
  return [location?.city, location?.provinceState, location?.countryCode].filter(Boolean).join(", ");
}

function weightGrams(unit?: string, value?: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const normalized = String(unit ?? "").toLowerCase();
  if (normalized === "lb" || normalized === "lbs") return Math.round(value! * 453.59237);
  if (normalized === "oz") return Math.round(value! * 28.349523125);
  if (normalized === "kg") return Math.round(value! * 1000);
  if (normalized === "g") return Math.round(value!);
  return undefined;
}

function normalize(json: PurolatorResponse, trackingNumber: string): ScrapeResult {
  const match = json.searchResult?.find((result) => result.trackingId === trackingNumber) ?? json.searchResult?.[0];
  if (!match || match.status !== "FOUND") {
    return { ok: false, error: `Purolator: ${match?.status ?? "tracking number not found"}` };
  }

  const shipment = json.shipment?.[match.shipmentIndex ?? 0];
  const pkg = shipment?.package?.[match.packageIndex ?? 0] ??
    shipment?.package?.find((item) => item.pin === trackingNumber) ??
    shipment?.package?.[0];

  if (!shipment || !pkg) {
    return { ok: false, error: "Purolator: shipment payload missing package details" };
  }

  const events: Event[] = (pkg.events ?? []).map((event) => {
    const description = event.description ?? "";
    return {
      date: event.dateTime ?? null,
      location: locationText(event.location),
      description,
      status: classify(description),
    };
  }).filter((event) => event.description);

  const track: Track = {
    carrier: "purolator",
    trackingNumber,
    delivered:
      pkg.status?.code === "DEL" ||
      shipment.status?.code === "DEL" ||
      events.some((event) => event.status === "delivered"),
    events,
    serviceLevel: shipment.details?.product?.description,
    weightGrams:
      weightGrams(pkg.details?.weight?.declaredUnit, pkg.details?.weight?.declaredValue) ??
      weightGrams(shipment.details?.weight?.unit, shipment.details?.weight?.value),
    raw: {
      shipmentPin: shipment.shipmentPin,
      packagePin: pkg.pin,
      pieceTotalCount: shipment.pieceTotalCount,
      estimatedDeliveryDate: pkg.estimatedDeliveryDate,
      deliveryDateTime: pkg.details?.deliveryDetails?.deliveryDateTime,
      origin: shipment.details?.shipper,
      destination: shipment.details?.receiver,
      references: shipment.details?.references,
    },
  };

  return { ok: true, track };
}

async function waitForCapture(num: string, timeoutMs = 8000): Promise<{ status: number; json: PurolatorResponse } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = captures.get(num);
    if (captured) return captured;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return captures.get(num) ?? null;
}

async function submitTrackingSearch(page: QueryCtx["page"], num: string): Promise<void> {
  const multiInput = page.locator("#tracker-search-multipin");
  const singleInput = page.locator("#tracker-search-singlepin");
  const multiVisible = await multiInput.isVisible({ timeout: 5000 }).catch(() => false);

  if (multiVisible) {
    await multiInput.fill(num);
    await page.click(".multi-pin-input .tracker-search");
    return;
  }

  await singleInput.fill(num);
  await page.click(".single-pin-input .tracker-search");
}

export const purolatorCarrier: Carrier = {
  name: "purolator",
  mode: "scraper",
  warmUrl: trackUrl,
  setupPage(page) {
    page.on("response", async (response) => {
      if (response.url() !== API_URL || response.status() !== 200) return;
      try {
        const postData = response.request().postData();
        const body = postData ? JSON.parse(postData) as { search?: Array<{ trackingId?: string }> } : {};
        const trackingId = body.search?.[0]?.trackingId;
        if (!trackingId) return;
        captures.set(trackingId, {
          status: response.status(),
          json: await response.json() as PurolatorResponse,
        });
      } catch {
        // The page will still surface a normalized error if capture fails.
      }
    });
  },
  async awaitReady(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 90000 }).catch(() => {});
    await page.waitForResponse((response) => response.url() === API_URL, { timeout: 45000 }).catch(() => {});
  },
  async runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
    let captured = await waitForCapture(num, 2000);
    if (!captured) {
      await Promise.all([
        page.waitForResponse((response) => {
          if (response.url() !== API_URL) return false;
          try {
            const body = response.request().postDataJSON() as { search?: Array<{ trackingId?: string }> };
            return body.search?.[0]?.trackingId === num;
          } catch {
            return false;
          }
        }, { timeout: 45000 }).catch(() => null),
        submitTrackingSearch(page, num),
      ]);
      captured = await waitForCapture(num);
    }
    if (!captured) return { ok: false, error: "Purolator: tracking response not captured" };
    if (captured.status < 200 || captured.status >= 300) {
      return { ok: false, error: `Purolator HTTP ${captured.status}` };
    }
    return normalize(captured.json, num);
  },
  isExpired: (result) =>
    !result.ok && /HTTP 401|HTTP 403|Cloudflare|security verification|WAF|blocked/i.test(result.error ?? ""),
};
