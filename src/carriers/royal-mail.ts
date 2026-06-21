import type { Page } from "patchright";
import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

// Royal Mail has publicly asked customers to use the legacy portal link while
// the standard tracker is having issues.
const TRACK_URL = "https://www.royalmail.com/portal/rm/track";
const API_BASE = "https://api-web.royalmail.com";
const DEFAULT_CLIENT_ID = "3fadedde9e1872d59642d8f0526632aa";

const STATUS_KEYWORDS: Array<[Status, RegExp]> = [
  ["delivered", /delivered|signed for|proof of delivery/i],
  ["pickup", /ready for collection|available for collection|collect/i],
  ["exception", /unable|attempted|returned|return to sender|failed|problem|delay/i],
  ["in_transit", /in transit|accepted|received|arrived|departed|processed|out for delivery|due to be delivered/i],
];

function classify(description: string, code?: unknown): Status {
  const normalizedCode = String(code ?? "").toUpperCase();
  if (/^EVKS|DELIVERED/.test(normalizedCode)) return "delivered";
  if (/^EVPLA/.test(normalizedCode)) return "pickup";
  if (/^EVKNR|RETURN|EXCEPTION|DELAY/.test(normalizedCode)) return "exception";
  for (const [status, pattern] of STATUS_KEYWORDS) {
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
    value.locationName,
    value.name,
    value.city,
    value.town,
    value.postcode,
    value.postalCode,
    value.country,
  ].filter(Boolean).map(String).join(", ");
}

function eventFrom(raw: any): Event | null {
  const description = firstText(
    raw?.eventName,
    raw?.eventDescription,
    raw?.description,
    raw?.statusDescription,
    raw?.summaryLine,
    raw?.message,
  );
  if (!description) return null;
  return {
    date: firstText(raw?.eventDateTime, raw?.dateTime, raw?.timestamp, raw?.date) || null,
    location: locationText(raw?.location) || firstText(raw?.locationName, raw?.officeName),
    description,
    status: classify(description, raw?.eventCode ?? raw?.statusCode),
  };
}

function collectEventCandidates(value: any, out: any[] = []): any[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectEventCandidates(item, out);
    return out;
  }

  if (
    "eventCode" in value ||
    "eventName" in value ||
    "eventDescription" in value ||
    ("dateTime" in value && "description" in value)
  ) {
    out.push(value);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectEventCandidates(child, out);
  }
  return out;
}

function pickMailPiece(json: any): any {
  if (json?.mailPieces) return Array.isArray(json.mailPieces) ? json.mailPieces[0] : json.mailPieces;
  if (json?.mailPiece) return json.mailPiece;
  if (Array.isArray(json?.data?.mailPieces)) return json.data.mailPieces[0];
  if (json?.data?.mailPieces) return json.data.mailPieces;
  return json;
}

function buildResult(status: number, json: any, num: string): ScrapeResult {
  if (status === 401 || status === 403) {
    return { ok: false, error: `Royal Mail HTTP ${status} (session/captcha required)` };
  }
  if (status !== 200 || !json) return { ok: false, error: `Royal Mail HTTP ${status}` };

  const mailPiece = pickMailPiece(json);
  const rawStatus = firstText(
    mailPiece?.status,
    mailPiece?.summary?.statusCategory,
    mailPiece?.summary?.statusDescription,
    mailPiece?.summaryLine,
    json?.statusDescription,
  );

  const events = collectEventCandidates(mailPiece)
    .map(eventFrom)
    .filter((event): event is Event => event != null);

  if (events.length === 0 && rawStatus) {
    events.push({
      date: firstText(mailPiece?.summary?.eventDateTime, mailPiece?.summary?.dateTime) || null,
      location: locationText(mailPiece?.summary?.location),
      description: rawStatus,
      status: classify(rawStatus, mailPiece?.summary?.statusCode),
    });
  }

  if (events.length === 0) {
    const message = firstText(json?.errorDescription, json?.message, mailPiece?.message);
    return { ok: false, error: `Royal Mail: ${message || "no tracking events returned"}` };
  }

  return {
    ok: true,
    track: {
      carrier: "royal-mail",
      trackingNumber: num,
      delivered: events.some((event) => event.status === "delivered"),
      events,
      serviceLevel: firstText(mailPiece?.summary?.productName, mailPiece?.productName) || undefined,
    },
  };
}

