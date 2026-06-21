import type { Page } from "patchright";
import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

type Country = "se" | "dk";

const POSTNORD_CLIENT_ID = process.env.POSTNORD_CLIENT_ID ?? "";
const POSTNORD_API_KEY = process.env.POSTNORD_API_KEY ?? "";
const POSTNORD_WEB_BAP_KEY = process.env.POSTNORD_WEB_BAP_KEY ?? "web-tracking-sc";

const STATUS_RULES: Array<[Status, RegExp]> = [
  ["delivered", /delivered|levererad|utlevererad|leveret|udleveret|signed/i],
  ["exception", /exception|delay|failed|returned|unable|customs|held|retur|stopped/i],
  ["pickup", /pickup|ready to collect|available for collection|inlämnad|mottagen|indleveret|modtaget/i],
  ["in_transit", /in transit|processed|arrived|departed|out for delivery|sort|transport|en route|ankommit|ankommet/i],
];

function classify(description: string, code?: unknown): Status {
  const normalizedCode = String(code ?? "").toUpperCase();
  if (["80", "88", "DELIVERED"].includes(normalizedCode)) return "delivered";
  if (/^(90|91|92|EXCEPTION|STOPPED)/.test(normalizedCode)) return "exception";
  for (const [status, pattern] of STATUS_RULES) {
    if (pattern.test(description)) return status;
  }
  return "unknown";
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function locationText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return [
    value.displayName,
    value.name,
    value.city,
    value.locationName,
    value.postalCode,
    value.country,
  ].filter(Boolean).map(String).join(", ");
}

function collectEventCandidates(value: any, out: any[] = []): any[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectEventCandidates(item, out);
    return out;
  }

  if (
    "eventTime" in value ||
    "eventDateTime" in value ||
    "eventCode" in value ||
    "eventDescription" in value ||
    "eventDescriptionText" in value
  ) {
    out.push(value);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectEventCandidates(child, out);
  }
  return out;
}

function eventFrom(raw: any): Event | null {
  const description = firstText(
    raw?.eventDescriptionText,
    raw?.eventDescription,
    raw?.description,
    raw?.statusText,
    raw?.status,
  );
  if (!description) return null;

  return {
    date: firstText(raw?.eventTime, raw?.eventDateTime, raw?.dateTime, raw?.date) || null,
    location: locationText(raw?.location) || firstText(raw?.locationName, raw?.city),
    description,
    status: classify(description, raw?.eventCode ?? raw?.statusCode),
  };
}

function buildResult(carrier: string, status: number, json: any, num: string): ScrapeResult {
  if (status === 401 || status === 403) {
    return { ok: false, error: `${carrier}: HTTP ${status} (challenge or API key required)` };
  }
  if (status < 200 || status >= 300) return { ok: false, error: `${carrier}: HTTP ${status}` };
  if (!json) return { ok: false, error: `${carrier}: empty response` };

  const events = collectEventCandidates(json)
    .map(eventFrom)
    .filter((event): event is Event => event != null);

  if (events.length === 0) {
    const message = firstText(
      json?.error?.message,
      json?.message,
      json?.TrackingInformationResponse?.error?.message,
    );
    return { ok: false, error: `${carrier}: ${message || "no tracking events returned"}` };
  }

  return {
    ok: true,
    track: {
      carrier,
      trackingNumber: num,
      delivered: events.some((event) => event.status === "delivered"),
      events,
    },
  };
}

async function fetchJsonFromPage(
  page: Page,
  url: string,
  headers: Record<string, string> = {},
  proofSeed?: string,
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ url, headers, proofSeed }) => {
      const requestHeaders = { ...headers };
      if (proofSeed && requestHeaders["x-bap-key"] && !requestHeaders["X-CustomHeader"]) {
        const seed = proofSeed.split("?")[0]!.replace(/[^A-Za-z0-9]/g, "");
        let solved = false;
        for (let i = 0; i < 100000; i += 1) {
          const nonce = window.crypto.randomUUID();
          const bytes = new TextEncoder().encode(seed + nonce);
          const digest = await window.crypto.subtle.digest("SHA-512", bytes);
          const digestBytes = new Uint8Array(digest);
          if (digestBytes[0] === 0) {
            requestHeaders["X-CustomHeader"] =
              btoa(String.fromCharCode(...digestBytes) + "--" + nonce);
            solved = true;
            break;
          }
        }
        if (!solved) throw new Error("PostNord proof header failed");
      }
      const response = await fetch(url, {
        credentials: "omit",
        redirect: "follow",
        headers: {
          Accept: "application/json, text/plain, */*",
          ...requestHeaders,
        },
      });
      return { status: response.status, body: await response.text() };
    },
    { url, headers, proofSeed },
  );
}

function apiUrls(num: string): string[] {
  const params = new URLSearchParams({ id: num, locale: "en" });
  const trackingWebParams = new URLSearchParams({
    shipmentId: num,
    locale: "en",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });
  if (POSTNORD_API_KEY) params.set("apikey", POSTNORD_API_KEY);

  const urls = [
    `https://api2.postnord.com/rest/shipment/v1/trackingweb/shipmentInformation?${trackingWebParams.toString()}`,
  ];
  if (!POSTNORD_API_KEY) return urls;
  return [
    ...urls,
    `https://api2.postnord.com/rest/shipment/v7/trackandtrace/findByIdentifier.json?${params.toString()}`,
    `https://api2.postnord.com/rest/shipment/v5/trackandtrace/findByIdentifier.json?${params.toString()}`,
    `https://api2.postnord.com/rest/shipment/v2/trackandtrace/findByIdentifier.json?${params.toString()}`,
  ];
}

