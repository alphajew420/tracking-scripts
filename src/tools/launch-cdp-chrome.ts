import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { proxyForCarrier } from "../proxy.ts";
import { createProxyExtension } from "../session.ts";

function usage(): never {
  console.error(`usage: cdp:chrome [carrier] [--port=9222] [--profile=.browser-profiles/cdp] [url ...]

Launches a real Chrome sidecar with remote debugging enabled.
If proxy env is present for the carrier, it loads the same proxy extension used by scrapers.

Example:
  PROXY_DEFAULT=http://host:port PROXY_DEFAULT_USERNAME=user PROXY_DEFAULT_PASSWORD=pass \\
  npm run cdp:chrome -- royal-mail --port=9222 https://www.royalmail.com/track-your-item`);
  process.exit(2);
}

function flagValue(args: string[], name: string, fallback: string): string {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

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

function carrierDefaultUrl(carrier: string): string | null {
  if (carrier === "royal-mail") return "https://www.royalmail.com/track-your-item";
  if (carrier === "postnord-se") return "https://www.postnord.se/en/our-tools/track-and-trace";
  if (carrier === "postnord-dk") return "https://www.postnord.dk/en/track-trace";
  if (carrier === "fedex") return "https://www.fedex.com/en-us/tracking.html";
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const carrier = positional[0];
  if (!carrier) usage();

  const urls = positional.slice(1);
  const port = flagValue(args, "--port", process.env.CDP_PORT ?? "9222");
  const profile = flagValue(
    args,
    "--profile",
    process.env.CDP_PROFILE_DIR ?? `.browser-profiles/cdp-${carrier}`,
  );
  const proxy = proxyForCarrier(carrier);
  const extension = proxy ? createProxyExtension(proxy, `${carrier}-cdp`) : null;
  const defaultUrl = carrierDefaultUrl(carrier);

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    ...(extension
      ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
      : []),
    ...(urls.length > 0 ? urls : defaultUrl ? [defaultUrl] : []),
  ];

  const child = spawn(chromePath(), chromeArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log(
    JSON.stringify(
      {
        cdpEndpoint: `http://127.0.0.1:${port}`,
        profile,
        carrier,
        proxyLoaded: Boolean(extension),
        next: `BROWSER_CDP_ENDPOINT_${carrier.toUpperCase().replaceAll("-", "_")}=http://127.0.0.1:${port} curl -X POST http://localhost:8787/v1/trackings -H "Authorization: Bearer <api_key>" -H "Content-Type: application/json" -d '{"tracking_number":"<number>","carrier":"${carrier}"}'`,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