async function readAppConfig(page: Page): Promise<string> {
  const config = await page
    .evaluate(async () => {
      const response = await fetch("/spalp/rml_track_and_trace/json", {
        credentials: "include",
        headers: { Accept: "application/json, text/plain, */*" },
      });
      return response.ok ? response.json() : null;
    })
    .catch(() => null);

  return text(config?.appConfig?.epsApiConfig?.ibmClientId) || DEFAULT_CLIENT_ID;
}

async function submitFromWarmPage(page: Page, num: string): Promise<void> {
  await page.waitForSelector("#barcode-input", { state: "visible", timeout: 15000 });
  await page.locator("#truste-consent-button").click({ force: true }).catch(() => {});
  const input = page.locator("#barcode-input").first();
  await input.click({ force: true }).catch(() => {});
  await input.focus({ timeout: 5000 });

  // Royal Mail's tracker re-renders the input state aggressively, so use the
  // native input setter + synthetic events to keep the React/JS model in sync.
  await input.evaluate((element, value) => {
    const target = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  }, num);
  await page.keyboard.press("Tab").catch(() => {});
  await page.locator("#submit").click({ force: true }).catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
}

async function fetchApi(ctx: QueryCtx, url: string, clientId: string): Promise<{ status: number; body: string }> {
  const timeoutMs = Number(process.env.ROYAL_MAIL_QUERY_TIMEOUT_MS ?? 12000);
  return ctx.page.evaluate(
    ({ targetUrl, clientId, timeoutMs }) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      return fetch(targetUrl, {
        credentials: "include",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "application/json, text/plain, */*",
          "X-IBM-Client-Id": clientId,
        },
      })
        .then(async (response) => ({
          status: response.status,
          body: await response.text(),
        }))
        .finally(() => window.clearTimeout(timer));
    },
    { targetUrl: url, clientId, timeoutMs },
  );
}

