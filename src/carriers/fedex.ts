import type { Page } from "patchright";
import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const LANDING_URL = "https://www.fedex.com/en-us/tracking.html";
const TRACKING_QUALIFIER = (n: string) =>
  process.env[`FEDEX_TRKQUAL_${n.replace(/\W/g, "_")}`] ?? process.env.FEDEX_TRKQUAL ?? `12030~${n}~FDEG`;
const TRACK_URL = (n: string) => {
  const template = process.env.FEDEX_TRACK_URL_TEMPLATE;
  if (template) return template.replaceAll("{n}", encodeURIComponent(n));

  if (process.env.FEDEX_TRACK_SURFACE === "landing") {
    return LANDING_URL;
  }

  const trkqual = TRACKING_QUALIFIER(n);
  if (trkqual) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}&trkqual=${encodeURIComponent(trkqual)}`;
  }

  return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`;
};
const API_URL = "https://api.fedex.com/track/v2/shipments";
const BROWSER_FETCH_TIMEOUT_MS = () => Number(process.env.FEDEX_BROWSER_FETCH_TIMEOUT_MS ?? 20000);

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildResult(status: number, json: any, num: string): ScrapeResult {
  if (status === 401) return { ok: false, error: "FedEx HTTP 401 (token expired)" };
  if (status !== 200 || !json) return { ok: false, error: `FedEx HTTP ${status}` };

  const pkg =
    json?.output?.completeTrackResults?.[0]?.trackResults?.[0] ||
    json?.output?.packages?.[0] ||
    json?.TrackPackagesResponse?.packageList?.[0];
  if (!pkg) return { ok: false, error: "FedEx: no package data" };
  if (pkg?.error || pkg?.errorList?.length) {
    return {
      ok: false,
      error: `FedEx: ${pkg.errorList?.[0]?.message || pkg.error || "tracking not found"}`,
    };
  }

  const scanEvents: any[] = pkg.scanEvents || pkg.events || pkg.scanEventList || [];
  const events: Event[] = scanEvents
    .map((e) => {
      const desc =
        e.eventDescription || e.derivedStatus || e.statusBarText || e.status || "";
      return {
        date:
          e.date && e.time ? `${e.date} ${e.time}` : e.date ?? e.scanDate ?? null,
        location:
          e.scanLocation ||
          e.scanCity ||
          [e.scanCity, e.scanStateOrProvinceCode].filter(Boolean).join(", ") ||
          "",
        description: String(desc).trim(),
        status: classify(String(desc)),
      };
    })
    .filter((e) => e.description);

  return {
    ok: true,
    track: {
      carrier: "fedex",
      trackingNumber: num,
      delivered: events.some((e) => e.status === "delivered"),
      recipient: pkg.receivedByName || pkg.signedForByName,
      events,
    },
  };
}