async function submitFromWarmPage(page: Page, num: string): Promise<void> {
  await page.evaluate((trackingNumber) => {
    const candidates = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    const input =
      candidates.find((element) =>
        /shipment|tracking|parcel|search|id|trace/i.test(
          [element.id, element.name, element.placeholder, element.getAttribute("aria-label")]
            .filter(Boolean)
            .join(" "),
        ),
      ) ?? candidates.find((element) => element.type !== "hidden");
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, trackingNumber);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
    const button =
      buttons.find((element) => /track|trace|search|sök|spåra/i.test(element.innerText)) ??
      buttons.find((element) => element.type === "submit");
    button?.click();
  }, num).catch(() => {});
}

export function createPostNordCarrier(country: Country): Carrier {
  const carrier = country === "se" ? "postnord-se" : "postnord-dk";
  const warmBase = "https://tracking.postnord.com/en/tracking";
  let captured: { num: string | null; status: number; json: any } | null = null;
  let requestFailure: string | null = null;

  function capturedResult(num: string): ScrapeResult | null {
    const snapshot = captured;
    if (!snapshot) return null;
    if (snapshot.num && snapshot.num !== num) return null;
    const result = buildResult(carrier, snapshot.status, snapshot.json, num);
    return result.ok ? result : null;
  }

  function capturedError(num: string): string | null {
    const snapshot = captured;
    if (!snapshot) return null;
    if (snapshot.num && snapshot.num !== num) return null;
    return buildResult(carrier, snapshot.status, snapshot.json, num).error ?? null;
  }

  return {
    name: carrier,
    mode: "scraper",
    warmUrl: (num) => `${warmBase}?id=${encodeURIComponent(num)}`,
    setupPage(page) {
      captured = null;
      requestFailure = null;
      page.on("requestfailed", (request) => {
        const url = request.url();
        if (!/postnord|trackandtrace|findByIdentifier|shipment/i.test(url)) return;
        requestFailure = `${request.method()} ${url}: ${request.failure()?.errorText ?? "request failed"}`;
      });
      page.on("response", async (response) => {
        const url = response.url();
        if (!/postnord|trackandtrace|findByIdentifier|shipment/i.test(url)) return;
        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("json")) return;
        try {
          const json = await response.json();
          const parsedUrl = new URL(url);
          captured = {
            num:
              parsedUrl.searchParams.get("id") ??
              parsedUrl.searchParams.get("shipmentId") ??
              parsedUrl.searchParams.get("itemNumber"),
            status: response.status(),
            json,
          };
        } catch {
          // Query fallback handles parse failures.
        }
      });
    },
    async awaitReady(page) {
      await page.waitForSelector("body", { timeout: 20000 });
      await page
        .waitForResponse(
          (response) => response.url().includes("/rest/shipment/v1/trackingweb/shipmentInformation"),
          { timeout: Number(process.env.POSTNORD_READY_TIMEOUT_MS ?? 25000) },
        )
        .catch(() => {});
      await page.waitForTimeout(Number(process.env.POSTNORD_WARM_SETTLE_MS ?? 1500));
      await submitFromWarmPage(page, new URL(page.url()).searchParams.get("id") ?? "");
    },
    async runQuery(ctx: QueryCtx, num: string): Promise<ScrapeResult> {
      const warmCaptured = capturedResult(num);
      if (warmCaptured) return warmCaptured;

      const pageText = await ctx.page
        .evaluate(() => document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "")
        .catch(() => "");
      if (/verifying you are human|security service|cloudflare|just a moment/i.test(pageText)) {
        return { ok: false, error: `${carrier}: Cloudflare challenge not solved in browser sidecar` };
      }

      captured = null;
      requestFailure = null;
      await submitFromWarmPage(ctx.page, num);
      await ctx.page
        .waitForResponse(
          (response) => /postnord|trackandtrace|findByIdentifier|shipment/i.test(response.url()),
          { timeout: Number(process.env.POSTNORD_READY_TIMEOUT_MS ?? 25000) },
        )
        .catch(() => {});
      const firstPartyCaptured = capturedResult(num);
      if (firstPartyCaptured) return firstPartyCaptured;
      const firstPartyError = capturedError(num);

      const headers: Record<string, string> = POSTNORD_CLIENT_ID
        ? { "X-IBM-Client-Id": POSTNORD_CLIENT_ID }
        : { "x-bap-key": POSTNORD_WEB_BAP_KEY };
      let lastError = firstPartyError ?? `${carrier}: no tracking events returned`;
      let explicitFetchAttempted = false;
      for (const url of apiUrls(num)) {
        try {
          explicitFetchAttempted = true;
          const raw = await fetchJsonFromPage(ctx.page, url, headers, num);
          let json: any = null;
          try {
            json = JSON.parse(raw.body);
          } catch {
            json = { message: raw.body.slice(0, 240) };
          }
          const result = buildResult(carrier, raw.status, json, num);
          if (result.ok) return result;
          lastError = result.error ?? lastError;
          if (!/HTTP 404|no tracking events|Missing API Key/i.test(lastError)) break;
        } catch (error) {
          lastError = `${carrier}: browser fetch failed (${error instanceof Error ? error.message : String(error)})`;
          continue;
        }
      }

      return {
        ok: false,
        error: explicitFetchAttempted
          ? lastError
          : firstPartyError ?? (requestFailure ? `${carrier}: first-party request failed (${requestFailure})` : lastError),
      };
    },
    isExpired: (result) => !result.ok && /403|challenge|cloudflare|captcha/i.test(result.error ?? ""),
  };
}

export const postNordSeCarrier = createPostNordCarrier("se");
export const postNordDkCarrier = createPostNordCarrier("dk");