async function parseRenderedTrackingPage(page: Page, num: string): Promise<ScrapeResult | null> {
  await submitFromWarmPage(page, num);
  await page.waitForTimeout(Number(process.env.ROYAL_MAIL_RENDER_WAIT_MS ?? 5000));

  const rendered = await page.evaluate(() => {
    const text = document.body?.innerText?.trim().replace(/\s+/g, " ") ?? "";
    const html = document.body?.innerHTML ?? "";
    return { text, html };
  }).catch(() => null);

  if (!rendered?.text) return null;
  if (/access denied|edgesuite|akamai|you don't have permission/i.test(rendered.text)) {
    return { ok: false, error: "Royal Mail: warm page access denied" };
  }
  if (/we're sorry|try again later|technical difficulties/i.test(rendered.text)) {
    return { ok: false, error: "Royal Mail: tracker rendered technical-difficulties page" };
  }
  const noResultMatch = rendered.text.match(
    /sorry,? we're currently unable to confirm the status of your item with reference ([A-Z0-9]+).*?please try again tomorrow|not recognised|couldn't find|not available|pending/i,
  );
  if (noResultMatch) {
    return {
      ok: true,
      track: {
        carrier: "royal-mail",
        trackingNumber: num,
        delivered: false,
        events: [
          {
            date: null,
            location: "",
            description: `Royal Mail could not confirm the status for ${num}`,
            status: "unknown",
          },
        ],
      },
    };
  }

  const deliveredMatch = rendered.text.match(/Your item was delivered(?: on ([^.]+?))?(?:\.| Service used:|$)/i);
  const statusMatch =
    deliveredMatch ??
    rendered.text.match(/(We've got it[^.]*\.|Due to be delivered[^.]*\.|Item received[^.]*\.|Item leaving[^.]*\.|Item arrived[^.]*\.)/i);

  if (!statusMatch) return null;

  const description = statusMatch[0].trim();
  const serviceMatch = rendered.text.match(/Service used:\s*([^.]*)/i);
  const event: Event = {
    date: deliveredMatch?.[1]?.trim() ?? null,
    location: "",
    description,
    status: classify(description),
  };

  return {
    ok: true,
    track: {
      carrier: "royal-mail",
      trackingNumber: num,
      delivered: event.status === "delivered",
      events: [event],
      serviceLevel: serviceMatch?.[1]?.trim() || undefined,
    },
  };
}

export function createRoyalMailCarrier(): Carrier {
  let appClientId = DEFAULT_CLIENT_ID;
  let warmJson: any = null;
  let warmStatus: number | null = null;
  let warmTrackingNumber: string | null = null;
  let warmFailure: string | null = null;
  let warmUsed = false;

  async function driveFirstPartyLookup(page: Page, num: string): Promise<ScrapeResult | null> {
    warmJson = null;
    warmStatus = null;
    warmTrackingNumber = null;
    warmFailure = null;
    await submitFromWarmPage(page, num);
    await page
      .waitForResponse(
        (response) =>
          response.url().includes("api-web.royalmail.com/mailpieces/") &&
          response.status() === 200,
        { timeout: Number(process.env.ROYAL_MAIL_READY_TIMEOUT_MS ?? 25000) },
      )
      .catch(() => {});
    if (warmJson && warmTrackingNumber === num) {
      warmUsed = true;
      return buildResult(warmStatus ?? 200, warmJson, num);
    }
    return null;
  }

  return {
    name: "royal-mail",
    mode: "scraper",
    warmUrl: (num) => `${TRACK_URL}?trackNumber=${encodeURIComponent(num)}`,
    setupPage(page) {
      warmJson = null;
      warmStatus = null;
      warmTrackingNumber = null;
      warmFailure = null;
      warmUsed = false;
      page.on("requestfailed", (request) => {
        const url = request.url();
        if (!url.includes("api-web.royalmail.com/mailpieces/")) return;
        warmFailure = `${request.method()} ${url}: ${request.failure()?.errorText ?? "request failed"}`;
      });
      page.on("response", async (response) => {
        const url = response.url();
        if (!/api-web\.royalmail\.com\/mailpieces\/(?:microsummary\/v1\/summary\/|v3\/)/.test(url)) {
          return;
        }
        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("json")) return;
        try {
          warmStatus = response.status();
          warmJson = await response.json();
          const match = /\/(?:summary\/|v3\/)([^/?]+)/.exec(url);
          warmTrackingNumber = match ? decodeURIComponent(match[1]!) : null;
        } catch {
          // The query path can still perform a bounded fetch if warm capture fails.
        }
      });
    },
    async awaitReady(page, num) {
      appClientId = await readAppConfig(page);
    },
    async runQuery(ctx, num) {
      if (!warmUsed && warmJson && warmTrackingNumber === num) {
        warmUsed = true;
        return buildResult(warmStatus ?? 200, warmJson, num);
      }

      const urls = [
        `${API_BASE}/mailpieces/microsummary/v1/summary/${encodeURIComponent(num)}`,
        `${API_BASE}/mailpieces/v3/${encodeURIComponent(num)}/events`,
      ];

      let lastApiError = "";
      for (const url of urls) {
        try {
          const raw = await fetchApi(ctx, url, appClientId);
          let json: any = null;
          try { json = JSON.parse(raw.body); } catch { /* */ }
          const result = buildResult(raw.status, json, num);
          if (result.ok) return result;
          lastApiError = result.error ?? "";
          if (!/HTTP 404|no tracking events|HTTP 401|HTTP 403/i.test(lastApiError)) break;
        } catch (err) {
          const message = (err instanceof Error ? err.message : String(err))
            .split(/\nCall log:/, 1)[0]!
            .trim();
          if (/Timeout|Request context disposed|Target page/.test(message)) {
            return { ok: false, error: `Royal Mail API request stalled (${message})` };
          }
          lastApiError = `Royal Mail API request failed: ${message}`;
          break;
        }
      }

      const rendered = await parseRenderedTrackingPage(ctx.page, num);
      if (rendered) return rendered;
      return {
        ok: false,
        error: warmFailure
          ? `Royal Mail first-party request failed: ${warmFailure}`
          : lastApiError || "Royal Mail: no tracking events returned",
      };
    },
    isExpired: (result) =>
      !result.ok && /HTTP 401|HTTP 403|captcha|required|Access Denied|stalled/i.test(result.error ?? ""),
  };
}

export const royalMailCarrier: Carrier = createRoyalMailCarrier();
