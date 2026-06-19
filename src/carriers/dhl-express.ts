import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const URL_FOR = (n: string) =>
  `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}&submit=1`;
const API_URL = (n: string) =>
  `https://www.dhl.com/utapi?trackingNumber=${encodeURIComponent(n)}&language=en&requesterCountryCode=US&source=tt`;

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

function statusFrom(code: unknown, description: string): Status {
  const normalized = String(code ?? "").toLowerCase();
  if (normalized === "delivered") return "delivered";
  if (normalized === "transit") return "in_transit";
  if (/exception|failure|returned|delay/i.test(normalized)) return "exception";
  return classify(description);
}

function locationText(location: any): string {
  const address = location?.address ?? location ?? {};
  return [
    address.addressLocality,
    address.postalCode,
    address.countryCode,
  ].filter(Boolean).join(", ");
}

function weightGrams(weight: any): number | undefined {
  const value = Number(weight?.value);
  if (!Number.isFinite(value)) return undefined;
  const unit = String(weight?.unitText ?? "").toLowerCase();
  if (unit === "kg" || unit === "kgm") return Math.round(value * 1000);
  if (unit === "g" || unit === "grm") return Math.round(value);
  if (unit === "lb" || unit === "lbs" || unit === "lbr") return Math.round(value * 453.59237);
  return undefined;
}

function buildResult(status: number, json: any, num: string): ScrapeResult {
  if (status === 401 || status === 403) {
    return { ok: false, error: `DHL Express HTTP ${status} (session may have expired)` };
  }
  if (status !== 200 || !json) return { ok: false, error: `DHL Express HTTP ${status}` };

  const shipments: any[] = Array.isArray(json?.shipments) ? json.shipments : [];
  const shipment =
    shipments.find((item) => Array.isArray(item?.events) && item.events.length > 0) ??
    shipments.find((item) => item?.status) ??
    shipments[0];

  if (!shipment) {
    return { ok: false, error: "DHL Express: tracking number not found" };
  }

  const rawEvents: any[] = Array.isArray(shipment.events) && shipment.events.length > 0
    ? shipment.events
    : shipment.status
      ? [shipment.status]
      : [];
  const events: Event[] = rawEvents
    .map((event) => {
      const description = String(event.description ?? event.statusCode ?? event.status ?? "").trim();
      return {
        date: event.timestamp ?? event.date ?? null,
        location: locationText(event.location),
        description,
        status: statusFrom(event.statusCode, description),
      };
    })
    .filter((event) => event.description);

  const details = shipment.details ?? {};
  const delivered =
    String(shipment.status?.statusCode ?? "").toLowerCase() === "delivered" ||
    events.some((event) => event.status === "delivered");

  return {
    ok: true,
    track: {
      carrier: "dhl-express",
      trackingNumber: num,
      delivered,
      events,
      serviceLevel: details.product?.productName,
      weightGrams: weightGrams(details.weight),
    },
  };
}

async function runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
  const raw = await page.evaluate(async (url: string) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        credentials: "include",
        signal: controller.signal,
        headers: { Accept: "application/json, text/plain, */*" },
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body: await response.text(),
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }, API_URL(num));

  if (raw.status !== 200) {
    return { ok: false, error: `DHL Express HTTP ${raw.status}` };
  }
  if (raw.body.includes("Access Denied")) {
    return { ok: false, error: "DHL Express: Access Denied (session expired)" };
  }

  if (!raw.contentType.includes("json")) {
    return { ok: false, error: "DHL Express: session expired (got HTML)" };
  }

  let json: any = null;
  try { json = JSON.parse(raw.body); } catch {
    return { ok: false, error: "DHL Express: invalid JSON" };
  }
  return buildResult(raw.status, json, num);
}

export function createDhlExpressCarrier(): Carrier {
  let warmJson: any = null;
  let warmStatus: number | null = null;
  let warmTrackingNumber: string | null = null;
  let warmUsed = false;

  return {
    name: "dhl-express",
    mode: "scraper",
    warmUrl: URL_FOR,
    setupPage(page) {
      warmJson = null;
      warmStatus = null;
      warmTrackingNumber = null;
      warmUsed = false;
      page.on("response", async (response) => {
        if (!response.url().includes("/utapi?trackingNumber=")) return;
        if (response.status() !== 200) return;
        const ct = response.headers()["content-type"] ?? "";
        if (!ct.includes("json")) return;
        try {
          const url = new URL(response.url());
          warmTrackingNumber = url.searchParams.get("trackingNumber");
          warmStatus = response.status();
          warmJson = await response.json();
        } catch {
          // Ignore malformed warm capture; runQuery can still fetch directly.
        }
      });
    },
    async awaitReady(page) {
      await page
        .waitForResponse(
          (response) =>
            response.url().includes("/utapi?trackingNumber=") &&
            response.status() === 200 &&
            (response.headers()["content-type"] ?? "").includes("json"),
          { timeout: Number(process.env.DHL_EXPRESS_READY_TIMEOUT_MS ?? 45000) },
        )
        .catch(() => {});
    },
    async runQuery(ctx, num) {
      if (!warmUsed && warmJson && warmTrackingNumber === num) {
        warmUsed = true;
        return buildResult(warmStatus ?? 200, warmJson, num);
      }
      return runQuery(ctx, num);
    },
    isExpired: (result) =>
      !result.ok && /HTTP 401|HTTP 403|HTTP 428|Access Denied|session expired/i.test(result.error ?? ""),
  };
}

export const dhlExpressCarrier: Carrier = createDhlExpressCarrier();
