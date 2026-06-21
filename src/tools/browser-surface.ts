import { chromium, type Response } from "patchright";
import { buildCarrierSessionOptions } from "../carrier-runtime.ts";
import { proxyForCarrier } from "../proxy.ts";
import { createProxyExtension } from "../session.ts";

function usage(): never {
  console.error(`usage: browser:surface <carrier> <url> [--country=gb] [--session=id] [--profile-dir=path] [--cdp-endpoint=url]

Loads a carrier URL through a browser session and prints page/network diagnostics without
leaking proxy credentials. Use --proxy-mode=native or --proxy-mode=extension to compare paths.`);
  process.exit(2);
}

function flagValue(args: string[], name: string, fallback: string): string {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function interesting(url: string): boolean {
  return /royalmail|postnord|api-web|api2\.postnord|trackandtrace|findByIdentifier|shipment/i.test(url);
}

function summarizeResponse(response: Response): { status: number; url: string; type: string } {
  return {
    status: response.status(),
    url: response.url(),
    type: response.headers()["content-type"] ?? "",
  };
}

function proxyModeFromArgs(args: string[]): "native" | "extension" {
  const value = flagValue(args, "--proxy-mode", process.env.PROXY_MODE ?? "native");
  return value === "extension" ? "extension" : "native";
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const carrier = positional[0];
  const url = positional[1];
  if (!carrier || !url) usage();

  const country = flagValue(args, "--country", process.env.PROXY_COUNTRY ?? "gb");
  const session = flagValue(args, "--session", carrier);
  const proxyMode = proxyModeFromArgs(args);
  const cdpEndpoint = flagValue(args, "--cdp-endpoint", process.env.BROWSER_CDP_ENDPOINT ?? "");
  const proxy = proxyForCarrier(carrier, { country, session });
  const sessionOptions = buildCarrierSessionOptions(carrier, {
    headless: process.env.HEADLESS !== "false",
    proxy,
    proxyMode,
    cdpEndpoint: cdpEndpoint || undefined,
  });
  const profileDir = flagValue(args, "--profile-dir", sessionOptions.persistentProfileDir ?? `/tmp/trackified-surface-${carrier}-${session}`);
  const extension = proxy && proxyMode === "extension" ? createProxyExtension(proxy, `${carrier}-surface`) : null;

  let browserContext;
  if (cdpEndpoint) {
    const browser = await chromium.connectOverCDP(cdpEndpoint, { noDefaults: true });
    const deadline = Date.now() + 10_000;
    while (!browser.contexts().length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browserContext = browser.contexts()[0];
    if (!browserContext) throw new Error(`CDP browser at ${cdpEndpoint} has no available context`);
  } else {
    browserContext = await chromium.launchPersistentContext(
      profileDir,
      {
        channel: sessionOptions.channel ?? "chrome",
        headless: sessionOptions.headless ?? true,
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        ...(proxy && proxyMode === "native" ? { proxy } : {}),
        args: [
          "--disable-blink-features=AutomationControlled",
          ...(sessionOptions.launchArgs ?? []),
          ...(extension
            ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
            : []),
        ],
      },
    );
  }

  const page = await browserContext.newPage();
  const responses: Array<{ status: number; url: string; type: string }> = [];
  const failures: Array<{ url: string; method: string; error: string }> = [];

  page.on("response", (response) => {
    if (interesting(response.url())) responses.push(summarizeResponse(response));
  });
  page.on("requestfailed", (request) => {
    if (!interesting(request.url())) return;
    failures.push({
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText ?? "request failed",
    });
  });

  try {
    const ip = await page
      .goto("https://api.ipify.org?format=json", { waitUntil: "load", timeout: 30000 })
      .then(() => page.textContent("body"))
      .catch((error) => `ip_error=${error instanceof Error ? error.message : String(error)}`);

    const navigation = await page
      .goto(url, { waitUntil: "domcontentloaded", timeout: 90000 })
      .then((response) => ({ status: response?.status() ?? null, url: page.url() }))
      .catch((error) => ({
        status: null,
        url: page.url(),
        error: error instanceof Error ? error.message : String(error),
      }));

    await page.waitForTimeout(Number(process.env.SURFACE_SETTLE_MS ?? 12000));

    const pageState = await page.evaluate(() => {
      const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
      const inputs = Array.from(document.querySelectorAll("input")).map((input) => ({
        id: input.id,
        name: input.getAttribute("name"),
        type: input.getAttribute("type"),
        placeholder: input.getAttribute("placeholder"),
        ariaLabel: input.getAttribute("aria-label"),
      }));
      const buttons = Array.from(document.querySelectorAll("button")).slice(0, 20).map((button) => ({
        id: button.id,
        type: button.getAttribute("type"),
        text: button.innerText?.replace(/\s+/g, " ").trim().slice(0, 80),
        ariaLabel: button.getAttribute("aria-label"),
      }));
      return {
        title: document.title,
        url: location.href,
        textPreview: bodyText.slice(0, 1200),
        hasAccessDenied: /access denied|edgesuite|akamai|cloudflare/i.test(bodyText),
        inputs,
        buttons,
      };
    });

    console.log(
      JSON.stringify(
        {
          proxyMode,
          cdpEndpoint: cdpEndpoint || null,
          proxy: proxy
            ? { server: proxy.server, hasUsername: Boolean(proxy.username), hasPassword: Boolean(proxy.password) }
            : null,
          ip,
          navigation,
          pageState,
          responses,
          failures,
        },
        null,
        2,
      ),
    );
  } finally {
    await browserContext?.close?.().catch?.(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
