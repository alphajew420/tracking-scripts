import type { Page } from "patchright";
import type { Carrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

const LANDING_URL = "https://www.fedex.com/en-us/tracking.html";
const TRACK_URL = (n: string) => {
  const template = process.env.FEDEX_TRACK_URL_TEMPLATE;
  if (template) return template.replaceAll("{n}", encodeURIComponent(n));

  const trkqual =
    process.env[`FEDEX_TRKQUAL_${n.replace(/\W/g, "_")}`] ?? process.env.FEDEX_TRKQUAL;
  if (trkqual) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}&trkqual=${encodeURIComponent(trkqual)}`;
  }

  if (process.env.FEDEX_TRACK_SURFACE === "deep") {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`;
  }

  return LANDING_URL;
};
const API_URL = "https://api.fedex.com/track/v2/shipments";

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
  const parsed = await page.evaluate((trackingNumber) => {
    const text = document.body?.innerText ?? "";
    if (!text.includes(trackingNumber) && !/delivery status|travel history|shipment facts/i.test(text)) {
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
      lines.find((line) => /delivered|out for delivery|on the way|label created|shipment exception/i.test(line)) ??
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

    return {
      delivered,
      events,
      recipient:
        lines.find((line) => /^signed for by:/i.test(line))?.replace(/^signed for by:\s*/i, "") ??
        undefined,
    };
  }, num);

  if (!parsed || parsed.events.length === 0) return null;
  return {
    ok: true,
    track: {
      carrier: "fedex",
      trackingNumber: num,
      delivered: parsed.delivered,
      recipient: parsed.recipient,
      events: parsed.events.map((event) => ({
        date: event.date,
        location: event.location,
        description: event.description,
        status: classify(event.description),
      })),
    },
  };
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
  let warmTrackJson: any = null;
  let warmTrackStatus: number | null = null;
  let warmTrackUsed = false;

  return {
    name: "fedex",
    mode: "scraper",
    warmUrl: TRACK_URL,

    setupPage(page: Page) {
      bearerToken = null;
      warmTrackJson = null;
      warmTrackStatus = null;
      warmTrackUsed = false;
      page.on("response", async (resp) => {
        const url = resp.url();
        if (/api\.fedex\.com\/auth\/oauth\/v\d\/token/.test(url) && resp.status() === 200) {
          try {
            const json: any = await resp.json();
            if (json?.access_token) bearerToken = json.access_token;
          } catch { /* */ }
          return;
        }
        if (!/api\.fedex\.com\/track\/v2\/shipments/.test(url)) return;
        try {
          warmTrackStatus = resp.status();
          const json: any = await resp.json();
          warmTrackJson = json;
        } catch { /* */ }
      });
    },

    async awaitReady(page: Page, num: string) {
      const url = page.url();
      const deepLinked = /\/(?:wtrk\/track|fedextrack)\//.test(url) || url.includes("trknbr=");
      if (!deepLinked) {
        await clearFedExOverlays(page);

        const visibleLandingInput = page.locator("input[id^='tracking_number_0_']").first();
        if (await visibleLandingInput.isVisible({ timeout: 20000 }).catch(() => false)) {
          await clearFedExOverlays(page);
          await visibleLandingInput.click({ timeout: 10000, force: true });
          await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
          await page.keyboard.type(num, { delay: 20 });
          await clearFedExOverlays(page);
          await page
            .locator("button:visible")
            .filter({ hasText: /^TRACK$/i })
            .first()
            .click({ timeout: 10000, force: true });
        } else {
          await page.waitForSelector("#trackingModuleTrackingNum, input[name='trackingNumber']", {
          state: "attached",
          timeout: 45000,
          });
          await page.evaluate((trackingNumber) => {
            const input = document.querySelector<HTMLInputElement>(
              "#trackingModuleTrackingNum, input[name='trackingNumber']",
            );
            if (!input) throw new Error("FedEx tracking input not found");
            input.value = trackingNumber;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            const button = document.querySelector<HTMLButtonElement>(
              "button[aria-label='Click here to track your package'], button[type='submit'], button#track",
            );
            if (!button) throw new Error("FedEx track button not found");
            button.click();
          }, num);
        }
      }

      const start = Date.now();
      const waitMs = Number(process.env.FEDEX_READY_TIMEOUT_MS ?? 45000);
      while (!warmTrackJson && Date.now() - start < waitMs) {
        if (page.url().includes("no-results-found")) return;
        if (page.url().includes("system-error")) return;
        await page.waitForTimeout(200);
      }
    },

    async runQuery({ page }: QueryCtx, num: string): Promise<ScrapeResult> {
      // If the page landed on /no-results-found (because the warm number
      // was invalid), the API also returns nothing useful. Surface it.
      if (page.url().includes("no-results-found")) {
        return { ok: false, error: "FedEx: no results found (tracking number invalid)" };
      }
      if (!bearerToken) {
        const rendered = await parseRenderedPage(page, num);
        if (rendered) return rendered;
        return { ok: false, error: "FedEx: bearer token never captured during warm" };
      }
      if (process.env.FEDEX_DEBUG) {
        console.error(`[fedex] querying with page.url=${page.url()}`);
        console.error(`[fedex] token len=${bearerToken.length}`);
        console.error(`[fedex] warm track status=${warmTrackStatus ?? "none"}`);
      }

      if (!warmTrackUsed && warmTrackJson) {
        warmTrackUsed = true;
        return buildResult(warmTrackStatus ?? 200, warmTrackJson, num);
      }

      const renderedBeforeFetch = await parseRenderedPage(page, num);
      if (renderedBeforeFetch) return renderedBeforeFetch;

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
              trackingQualifier: "",
              trackingCarrier: "",
            },
          },
        ],
      };

      let raw: { status: number; text: string } | null = null;
      try {
        raw = await page.evaluate(
          async ({ url, token, body }) => {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 15000);
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
          { url: API_URL, token: bearerToken, body: payload },
        );
      } catch (err) {
        const rendered = await parseRenderedPage(page, num);
        if (rendered) return rendered;
        return {
          ok: false,
          error: `FedEx browser fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const status = raw.status;
      if (status === 401) {
        bearerToken = null;
        return { ok: false, error: "FedEx HTTP 401 (token expired)" };
      }

      let json: any = null;
      try { json = JSON.parse(raw.text); } catch { /* */ }
      const result = buildResult(status, json, num);
      if (result.ok) return result;
      const rendered = await parseRenderedPage(page, num);
      return rendered ?? result;
    },

    isExpired: (r) =>
      !r.ok && /401|403|token expired|Access Denied/i.test(r.error || ""),
  };
}

export const fedexCarrier: Carrier = createFedexCarrier();
