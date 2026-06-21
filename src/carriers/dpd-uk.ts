import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status, Track } from "../types.ts";

const TRACK_ENTRY_URL = "https://www.dpd.co.uk/apps/tracking/";
const PARCEL_API_BASE = "https://apis.track.dpd.co.uk/v1/parcels";

const STATUS_RULES: Array<[Status, RegExp]> = [
  ["delivered", /delivered|signed for/i],
  ["pickup", /pickup|collected|collection|local pickup point/i],
  ["exception", /exception|delay|unable|returned|refused|address|issue/i],
  ["in_transit", /transit|depot|hub|arrived|departed|out for delivery|received/i],
];

interface DpdParcelResponse {
  data?: {
    parcelCode?: string;
    parcelNumber?: string;
    trackingStatusCurrent?: string;
    parcelStatusHtml?: string;
    parcelStatusType?: number;
    shipperDetails?: {
      organisation?: string;
      customerDisplayName?: string;
      customerDisplayShortName?: string;
    };
  };
}

interface DpdEventResponse {
  data?: Array<{
    eventDate?: string;
    eventLocation?: string;
    eventText?: string;
  }>;
}

function trackUrl(num: string): string {
  return `${TRACK_ENTRY_URL}?reference=${encodeURIComponent(num)}`;
}

function classify(description: string): Status {
  for (const [status, pattern] of STATUS_RULES) {
    if (pattern.test(description)) return status;
  }
  return "unknown";
}

function parcelKeyFromUrl(url: string): string | null {
  const match = url.match(/\/parcels\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]!) : null;
}

function publicTrackingNumber(parcel: DpdParcelResponse, fallback: string): string {
  return parcel.data?.parcelNumber?.replace(/\s+/g, "") ?? fallback;
}

async function jsonFromPage<T>(ctx: QueryCtx, url: string): Promise<{ status: number; json: T }> {
  return ctx.page.evaluate(
    async (targetUrl) => {
      const response = await fetch(targetUrl, {
        credentials: "include",
        redirect: "follow",
      });
      return {
        status: response.status,
        json: await response.json(),
      };
    },
    url,
  ) as Promise<{ status: number; json: T }>;
}

async function resolveParcelKey(ctx: QueryCtx, num: string): Promise<string | null> {
  const currentKey = parcelKeyFromUrl(ctx.page.url());
  if (currentKey?.startsWith(num)) return currentKey;
  return null;
}

function normalize(
  parcel: DpdParcelResponse,
  eventPayload: DpdEventResponse,
  trackingNumber: string,
): ScrapeResult {
  const events: Event[] = (eventPayload.data ?? [])
    .map((event) => {
      const description = event.eventText ?? "";
      return {
        date: event.eventDate ?? null,
        location: event.eventLocation ?? "",
        description,
        status: classify(description),
      };
    })
    .filter((event) => event.description);

  const currentStatus = parcel.data?.trackingStatusCurrent ?? parcel.data?.parcelStatusHtml ?? "";
  const track: Track = {
    carrier: "dpd-uk",
    trackingNumber: publicTrackingNumber(parcel, trackingNumber),
    delivered:
      /delivered/i.test(currentStatus) ||
      events.some((event) => event.status === "delivered"),
    events,
    raw: {
      parcelCode: parcel.data?.parcelCode,
      parcelNumber: parcel.data?.parcelNumber,
      trackingStatusCurrent: currentStatus,
      parcelStatusType: parcel.data?.parcelStatusType,
      shipper: parcel.data?.shipperDetails,
    },
  };

  return { ok: true, track };
}

export const dpdUkCarrier: Carrier = {
  name: "dpd-uk",
  mode: "scraper",
  warmUrl: trackUrl,
  async awaitReady(page) {
    await page.waitForURL(/track\.dpd\.co\.uk\/parcels\//i, { timeout: 45000 });
  },
  async runQuery(ctx: QueryCtx, num: string): Promise<ScrapeResult> {
    const parcelKey = await resolveParcelKey(ctx, num);
    if (!parcelKey) {
      return {
        ok: false,
        error: "DPD UK: parcel key not found in warmed browser page; open a new session for this tracking number",
      };
    }

    const encodedKey = encodeURIComponent(parcelKey);
    const [parcel, events] = await Promise.all([
      jsonFromPage<DpdParcelResponse>(ctx, `${PARCEL_API_BASE}/${encodedKey}?_=${Date.now()}`),
      jsonFromPage<DpdEventResponse>(ctx, `${PARCEL_API_BASE}/${encodedKey}/parcelevents`),
    ]);

    if (parcel.status < 200 || parcel.status >= 300) {
      return { ok: false, error: `DPD UK parcel HTTP ${parcel.status}` };
    }
    if (events.status < 200 || events.status >= 300) {
      return { ok: false, error: `DPD UK events HTTP ${events.status}` };
    }

    return normalize(parcel.json, events.json, num);
  },
  isExpired: (result) =>
    !result.ok && /HTTP 401|HTTP 403|recaptcha|forbidden|blocked|Failed to fetch/i.test(result.error ?? ""),
};