async function parseRenderedPage(page: Page, num: string): Promise<ScrapeResult | null> {
  const frameTexts = await Promise.all(
    page.frames().map((frame) =>
      frame.evaluate(() => document.body?.innerText ?? "").catch(() => ""),
    ),
  );
  const parsed = await page.evaluate(
    (trackingNumber) => {
      const text = document.body?.innerText ?? "";
      return { text };
    },
    num,
  );
  const text = [parsed?.text ?? "", ...frameTexts].filter(Boolean).join("\n");
  const parsedResult = await page.evaluate(
    ({ trackingText, trackingNumber }: { trackingText: string; trackingNumber: string }) => {
      const text = trackingText;
    if (!text.includes(trackingNumber)) {
      return null;
    }
    if (/we can.t find that tracking number|tracking number is incorrect/i.test(text)) {
      return null;
    }

    const lines = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const statusLine =
      lines.find((line) =>
        /delivered|out for delivery|on the way|label created|shipment exception|arrived at fedex location/i.test(line),
      ) ??
      "";
    const delivered = /delivered/i.test(statusLine);

    const events: Array<{ date: string | null; location: string; description: string }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!/delivered|out for delivery|on the way|label created|picked up|shipment exception|arrived|departed/i.test(line)) {
        continue;
      }
      const next = lines[i + 1] ?? "";
      const after = lines[i + 2] ?? "";
      const date = /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/.test(next)
        ? next
        : /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/.test(after)
          ? after
        : null;
      const location = /^[A-Z][A-Z .'-]+,\s?[A-Z]{2}(?:\s[A-Z]{2})?$/.test(next) ? next : "";
      events.push({ date, location, description: line });
    }

    const seen = new Set<string>();
    const dedupedEvents = events.filter((event) => {
      if (!event.date && !event.location && /^(on the way|out for delivery)$/i.test(event.description)) {
        return false;
      }
      const key = `${event.date ?? ""}|${event.location}|${event.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (events.length === 0) {
      const summaryLine =
        lines.find((line) => /scheduled delivery date|we have your package|on the way|out for delivery/i.test(line)) ??
        "";
      if (summaryLine) {
        events.push({
          date: null,
          location: "",
          description: summaryLine,
        });
      }
    }

    return {
      delivered,
      events: dedupedEvents.length > 0 ? dedupedEvents : events,
      recipient:
        lines.find((line) => /^signed for by:/i.test(line))?.replace(/^signed for by:\s*/i, "") ??
        undefined,
    };
    },
    { trackingText: text, trackingNumber: num },
  );

  if (!parsedResult || parsedResult.events.length === 0) return null;
  return {
    ok: true,
    track: {
      carrier: "fedex",
      trackingNumber: num,
      delivered: parsedResult.delivered,
      recipient: parsedResult.recipient,
      events: parsedResult.events.map((event) => ({
        date: event.date,
        location: event.location,
        description: event.description,
        status: classify(event.description),
      })),
    },
  };
}

async function navigateAndParse(page: Page, num: string): Promise<ScrapeResult | null> {
  const targetUrl = TRACK_URL(num);
  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.FEDEX_NAVIGATION_TIMEOUT_MS ?? 45000),
    });
  } catch (err) {
    return {
      ok: false,
      error: `FedEx navigation fallback failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await page.waitForTimeout(Number(process.env.FEDEX_RENDER_SETTLE_MS ?? 12000));

  if (page.url().includes("system-error")) {
    return { ok: false, error: "FedEx system-error" };
  }

  const parsed = await parseRenderedPage(page, num);
  if (parsed) return parsed;

  const bodyText = await page
    .evaluate(() => document.body?.innerText ?? "")
    .catch(() => "");
  if (/we can.t find that tracking number|tracking number is incorrect/i.test(bodyText)) {
    return { ok: false, error: "FedEx: tracking number not found" };
  }
  return null;
}

async function clearFedExOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.cookie = "xacc=US; path=/; domain=.fedex.com; max-age=3600; secure";
    document.cookie = "fdx_locale=en_US; path=/; domain=.fedex.com; max-age=86400; secure";
    document.cookie = "fdx_redirect=en-us; path=/; domain=.fedex.com; max-age=86400; secure";
    document.querySelector<HTMLButtonElement>("#accept")?.click();
    document.querySelector<HTMLButtonElement>("#deny")?.click();
  }).catch(() => {});

  const usEnglishChoice = page
    .locator("a:visible, button:visible, [role='button']:visible")
    .filter({ hasText: /United States/i })
    .filter({ hasText: /English/i })
    .first();
  if (await usEnglishChoice.isVisible({ timeout: 2500 }).catch(() => false)) {
    await usEnglishChoice.click({ timeout: 10000, force: true }).catch(() => {});
    await page.waitForTimeout(2500);
  }

  await page.evaluate(() => {
    for (const dialog of Array.from(
      document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
    )) {
      const text = dialog.innerText ?? "";
      if (/choose your location|select the correct location|cookie/i.test(text)) {
        try {
          dialog.close();
        } catch {
          dialog.style.display = "none";
          dialog.setAttribute("aria-hidden", "true");
        }
      }
    }
  }).catch(() => {});
}

/**
 * FedEx flow:
 *  - warm: load the tracking page; during load FedEx fires
 *      POST api.fedex.com/auth/oauth/v2/token → JSON {access_token}
 *    Our setupPage listener captures the bearer token from that response.
 *  - runQuery: POST to /track/v2/shipments with the captured bearer token.
 *    Browser fetch is attempted first; if FedEx blocks that path, fall back
 *    to the warmed request context.
 */
