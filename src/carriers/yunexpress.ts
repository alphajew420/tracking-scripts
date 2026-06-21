import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status, Track } from "../types.ts";

const QUERY_URL = "https://services.yuntrack.com/Track/Query";
const SIGNING_SECRET = "f3c42837e3b46431ddf5d7db7d67017d";

const STATUS_RULES: Array<[Status, RegExp]> = [
  ["delivered", /delivered|signed|delivery complete/i],
  ["exception", /exception|alert|failed|returned|return|delay|customs hold|undeliverable/i],
  ["pickup", /shipment information|received|pickup|accepted|collected/i],
  ["in_transit", /transit|arrived|departed|facility|airport|custom|sort|out for delivery|local carrier/i],
];

interface YunTrackEvent {
  CreatedOn?: string;
  ProcessDate?: string;
  ProcessContent?: string;
  ProcessLocation?: string;
}

interface YunTrackInfo {
  WaybillNumber?: string;
  TrackingNumber?: string;
  CustomerOrderNumber?: string;
  AdditionalNotes?: string;
  DestinationCountryCode?: string;
  OriginCountryCode?: string;
  Weight?: number;
  TrackingStatus?: number;
  EstimatedArrivalDate?: string | null;
  EstimatedDeliveryFromDate?: string | null;
  EstimatedDeliveryToDate?: string | null;
  TrackEventDetails?: YunTrackEvent[];
}

interface YunTrackResult {
  Id?: string;
  Status?: number;
  TrackInfo?: YunTrackInfo;
  TrackData?: {
    TrackStatus?: string;
  };
}

interface YunTrackResponse {
  ResultList?: YunTrackResult[];
  Message?: string;
  Code?: number;
}

interface YunTrackRawResponse {
  status: number;
  body: string;
  bytes: number;
}

function trackUrl(num: string): string {
  return `https://www.yuntrack.com/track/detail?id=${encodeURIComponent(num)}`;
}

function classify(description: string): Status {
  for (const [status, pattern] of STATUS_RULES) {
    if (pattern.test(description)) return status;
  }
  return "unknown";
}

function stripHtml(value?: string): string {
  return String(value ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function responseBytes(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

function normalize(json: YunTrackResponse, trackingNumber: string, queryBytes?: number): ScrapeResult {
  const result =
    json.ResultList?.find((item) => item.TrackInfo?.WaybillNumber === trackingNumber || item.Id === trackingNumber) ??
    json.ResultList?.[0];
  const info = result?.TrackInfo;

  if (!result || !info || !info.WaybillNumber) {
    return { ok: false, error: `YunExpress: ${json.Message ?? "tracking number not found"}` };
  }

  const events: Event[] = (info.TrackEventDetails ?? [])
    .map((event) => {
      const description = event.ProcessContent ?? "";
      return {
        date: event.CreatedOn ?? event.ProcessDate ?? null,
        location: event.ProcessLocation ?? "",
        description,
        status: classify(description),
      };
    })
    .filter((event) => event.description);

  const track: Track = {
    carrier: "yunexpress",
    trackingNumber,
    delivered:
      info.TrackingStatus === 50 ||
      /delivered/i.test(result.TrackData?.TrackStatus ?? "") ||
      events.some((event) => event.status === "delivered"),
    events,
    weightGrams: Number.isFinite(info.Weight) ? Math.round(Number(info.Weight) * 1000) : undefined,
    raw: {
      waybillNumber: info.WaybillNumber,
      lastMileTrackingNumber: info.TrackingNumber,
      customerOrderNumber: info.CustomerOrderNumber,
      originCountryCode: info.OriginCountryCode,
      destinationCountryCode: info.DestinationCountryCode,
      additionalNotes: stripHtml(info.AdditionalNotes),
      estimatedArrivalDate: info.EstimatedArrivalDate,
      estimatedDeliveryFromDate: info.EstimatedDeliveryFromDate,
      estimatedDeliveryToDate: info.EstimatedDeliveryToDate,
      status: result.TrackData?.TrackStatus,
      queryUrl: QUERY_URL,
      queryBytes,
      source: "https://www.yuntrack.com/",
    },
  };

  return { ok: true, track };
}

const captures = new Map<string, YunTrackRawResponse>();

async function captureResponse(response: Awaited<ReturnType<QueryCtx["page"]["waitForResponse"]>>): Promise<void> {
  if (response.url() !== QUERY_URL || response.status() !== 200) return;
  try {
    const body = response.request().postDataJSON() as { NumberList?: string[] };
    const trackingNumber = body.NumberList?.[0];
    if (!trackingNumber) return;
    const responseBody = await response.text();
    captures.set(trackingNumber, {
      status: response.status(),
      body: responseBody,
      bytes: responseBytes(responseBody),
    });
  } catch {
    // A direct signed lookup can still run if app-response capture fails.
  }
}

async function queryYunTrack(ctx: QueryCtx, trackingNumber: string): Promise<YunTrackRawResponse> {
  const queryInPage = new Function(
    "arg",
    `
      const { url, trackingNumber, signingSecret } = arg;
      return (async () => {
        const encoder = new TextEncoder();
        const timestamp = Date.now();
        const numberList = [trackingNumber];
        const message = "Timestamp=" + timestamp + "&NumberList=" + JSON.stringify(numberList);
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(signingSecret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const signatureBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
        const signature = Array.from(signatureBytes)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const response = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "authorization": "Nebula token:",
          },
          body: JSON.stringify({
            NumberList: numberList,
            CaptchaVerification: "",
            Year: 0,
            Timestamp: timestamp,
            Signature: signature,
          }),
        });
        const body = await response.text();
        return { status: response.status, body, bytes: new TextEncoder().encode(body).byteLength };
      })();
    `,
  ) as (
    arg: { url: string; trackingNumber: string; signingSecret: string },
  ) => Promise<YunTrackRawResponse>;

  return ctx.page.evaluate(queryInPage, {
    url: QUERY_URL,
    trackingNumber,
    signingSecret: SIGNING_SECRET,
  });
}

export const yunExpressCarrier: Carrier = {
  name: "yunexpress",
  mode: "scraper",
  warmUrl: trackUrl,
  setupPage(page) {
    captures.clear();
    page.on("response", (response) => {
      void captureResponse(response);
    });
  },
  async awaitReady(page, num) {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    const response = await page
      .waitForResponse((candidate) => {
        if (candidate.url() !== QUERY_URL || candidate.status() !== 200) return false;
        try {
          const body = candidate.request().postDataJSON() as { NumberList?: string[] };
          return body.NumberList?.[0] === num;
        } catch {
          return false;
        }
      }, { timeout: 3000 })
      .catch(() => null);
    if (response) await captureResponse(response);
  },
  async runQuery(ctx, num) {
    const raw = captures.get(num) ?? await queryYunTrack(ctx, num);
    if (raw.status < 200 || raw.status >= 300) {
      return { ok: false, error: `YunExpress HTTP ${raw.status}` };
    }
    return normalize(JSON.parse(raw.body) as YunTrackResponse, num, raw.bytes);
  },
  isExpired: (result) =>
    !result.ok && /HTTP 401|HTTP 403|captcha|verification|blocked|forbidden/i.test(result.error ?? ""),
};
