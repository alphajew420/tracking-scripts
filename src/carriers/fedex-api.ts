import type { ApiCarrier } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const OAUTH_URL = "https://apis.fedex.com/oauth/token";
const TRACK_URL = "https://apis.fedex.com/track/v1/trackingnumbers";

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /delivered/i],
  ["pickup", /pickup|hold at location/i],
  ["exception", /exception|delay|return/i],
  ["in_transit", /in transit|on fedex vehicle|departed|arrived|picked up|tendered/i],
];
function classify(desc: string): Status {
  for (const [s, re] of STATUS_KEYWORDS) if (re.test(desc)) return s;
  return "unknown";
}

export interface FedexApiOptions {
  clientId?: string;
  clientSecret?: string;
}

function parse(json: any, num: string): ScrapeResult {
  const result =
    json?.output?.completeTrackResults?.[0]?.trackResults?.[0] ??
    json?.output?.packages?.[0];
  if (!result) return { ok: false, error: "FedEx API: no track result" };

  // Errors / not-found come back with an error block.
  const error = result?.error;
  if (error) {
    return {
      ok: false,
      error: `FedEx: ${error.message || error.code || "tracking error"}`,
    };
  }

  const scanEvents: any[] = result.scanEvents || [];
  const events: Event[] = scanEvents.map((e) => {
    const desc = e.eventDescription || e.derivedStatus || "";
    const loc = e.scanLocation;
    const locStr = loc
      ? [loc.city, loc.stateOrProvinceCode, loc.countryCode]
          .filter(Boolean)
          .join(", ")
      : "";
    return {
      date: e.date ?? null,
      location: locStr,
      description: String(desc).trim(),
      status: classify(String(desc)),
    };
  });

  const delivered =
    events.some((e) => e.status === "delivered") ||
    result.latestStatusDetail?.code === "DL";

  return {
    ok: true,
    track: {
      carrier: "fedex",
      trackingNumber: num,
      delivered,
      recipient:
        result.deliveryDetails?.receivedByName ||
        result.deliveryDetails?.signedByName,
      events,
    },
  };
}

export function createFedexApiCarrier(opts: FedexApiOptions = {}): ApiCarrier {
  const clientId = opts.clientId ?? process.env.FEDEX_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.FEDEX_CLIENT_SECRET;

  let token: { value: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - 30_000) return token.value;
    const resp = await fetch(OAUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId!,
        client_secret: clientSecret!,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`OAuth ${resp.status} ${txt.slice(0, 200)}`);
    }
    const j: any = await resp.json();
    if (!j.access_token) throw new Error("OAuth returned no access_token");
    token = {
      value: j.access_token,
      expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000,
    };
    return token.value;
  }

  return {
    name: "fedex",
    mode: "api",

    async runQuery(num: string): Promise<ScrapeResult> {
      if (!clientId || !clientSecret) {
        return {
          ok: false,
          error:
            "FedEx API: missing credentials (set FEDEX_CLIENT_ID + FEDEX_CLIENT_SECRET)",
        };
      }

      let bearer: string;
      try {
        bearer = await getToken();
      } catch (e: any) {
        return { ok: false, error: `FedEx API: auth failed (${e.message})` };
      }

      let resp: Response;
      try {
        resp = await fetch(TRACK_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
            "X-locale": "en_US",
          },
          body: JSON.stringify({
            trackingInfo: [{ trackingNumberInfo: { trackingNumber: num } }],
            includeDetailedScans: true,
          }),
        });
      } catch (e: any) {
        return { ok: false, error: `FedEx API: network error (${e.message})` };
      }

      if (resp.status === 401) {
        token = null;
        return { ok: false, error: "FedEx API: 401 (token rejected)" };
      }
      if (resp.status === 429)
        return { ok: false, error: "FedEx API: 429 rate limited" };

      let json: any;
      try { json = await resp.json(); } catch {
        return { ok: false, error: `FedEx API: invalid JSON (HTTP ${resp.status})` };
      }

      if (!resp.ok) {
        const err =
          json?.errors?.[0]?.message || `HTTP ${resp.status}`;
        return { ok: false, error: `FedEx API: ${err}` };
      }

      return parse(json, num);
    },

    isExpired: (r) => !r.ok && /401|token/i.test(r.error || ""),
  };
}