export function createFedexCarrier(): Carrier {
  let bearerToken: string | null = null;
  let bearerTokenResolve: (() => void) | null = null;
  let bearerTokenWait = Promise.resolve();
  const trackResponses = new Map<string, { status: number; json: any }>();

  function resetBearerTokenWait(): void {
    bearerTokenWait = new Promise((resolve) => {
      bearerTokenResolve = resolve;
    });
  }

  function captureBearerToken(token: string): void {
    bearerToken = token;
    bearerTokenResolve?.();
    bearerTokenResolve = null;
  }

  async function awaitBearerToken(timeoutMs: number): Promise<boolean> {
    if (bearerToken) return true;
    await Promise.race([
      bearerTokenWait,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return Boolean(bearerToken);
  }

  resetBearerTokenWait();

  return {
    name: "fedex",
    mode: "scraper",
    keepWarmRouting: true,
    warmUrl: TRACK_URL,

    setupPage(page: Page) {
      bearerToken = null;
      resetBearerTokenWait();
      trackResponses.clear();
      const captureBearerFromHeader = (authHeader: string | undefined): void => {
        if (!authHeader) return;
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (match?.[1]) captureBearerToken(match[1]);
      };
      page.on("request", (req) => {
        const url = req.url();
        if (/api\.fedex\.com\/track\/v2\/shipments/.test(url)) {
          captureBearerFromHeader(req.headers()["authorization"]);
        }
        if (/api\.fedex\.com\/auth\/oauth\/v\d\/token/.test(url)) {
          captureBearerFromHeader(req.headers()["authorization"]);
        }
      });
      page.on("response", async (resp) => {
        const url = resp.url();
        if (/api\.fedex\.com\/auth\/oauth\/v\d\/token/.test(url) && resp.status() === 200) {
          try {
            const json: any = await resp.json();
            if (json?.access_token) captureBearerToken(json.access_token);
          } catch { /* */ }
          return;
        }
        if (!/api\.fedex\.com\/track\/v2\/shipments/.test(url)) return;
        try {
          const postData = resp.request().postData();
          const requestedNumber = postData
            ? JSON.parse(postData)?.trackingInfo?.[0]?.trackNumberInfo?.trackingNumber
            : null;
          const json: any = await resp.json();
          if (requestedNumber) {
            trackResponses.set(String(requestedNumber), { status: resp.status(), json });
          }
        } catch { /* */ }
      });
    },

    async awaitReady(page: Page, num: string) {
      const url = page.url();
      const deepLinked = /\/(?:wtrk\/track|fedextrack)\//.test(url) || url.includes("trknbr=");
      await clearFedExOverlays(page);
      await page.waitForLoadState("domcontentloaded").catch(() => {});

      const visibleLandingInput = page.locator("input[id^='tracking_number_0_']").first();
      const trackingInput = page.locator("#trackingModuleTrackingNum, input[name='trackingNumber']").first();
      const trackButton = page
        .locator("button:visible")
        .filter({ hasText: /^TRACK$/i })
        .first();

      if (!deepLinked) {
        if (await visibleLandingInput.isVisible({ timeout: 5000 }).catch(() => false)) {
          await visibleLandingInput.click({ timeout: 10000, force: true });
          await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
          await page.keyboard.type(num, { delay: 20 });
        } else if (await trackingInput.isVisible({ timeout: 5000 }).catch(() => false)) {
          await trackingInput.evaluate((input, trackingNumber) => {
            const el = input as HTMLInputElement;
            el.value = String(trackingNumber);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, num);
        } else {
          await page.waitForSelector("#trackingModuleTrackingNum, input[name='trackingNumber']", {
            state: "attached",
            timeout: 45000,
          }).catch(() => {});
          await page.evaluate((trackingNumber) => {
            const input = document.querySelector<HTMLInputElement>(
              "#trackingModuleTrackingNum, input[name='trackingNumber']",
            );
            if (!input) throw new Error("FedEx tracking input not found");
            input.value = trackingNumber;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }, num).catch(() => {});
        }

        await trackButton.click({ timeout: 10000, force: true }).catch(() => {});
      }

      await page.waitForTimeout(Number(process.env.FEDEX_RENDER_SETTLE_MS ?? 12000));
      await awaitBearerToken(Number(process.env.FEDEX_TOKEN_WAIT_MS ?? 15000));

      const start = Date.now();
    const waitMs = Number(process.env.FEDEX_READY_TIMEOUT_MS ?? 45000);
    while (!trackResponses.has(num) && Date.now() - start < waitMs) {
      if (page.url().includes("no-results-found")) return;
      if (page.url().includes("system-error")) return;
      await page
        .waitForSelector(
          "text=Scheduled delivery date, text=We have your package, text=On the way, text=Arrived at FedEx location",
          { timeout: 1000 },
        )
        .catch(() => {});
      await page.waitForTimeout(200);
    }
  },

    async runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
      // If the page landed on /no-results-found (because the warm number
      // was invalid), the API also returns nothing useful. Surface it.
      if (page.url().includes("no-results-found")) {
        return { ok: false, error: "FedEx: no results found (tracking number invalid)" };
      }
      const cached = trackResponses.get(num);
      if (cached) {
        return buildResult(cached.status, cached.json, num);
      }

      const renderedBeforeFetch = await parseRenderedPage(page, num);
      if (renderedBeforeFetch) return renderedBeforeFetch;

      const canBrowserFetch = process.env.FEDEX_ENABLE_API_FETCH !== "0" && Boolean(bearerToken);
      if (canBrowserFetch) {
        if (process.env.FEDEX_DEBUG) {
          console.error(`[fedex] querying with page.url=${page.url()}`);
          console.error(`[fedex] token len=${bearerToken!.length}`);
          console.error(`[fedex] cached track=${trackResponses.has(num)}`);
        }

        const payload = {
          appType: "WTRK",
          appDeviceType: "WTRK",
          supportHTML: true,
          supportCurrentLocation: true,
          uniqueKey: "",
          guestAuthenticationToken: "",
          trackingInfo: [
            {
              trackNumberInfo: {
                trackingNumber: num,
                trackingQualifier: TRACKING_QUALIFIER(num),
                trackingCarrier: "FDEG",
              },
            },
          ],
        };

        let raw: { status: number; text: string } | null = null;
        try {
          raw = await withTimeout(page.evaluate(
            async ({ url, token, body, timeoutMs }) => {
              const controller = new AbortController();
              const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
              try {
                const response = await fetch(url, {
                  method: "POST",
                  credentials: "include",
                  signal: controller.signal,
                  headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                    "X-Requested-With": "XMLHttpRequest",
                    "X-clientid": "WTRK",
                    "X-locale": "en_US",
                    "X-version": "1.0.0",
                  },
                  body: JSON.stringify(body),
                });
                return { status: response.status, text: await response.text() };
              } finally {
                window.clearTimeout(timeout);
              }
            },
            { url: API_URL, token: bearerToken, body: payload, timeoutMs: BROWSER_FETCH_TIMEOUT_MS() },
          ), BROWSER_FETCH_TIMEOUT_MS() + 2000, "FedEx browser fetch timed out");
        } catch (err) {
          const rendered = await parseRenderedPage(page, num);
          if (rendered) return rendered;
          const navigated = await navigateAndParse(page, num);
          const cachedAfterNavigation = trackResponses.get(num);
          if (cachedAfterNavigation) {
            return buildResult(cachedAfterNavigation.status, cachedAfterNavigation.json, num);
          }
          if (navigated) return navigated;
          return {
            ok: false,
            error: `FedEx browser fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        const status = raw.status;
        if (process.env.FEDEX_DEBUG_BODY === "1") {
          console.error(`[fedex] api status=${status} body=${raw.text.slice(0, 1000)}`);
        }
        if (status === 401) {
          bearerToken = null;
          return { ok: false, error: "FedEx HTTP 401 (token expired)" };
        }

        let json: any = null;
        try { json = JSON.parse(raw.text); } catch { /* */ }
        const result = buildResult(status, json, num);
        if (result.ok) return result;
        const rendered = await parseRenderedPage(page, num);
        if (rendered) return rendered;
        const navigated = await navigateAndParse(page, num);
        const cachedAfterNavigation = trackResponses.get(num);
        if (cachedAfterNavigation) {
          return buildResult(cachedAfterNavigation.status, cachedAfterNavigation.json, num);
        }
        return navigated ?? result;
      }

      const rendered = await parseRenderedPage(page, num);
      if (rendered) return rendered;
      const navigated = await navigateAndParse(page, num);
      const cachedAfterNavigation = trackResponses.get(num);
      if (cachedAfterNavigation) {
        return buildResult(cachedAfterNavigation.status, cachedAfterNavigation.json, num);
      }
      return navigated ?? { ok: false, error: "FedEx: rendered tracking data not available yet" };
    },

    isExpired: (r) =>
      !r.ok && /401|403|token expired|Access Denied/i.test(r.error || ""),
  };
}

export const fedexCarrier: Carrier = createFedexCarrier();
