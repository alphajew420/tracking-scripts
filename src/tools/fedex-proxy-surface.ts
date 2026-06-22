import { chromium, firefox, webkit, type Response } from "patchright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { proxyForCarrier } from "../proxy.ts";
import { createProxyExtension } from "../session.ts";

function flagValue(args: string[], name: string, fallback: string): string {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function proxyMode(args: string[]): "native" | "extension" | "hybrid" | "direct" {
  const mode = flagValue(args, "--proxy-mode", process.env.PROXY_MODE ?? "native");
  if (mode === "extension") return "extension";
  if (mode === "hybrid") return "hybrid";
  if (mode === "direct") return "direct";
  return "native";
}

function trackingQualifier(trackingNumber: string): string {
  const configured = process.env[`FEDEX_TRKQUAL_${trackingNumber.replace(/\W/g, "_")}`] ?? process.env.FEDEX_TRKQUAL;
  if (configured === "none" || configured === "") return "";
  return configured ?? `12030~${trackingNumber}~FDEG`;
}

function trackingUrl(trackingNumber: string): string {
  const qualifier = trackingQualifier(trackingNumber);
  const base = `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
  return qualifier ? `${base}&trkqual=${encodeURIComponent(qualifier)}` : base;
}

function interesting(url: string): boolean {
  return /fedex|api\.fedex|akam|edgesuite|sensor|oauth|track\/v2\/shipments/i.test(url);
}

function responseSummary(response: Response) {
  return {
    status: response.status(),
    url: response.url(),
    type: response.headers()["content-type"] ?? "",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const trackingNumber = args.find((arg) => !arg.startsWith("--"));
  if (!trackingNumber) {
    console.error("usage: fedex-proxy-surface <tracking-number> [--session=id] [--proxy-mode=native|extension]");
    process.exit(2);
  }

  const session = flagValue(args, "--session", `fedexprobe${Date.now()}`);
  const mode = proxyMode(args);
  const proxy = mode === "direct" ? undefined : proxyForCarrier("fedex", { country: "us", session });
  if (mode !== "direct" && !proxy) throw new Error("missing FedEx proxy env");

  const profileDir = resolve(flagValue(args, "--profile-dir", `.browser-profiles/fedex-proxy-surface-${session}`));
  mkdirSync(profileDir, { recursive: true });
  const extension =
    (mode === "extension" || mode === "hybrid") && proxy
      ? createProxyExtension(proxy, `fedex-surface-${session}`)
      : null;
  const proxyServerArg =
    mode === "hybrid" && proxy
      ? `--proxy-server=${/^[a-z][a-z\d+.-]*:\/\//i.test(proxy.server) ? proxy.server : `http://${proxy.server}`}`
      : null;
  const engine = process.env.FEDEX_BROWSER_ENGINE ?? "chromium";
  const browserType = engine === "firefox" ? firefox : engine === "webkit" ? webkit : chromium;
  const context = await browserType.launchPersistentContext(profileDir, {
    ...(engine === "chromium" && process.env.FEDEX_BROWSER_CHANNEL !== "bundled"
      ? { channel: "chrome" as const }
      : {}),
    headless: process.env.HEADLESS !== "false",
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    userAgent:
      process.env.FEDEX_USER_AGENT === "native"
        ? undefined
        : process.env.FEDEX_USER_AGENT ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    ...(mode === "native" && proxy ? { proxy } : {}),
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(proxyServerArg ? [proxyServerArg] : []),
      ...(extension ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : []),
    ],
  });

  const page = await context.newPage();
  if (process.env.FEDEX_PLATFORM_SPOOF === "mac") {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
    });
    await page.setExtraHTTPHeaders({
      "sec-ch-ua-platform": "\"macOS\"",
    });
  }
  if (extension) {
    await page.waitForTimeout(Number(process.env.PROXY_EXTENSION_SETTLE_MS_FEDEX ?? process.env.PROXY_EXTENSION_SETTLE_MS ?? 3000));
  }
  const responses: ReturnType<typeof responseSummary>[] = [];
  const failures: Array<{ method: string; url: string; error: string }> = [];
  const requests: Array<{
    method: string;
    url: string;
    headers?: Record<string, string>;
    postData?: string | null;
  }> = [];
  page.on("request", (request) => {
    if (!interesting(request.url())) return;
    requests.push({
      method: request.method(),
      url: request.url(),
      headers: request.url().includes("/track/v2/shipments") ? request.headers() : undefined,
      postData: request.url().includes("/track/v2/shipments") ? request.postData() : undefined,
    });
  });
  page.on("response", (response) => {
    if (interesting(response.url())) responses.push(responseSummary(response));
  });
  page.on("requestfailed", (request) => {
    if (!interesting(request.url())) return;
    failures.push({
      method: request.method(),
      url: request.url(),
      error: request.failure()?.errorText ?? "request failed",
    });
  });

  try {
    const ipText = await page
      .goto("https://ipinfo.io/json", { waitUntil: "load", timeout: 30000 })
      .then(() => page.textContent("body"))
      .catch((error) => `ip_error=${error instanceof Error ? error.message : String(error)}`);

    await page.goto("https://www.fedex.com/en-us/tracking.html", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    await page.evaluate(() => {
      document.cookie = "xacc=US; path=/; domain=.fedex.com; max-age=3600; secure";
      document.cookie = "fdx_locale=en_US; path=/; domain=.fedex.com; max-age=86400; secure";
      document.cookie = "fdx_redirect=en-us; path=/; domain=.fedex.com; max-age=86400; secure";
      document.querySelector<HTMLButtonElement>("#accept")?.click();
      document.querySelector<HTMLButtonElement>("#deny")?.click();
    }).catch(() => {});

    await page.waitForSelector("input[id^='tracking_number_0_'], #trackingModuleTrackingNum, input[name='trackingNumber']", {
      state: "attached",
      timeout: 30000,
    }).catch(() => {});
    await page.evaluate((num) => {
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          "input[id^='tracking_number_0_'], #trackingModuleTrackingNum, input[name='trackingNumber']",
        ),
      );
      for (const input of inputs) {
        if (input.offsetParent === null && input.id !== "trackingModuleTrackingNum") continue;
        input.value = num;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: num.slice(-1) || "0" }));
      }
    }, trackingNumber);
    const button = page.locator("#btnSingleTrack, button[type='submit']").first();
    if (await button.isVisible({ timeout: 2500 }).catch(() => false)) {
      await button.click({ timeout: 10000, force: true }).catch(() => {});
    } else {
      await page.locator("button:visible").filter({ hasText: /^TRACK$/i }).first().click({ timeout: 10000, force: true }).catch(() => {});
    }
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("form");
      if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }).catch(() => {});

    await page.waitForLoadState("domcontentloaded", { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(3000);
    if (!responses.some((entry) => entry.url.includes("/track/v2/shipments"))) {
      await page.goto(trackingUrl(trackingNumber), { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    }
    await page.waitForTimeout(Number(process.env.FEDEX_RENDER_SETTLE_MS ?? 12000));

    const legacyFetch = await page.evaluate(async (trackingNumber) => {
      const payload = {
        TrackPackagesRequest: {
          appType: "WTRK",
          appDeviceType: "DESKTOP",
          uniqueKey: "",
          processingParameters: {
            anonymousTransaction: true,
            clientId: "WTRK",
            returnDetailedErrors: true,
            returnLocalizedDateTime: false,
          },
          trackingInfoList: [
            {
              trackNumberInfo: {
                trackingNumber,
                trackingQualifier: "",
                trackingCarrier: "",
              },
            },
          ],
        },
      };
      const body = new URLSearchParams({
        data: JSON.stringify(payload),
        action: "trackpackages",
        locale: "en_US",
        format: "json",
        version: "99",
      });
      try {
        const response = await fetch("https://www.fedex.com/trackingCal/track", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Accept: "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
          },
          body,
        });
        return { status: response.status, text: (await response.text()).slice(0, 2000) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }, trackingNumber);

    const state = await page.evaluate(() => {
      const text = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
      return {
        title: document.title,
        url: location.href,
        textPreview: text.slice(0, 2000),
        hasSystemError: /system error|temporarily unavailable|technical difficulties/i.test(text) || location.href.includes("system-error"),
        hasTrackingNumber: text.includes((document.querySelector("input") as HTMLInputElement | null)?.value ?? ""),
        inputs: Array.from(document.querySelectorAll("input")).slice(0, 20).map((input) => ({
          id: input.id,
          name: input.getAttribute("name"),
          placeholder: input.getAttribute("placeholder"),
          valueLength: input.value?.length ?? 0,
        })),
        buttons: Array.from(document.querySelectorAll("button")).slice(0, 20).map((button) => ({
          id: button.id,
          text: button.innerText?.replace(/\s+/g, " ").trim().slice(0, 80),
        })),
      };
    });

    console.log(JSON.stringify({
      proxyMode: mode,
      proxy: proxy
        ? { server: proxy.server, hasUsername: Boolean(proxy.username), hasPassword: Boolean(proxy.password) }
        : null,
      trackingQualifier: trackingQualifier(trackingNumber) || null,
      ip: ipText ? JSON.parse(ipText).ip : null,
      finalUrl: page.url(),
      state,
      shipmentResponses: responses.filter((entry) => entry.url.includes("/track/v2/shipments")),
      legacyFetch,
      shipmentRequests: requests
        .filter((entry) => entry.url.includes("/track/v2/shipments"))
        .map((entry) => ({
          method: entry.method,
          url: entry.url,
          headers: Object.fromEntries(
            Object.entries(entry.headers ?? {}).filter(([key]) =>
              /^(accept|accept-language|authorization|content-type|origin|referer|sec-|x-|user-agent)/i.test(key),
            ),
          ),
          postData: entry.postData,
        })),
      tokenResponses: responses.filter((entry) => entry.url.includes("/auth/oauth")),
      failures,
      fedexRequestCount: requests.length,
      lastResponses: responses.slice(-40),
    }, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
