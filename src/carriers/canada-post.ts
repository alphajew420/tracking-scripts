import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const DETAILS_URL = (n: string) =>
  `https://www.canadapost-postescanada.ca/track-reperage/en/details/${encodeURIComponent(n)}`;

const DETAIL_API = (n: string) =>
  `/track-reperage/rs/track/json/package/${encodeURIComponent(n)}/detail`;

const STATUS_RULES: Array<[Status, RegExp]> = [
  ["delivered", /delivered|livr/i],
  ["exception", /notice|exception|delay|returned|customs|unable|attempt/i],
  ["pickup", /accepted|received by canada post|electronic information submitted|post office/i],
  ["in_transit", /processed|forwarded|arrived|out for delivery|in transit|destination country/i],
];

interface CanadaPostDateTime {
  date?: string;
  time?: string;
  zoneOffset?: string;
}

interface CanadaPostLocation {
  countryCd?: string;
  countryNmEn?: string;
  city?: string;
  regionCd?: string;
}

interface CanadaPostEvent {
  datetime?: CanadaPostDateTime;
  locationAddr?: CanadaPostLocation;
  descEn?: string;
  type?: string;
  cd?: string;
}

interface CanadaPostDetail {
  pin?: string;
  productNmEn?: string;
  delivered?: boolean;
  status?: string;
  finalEvent?: boolean;
  acceptedDate?: string;
  actualDlvryDate?: string;
  events?: CanadaPostEvent[];
  addtnlOrigInfo?: string;
  addtnlDestInfo?: string;
}

function classify(description: string, type?: string): Status {
  if (/delivered/i.test(type ?? "")) return "delivered";
  for (const [status, pattern] of STATUS_RULES) {
    if (pattern.test(description)) return status;
  }
  return "unknown";
}

function formatDateTime(value?: CanadaPostDateTime): string | null {
  if (!value?.date) return null;
  if (!value.time) return value.date;
  return `${value.date}T${value.time}${value.zoneOffset ?? ""}`;
}

function locationText(location?: CanadaPostLocation): string {
  return [
    location?.city,
    location?.regionCd,
    location?.countryNmEn ?? location?.countryCd,
  ].filter(Boolean).join(", ");
}

function normalize(detail: CanadaPostDetail, trackingNumber: string): ScrapeResult {
  if (!detail.pin && !detail.events?.length) {
    return { ok: false, error: "Canada Post: tracking details missing" };
  }

  const events: Event[] = (detail.events ?? []).map((event) => {
    const description = event.descEn ?? event.type ?? "";
    return {
      date: formatDateTime(event.datetime),
      location: locationText(event.locationAddr),
      description,
      status: classify(description, event.type),
    };
  }).filter((event) => event.description);

  return {
    ok: true,
    track: {
      carrier: "canada-post",
      trackingNumber,
      delivered: detail.delivered === true || events.some((event) => event.status === "delivered"),
      events,
      serviceLevel: detail.productNmEn,
      raw: {
        pin: detail.pin,
        status: detail.status,
        finalEvent: detail.finalEvent,
        acceptedDate: detail.acceptedDate,
        actualDlvryDate: detail.actualDlvryDate,
        origin: detail.addtnlOrigInfo,
        destination: detail.addtnlDestInfo,
      },
    },
  };
}

export const canadaPostCarrier: Carrier = {
  name: "canada-post",
  mode: "scraper",
  warmUrl: DETAILS_URL,
  async awaitReady(page, num) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    await page.waitForResponse((response) => response.url().includes(DETAIL_API(num)), {
      timeout: 45000,
    }).catch(() => {});
  },
  async runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
    const raw = await page.evaluate(async (url: string) => {
      const response = await fetch(url, { credentials: "include", redirect: "follow" });
      return { status: response.status, body: await response.text() };
    }, DETAIL_API(num));

    if (raw.status < 200 || raw.status >= 300) {
      return { ok: false, error: `Canada Post HTTP ${raw.status}` };
    }
    if (/Access Forbidden|Please log in|<html/i.test(raw.body)) {
      return { ok: false, error: "Canada Post: detail API session not authorized" };
    }

    try {
      return normalize(JSON.parse(raw.body) as CanadaPostDetail, num);
    } catch {
      return { ok: false, error: "Canada Post: invalid detail JSON" };
    }
  },
  isExpired: (result) =>
    !result.ok && /HTTP 401|HTTP 403|session not authorized|Access Forbidden/i.test(result.error ?? ""),
};
