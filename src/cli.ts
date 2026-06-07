import { TrackingSession, type Carrier } from "./session.ts";
import { dhlCarrier } from "./carriers/dhl.ts";
import { dhlExpressCarrier } from "./carriers/dhl-express.ts";
import { fedexCarrier } from "./carriers/fedex.ts";
import { upsCarrier } from "./carriers/ups.ts";
import { uspsCarrier } from "./carriers/usps.ts";
import { createDhlApiCarrier } from "./carriers/dhl-api.ts";
import { createDhlExpressApiCarrier } from "./carriers/dhl-express-api.ts";
import { createUpsApiCarrier } from "./carriers/ups-api.ts";
import { createFedexApiCarrier } from "./carriers/fedex-api.ts";
import type { ScrapeResult } from "./types.ts";

const SCRAPER_REGISTRY: Record<string, () => Carrier> = {
  dhl: () => dhlCarrier,
  "dhl-express": () => dhlExpressCarrier,
  fedex: () => fedexCarrier,
  ups: () => upsCarrier,
  usps: () => uspsCarrier,
};

const API_REGISTRY: Record<string, () => Carrier> = {
  dhl: () => createDhlApiCarrier(),
  "dhl-express": () => createDhlExpressApiCarrier(),
  fedex: () => createFedexApiCarrier(),
  ups: () => createUpsApiCarrier(),
  // No usps: official tracking API is paid.
};

process.on("unhandledRejection", (err: any) => {
  const msg = String(err?.message ?? err);
  if (/Target page, context or browser has been closed/.test(msg)) return;
  console.error("unhandled rejection:", err);
});

function usage(): never {
  console.error(`usage: track <carrier> <tracking-number> [<num> ...] [--api] [--json] [--debug] [--chrome]

  carriers (scraper):  ${Object.keys(SCRAPER_REGISTRY).join(", ")}
  carriers (--api):    ${Object.keys(API_REGISTRY).join(", ")}   (USPS Tracking API is paid — scraper only)

  --api      use the official carrier API instead of scraping. Requires creds:
             DHL_API_KEY, UPS_CLIENT_ID/SECRET, FEDEX_CLIENT_ID/SECRET.
  --json     print full JSON result
  --debug    verbose logging
  --chrome   force system Chrome (auto-on for scraper UPS)

  multiple tracking numbers reuse one warm session (scraper mode only).`);
  process.exit(2);
}

function print(num: string, result: ScrapeResult, asJson: boolean) {
  if (asJson) {
    console.log(JSON.stringify({ trackingNumber: num, ...result }, null, 2));
    return;
  }
  if (!result.ok || !result.track) {
    console.log(`${num}: FAILED — ${result.error}`);
    return;
  }
  const t = result.track;
  console.log(`${t.carrier.toUpperCase()} ${t.trackingNumber}`);
  console.log(
    `  delivered: ${t.delivered}${t.recipient ? `  recipient: ${t.recipient}` : ""}`,
  );
  console.log(`  events: ${t.events.length}`);
  for (const e of t.events) {
    console.log(
      `    [${e.status.padEnd(10)}] ${e.date ?? "?"}  ${e.location}  ${e.description}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const a of args) (a.startsWith("--") ? flags.add(a) : positional.push(a));

  if (positional.length < 2) usage();
  const [carrierKey, ...numbers] = positional;

  const useApi = flags.has("--api");
  const registry = useApi ? API_REGISTRY : SCRAPER_REGISTRY;
  const make = registry[carrierKey];
  if (!make) {
    if (useApi && carrierKey === "usps") {
      console.error("USPS tracking has no free API — drop --api to use the scraper.");
    } else {
      console.error(`unknown carrier${useApi ? " (in API mode)" : ""}: ${carrierKey}`);
    }
    usage();
  }

  const debug = flags.has("--debug");
  const asJson = flags.has("--json");
  // Scraper UPS needs system Chrome to clear reCAPTCHA.
  const channel: "chrome" | undefined =
    !useApi && (flags.has("--chrome") || carrierKey === "ups") ? "chrome" : undefined;
  // Akamai's sensor.js detects headless Chrome on USPS / DHL / FedEx. Default
  // scrapers to headed mode; the user can opt back into headless with --headless
  // if their stealth fingerprint is good enough (or for API mode where the
  // browser never opens).
  const headless = useApi ? true : flags.has("--headless");

  const session = new TrackingSession(make(), {
    debug,
    channel,
    headless,
    onWarm: debug ? () => console.error(`[session] warmed`) : undefined,
  });
  try {
    for (const num of numbers) {
      const result = await session.track(num);
      print(num, result, asJson);
      if (!asJson && numbers.length > 1) console.log();
    }
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
