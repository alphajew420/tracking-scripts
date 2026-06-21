import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { proxyForCarrier } from "./proxy.ts";
import { createProxyExtension } from "./session.ts";
import type { BrowserProxy } from "./proxy.ts";

const launched = new Map<string, Promise<string | undefined>>();

function chromePath(): string {
  const explicit = process.env.CHROME_PATH;
  if (explicit) return explicit;

  const candidates =
    platform() === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : platform() === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH to the Chrome executable.");
  return found;
}

function carrierEnvName(prefix: string, carrier: string): string {
  return `${prefix}_${carrier.toUpperCase().replaceAll("-", "_")}`;
}

function carrierDefaultUrl(carrier: string): string | null {
  if (carrier === "royal-mail") return "https://www.royalmail.com/track-your-item";
  if (carrier === "postnord-se") return "https://www.postnord.se/en/our-tools/track-and-trace";
  if (carrier === "postnord-dk") return "https://www.postnord.dk/en/track-trace";
  if (carrier === "fedex") return "https://www.fedex.com/en-us/tracking.html";
  return null;
}

function shouldAutoLaunch(carrier: string): boolean {
  const raw = process.env[carrierEnvName("BROWSER_CDP_AUTOLAUNCH", carrier)] ?? process.env.BROWSER_CDP_AUTOLAUNCH;
  if (raw == null || raw === "") return carrier === "fedex";
  return /^(1|true|yes)$/i.test(raw);
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close();
      if (typeof address === "object" && address && "port" in address) {
        resolve(address.port);
      } else {
        reject(new Error("unable to allocate a free port"));
      }
    });
  });
}

async function waitForEndpoint(endpoint: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const versionUrl = `${endpoint}/json/version`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(versionUrl, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`CDP endpoint did not become ready: ${endpoint}`);
}

async function launchSidecar(carrier: string, proxy?: BrowserProxy): Promise<string | undefined> {
  if (!shouldAutoLaunch(carrier)) return undefined;

  const explicitEndpoint =
    process.env[carrierEnvName("BROWSER_CDP_ENDPOINT", carrier)] ?? process.env.BROWSER_CDP_ENDPOINT;
  if (explicitEndpoint) return explicitEndpoint;

  const port = Number(process.env[carrierEnvName("BROWSER_CDP_PORT", carrier)] ?? process.env.BROWSER_CDP_PORT ?? 0) || await pickFreePort();
  const profile =
    process.env[carrierEnvName("CDP_PROFILE_DIR", carrier)] ??
    process.env.CDP_PROFILE_DIR ??
    `.browser-profiles/cdp-${carrier}-${process.pid}`;
  const url = process.env[carrierEnvName("BROWSER_CDP_URL", carrier)] ?? carrierDefaultUrl(carrier);
  const useXvfb =
    platform() === "linux" &&
    /^(1|true|yes)$/i.test(
      process.env[carrierEnvName("BROWSER_CDP_XVFB", carrier)] ?? process.env.BROWSER_CDP_XVFB ?? "true",
    );
  const headless =
    !useXvfb &&
    /^(1|true|yes)$/i.test(
      process.env[carrierEnvName("BROWSER_CDP_HEADLESS", carrier)] ?? process.env.BROWSER_CDP_HEADLESS ?? "true",
    );
  const effectiveProxy =
    proxy ??
    (carrier === "fedex" && /^(1|true|yes)$/i.test(process.env.FEDEX_USE_PROXY ?? "")
      ? proxyForCarrier(carrier, { session: carrier })
      : undefined);
  const proxyExtension = effectiveProxy
    ? createProxyExtension(effectiveProxy, `${carrier}-sidecar-${process.pid}`)
    : null;

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    ...(headless ? ["--headless=new"] : []),
    ...(proxyExtension
      ? [`--disable-extensions-except=${proxyExtension}`, `--load-extension=${proxyExtension}`]
      : []),
    ...(url ? [url] : []),
  ];

  const child = spawn(useXvfb ? "xvfb-run" : chromePath(), useXvfb ? ["-a", chromePath(), ...chromeArgs] : chromeArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const endpoint = `http://127.0.0.1:${port}`;
  await waitForEndpoint(endpoint);
  return endpoint;
}

export async function getBrowserSidecarEndpoint(carrier: string, proxy?: BrowserProxy): Promise<string | undefined> {
  const cacheKey = `${carrier}:${proxy ? "proxy" : "direct"}`;
  const existing = launched.get(cacheKey);
  if (existing) return existing;

  const promise = launchSidecar(carrier, proxy).catch((error) => {
    launched.delete(cacheKey);
    throw error;
  });
  launched.set(cacheKey, promise);
  return promise;
}
