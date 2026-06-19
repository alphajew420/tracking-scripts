import { chromium } from "patchright";
import { dhlCarrier } from "../carriers/dhl.ts";
import { dhlExpressCarrier } from "../carriers/dhl-express.ts";
import { fedexCarrier } from "../carriers/fedex.ts";
import { upsCarrier } from "../carriers/ups.ts";
import { uspsCarrier } from "../carriers/usps.ts";
import { proxyForCarrier } from "../proxy.ts";
import { TrackingSession, type Carrier } from "../session.ts";

const REGISTRY: Record<string, () => Carrier> = {
  dhl: () => dhlCarrier,
  "dhl-express": () => dhlExpressCarrier,
  fedex: () => fedexCarrier,
  ups: () => upsCarrier,
  usps: () => uspsCarrier,
};

function usage(): never {
  console.error(`usage: proxy:diagnose <carrier> <tracking-number> [--attempts=N] [--country=us]

Requires either PROXY_<CARRIER>_USERNAME or PROXY_<CARRIER>_USERNAME_TEMPLATE.
Template tokens: {carrier}, {country}, {session}

Example:
  PROXY_FEDEX=http://host:port \\
  PROXY_FEDEX_USERNAME_TEMPLATE='user-country-{country}-session-{session}' \\
  PROXY_FEDEX_PASSWORD='secret' \\
  npm run proxy:diagnose -- fedex 123456789012 --attempts=5 --country=us`);
  process.exit(2);
}

function flagValue(args: string[], name: string, fallback: string): string {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function getProxyIp(proxy: NonNullable<ReturnType<typeof proxyForCarrier>>): Promise<string> {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    proxy,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://api.ipify.org?format=json", {
      waitUntil: "load",
      timeout: 30000,
    });
    const text = await page.textContent("body");
    await context.close().catch(() => {});
    return text ?? "";
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length < 2) usage();

  const [carrierId, trackingNumber] = positional;
  const factory = REGISTRY[carrierId!];
  if (!factory) usage();

  const attempts = Number(flagValue(args, "--attempts", "3"));
  const country = flagValue(args, "--country", process.env.PROXY_COUNTRY ?? "us");

  for (let i = 1; i <= attempts; i += 1) {
    const session = `${carrierId}-${Date.now()}-${i}`;
    const proxy = proxyForCarrier(carrierId!, { country, session });
    if (!proxy) {
      console.error(`missing proxy env for ${carrierId}`);
      process.exit(2);
    }

    const safeProxy = {
      server: proxy.server,
      username: proxy.username,
      hasPassword: Boolean(proxy.password),
    };
    console.log(`\n=== attempt ${i}/${attempts} ===`);
    console.log(JSON.stringify({ proxy: safeProxy }, null, 2));

    try {
      console.log(`exit_ip=${await getProxyIp(proxy)}`);
    } catch (err) {
      console.log(`exit_ip_error=${err instanceof Error ? err.message : String(err)}`);
    }

    const trackingSession = new TrackingSession(factory(), {
      channel: carrierId === "ups" || carrierId === "fedex" ? "chrome" : undefined,
      headless: process.env.HEADLESS !== "false",
      debug: process.env.DEBUG_SCRAPES === "1",
      proxy,
      userAgent: carrierId === "fedex" ? null : undefined,
      disableBlocking: carrierId === "fedex",
      persistentProfileDir:
        carrierId === "fedex" ? `/tmp/trackified-fedex-proxy-${session}` : undefined,
    });
    try {
      const started = Date.now();
      const result = await trackingSession.track(trackingNumber!);
      console.log(JSON.stringify({ elapsed_ms: Date.now() - started, result }, null, 2));
    } finally {
      await trackingSession.close();
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
