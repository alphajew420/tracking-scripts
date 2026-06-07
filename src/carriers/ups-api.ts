import type { ApiCarrier } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const OAUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const TRACK_URL = (n: string) =>
  `https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(n)}`;

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /delivered/i],
  ["pickup", /pickup|access point|hold for pickup/i],
  ["exception", /exception|undeliverable|returned/i],
  [
    "in_transit",
    /in transit|out for delivery|departed|arrived|origin scan|loaded|sorted|on the way/i,
  ],
];
function classify(desc: string): Status {
  for (const [s, re] of STATUS_KEYWORDS) if (re.test(desc)) return s;
  return "unknown";
}

export interface UpsApiOptions {
  clientId?: string;
  clientSecret?: string;
}

function parseDate(d: string | undefined, t: string | undefined): string | null {
  if (!d) return null;
  // UPS returns YYYYMMDD and HHmmss separately.
  if (/^\d{8}$/.test(d)) {
    const yyyy = d.slice(0, 4);
    const mm = d.slice(4, 6);
    const dd = d.slice(6, 8);
    if (t && /^\d{6}$/.test(t)) {
      return `${yyyy}-${mm}-${dd}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
    }
    return `${yyyy}-${mm}-${dd}`;
  }
  return d;
}

function parse(json: any, num: string): ScrapeResult {
  const shipment = json?.trackResponse?.shipment?.[0];
  if (!shipment) return { ok: false, error: "UPS API: no shipment data" };

  const pkg = shipment.package?.[0];
  if (!pkg) return { ok: false, error: "UPS API: no package data" };

  const activities: any[] = Array.isArray(pkg.activity) ? pkg.activity : [];
  const events: Event[] = activities.map((a) => {
    const desc = a.status?.description ?? a.status?.code ?? "";
    const loc = a.location?.address;
    const locStr = loc
      ? [loc.city, loc.stateProvince, loc.countryCode].filter(Boolean).join(", ")
      : "";
    return {
      date: parseDate(a.date, a.time),
      location: locStr,
      description: String(desc).trim(),
      status: classify(String(desc)),
    };
  });

  // Richer fields. The UPS schema buries these in different places; we
  // pluck and normalize. All of these are optional — missing is fine, we
  // just don't save what isn't there.
  const shipTo = pkg.shipTo?.address;
  const shippingAddress = shipTo ? {
    line1: shipTo.addressLine1 ?? shipTo.addressLine?.[0],
    line2: shipTo.addressLine2 ?? shipTo.addressLine?.[1],
    city: shipTo.city,
    region: shipTo.stateProvince,
    postalCode: shipTo.postalCode,
    country: shipTo.countryCode,
  } : undefined;

  // Weight: UPS returns lbs by default; convert to grams.
  const weight = pkg.packageWeight;
  let weightGrams: number | undefined;
  if (weight?.weight && weight?.unitOfMeasurement?.code) {
    const value = Number(weight.weight);
    const unit = String(weight.unitOfMeasurement.code).toUpperCase();
    if (!Number.isNaN(value)) {
      if (unit === "LBS") weightGrams = Math.round(value * 453.592);
      else if (unit === "OZS") weightGrams = Math.round(value * 28.3495);
      else if (unit === "KGS") weightGrams = Math.round(value * 1000);
      else if (unit === "GMS") weightGrams = Math.round(value);
    }
  }

  // Service description: "UPS Ground", "UPS 2nd Day Air", etc.
  const serviceLevel = shipment.service?.description ?? pkg.service?.description;

  // Signature: only present after delivery.
  const signedBy = pkg.deliveryInformation?.receivedBy;

  return {
    ok: true,
    track: {
      carrier: "ups",
      trackingNumber: num,
      delivered: events.some((e) => e.status === "delivered"),
      events,
      shippingAddress,
      weightGrams,
      serviceLevel: typeof serviceLevel === "string" ? serviceLevel : undefined,
      signedBy: typeof signedBy === "string" ? signedBy : undefined,
      raw: json,
    },
  };
}

export function createUpsApiCarrier(opts: UpsApiOptions = {}): ApiCarrier {
  const clientId = opts.clientId ?? process.env.UPS_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.UPS_CLIENT_SECRET;

  // Cached token; refresh 30s before expiry.
  let token: { value: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - 30_000) return token.value;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const resp = await fetch(OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`OAuth ${resp.status} ${txt.slice(0, 200)}`);
    }
    const j: any = await resp.json();
    if (!j.access_token) throw new Error("OAuth returned no access_token");
    token = {
      value: j.access_token,
      expiresAt: Date.now() + Number(j.expires_in ?? 14400) * 1000,
    };
    return token.value;
  }

  return {
    name: "ups",
    mode: "api",

    async runQuery(num: string): Promise<ScrapeResult> {
      if (!clientId || !clientSecret) {
        return {
          ok: false,
          error:
            "UPS API: missing credentials (set UPS_CLIENT_ID + UPS_CLIENT_SECRET)",
        };
      }

      let bearer: string;
      try {
        bearer = await getToken();
      } catch (e: any) {
        return { ok: false, error: `UPS API: auth failed (${e.message})` };
      }

      let resp: Response;
      try {
        resp = await fetch(TRACK_URL(num), {
          headers: {
            Authorization: `Bearer ${bearer}`,
            transId: crypto.randomUUID(),
            transactionSrc: "tracker-ts",
            Accept: "application/json",
          },
        });
      } catch (e: any) {
        return { ok: false, error: `UPS API: network error (${e.message})` };
      }

      if (resp.status === 401) {
        token = null;
        return { ok: false, error: "UPS API: 401 (token rejected)" };
      }
      if (resp.status === 404)
        return { ok: false, error: "UPS: tracking number not found" };
      if (resp.status === 429)
        return { ok: false, error: "UPS API: 429 rate limited" };

      let json: any;
      try { json = await resp.json(); } catch {
        return { ok: false, error: `UPS API: invalid JSON (HTTP ${resp.status})` };
      }

      if (!resp.ok) {
        const err =
          json?.response?.errors?.[0]?.message ||
          json?.errors?.[0]?.message ||
          `HTTP ${resp.status}`;
        return { ok: false, error: `UPS API: ${err}` };
      }

      return parse(json, num);
    },

    isExpired: (r) => !r.ok && /401|token/i.test(r.error || ""),
  };
}
