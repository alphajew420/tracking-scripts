import { TrackingSession, type Carrier } from "./session.ts";
import { dhlCarrier } from "./carriers/dhl.ts";
import { dhlExpressCarrier } from "./carriers/dhl-express.ts";
import { fedexCarrier } from "./carriers/fedex.ts";
import { upsCarrier } from "./carriers/ups.ts";
import { uspsCarrier } from "./carriers/usps.ts";
import { createConfigCarrier, listCarrierConfigIds } from "./config/adapter.ts";
import { detectCarrier } from "./detect.ts";
import { proxyForCarrier } from "./proxy.ts";
import type { ScrapeResult } from "./types.ts";

const SCRAPER_REGISTRY: Record<string, () => Carrier> = {
  dhl: () => dhlCarrier,
  "dhl-express": () => dhlExpressCarrier,
  fedex: () => fedexCarrier,
  ups: () => upsCarrier,
  usps: () => uspsCarrier,
};
for (const id of listCarrierConfigIds()) {
  SCRAPER_REGISTRY[id] ??= () => createConfigCarrier(id);
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes)$/i.test(value);
}

process.on("unhandledRejection", (err: any) => {
  const msg = String(err?.message ?? err);
  if (/Target page, context or browser has been closed/.test(msg)) return;
  console.error("unhandled rejection:", err);
});

function usage(): never {
  console.error(`usage: track <carrier> <tracking-number> [<num> ...] [--json] [--debug] [--chrome]
       track detect <tracking-number>

  carriers:  ${Object.keys(SCRAPER_REGISTRY).join(", ")}

  --json     print full JSON result
  --debug    verbose logging
  --chrome   force system Chrome (auto-on for scraper UPS)
  --headless run browser without a visible window

  multiple tracking numbers reuse one warm scraper session.`);
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

  if (carrierKey === "detect") {
    const candidates = detectCarrier(numbers[0]!);
    console.log(JSON.stringify({ trackingNumber: numbers[0], candidates }, null, 2));
    return;
  }

  const make = SCRAPER_REGISTRY[carrierKey];
  if (!make) {
    console.error(`unknown carrier: ${carrierKey}`);
    usage();
  }

  const debug = flags.has("--debug");
  const asJson = flags.has("--json");
  // Some carrier sites behave differently in bundled automation browsers.
  const channel: "chrome" | undefined =
    flags.has("--chrome") || carrierKey === "ups" || carrierKey === "fedex"
      ? "chrome"
      : undefined;
  // Akamai's sensor.js detects headless Chrome on USPS / DHL / FedEx. Default
  // scrapers to headed mode; the user can opt back into headless with --headless
  // if their stealth fingerprint is good enough.
  const headless = flags.has("--headless");

  const session = new TrackingSession(make(), {
    debug,
    channel,
    headless,
    proxy: proxyForCarrier(carrierKey),
    proxyMode:
      process.env[`PROXY_${carrierKey.toUpperCase().replaceAll("-", "_")}_MODE`] === "extension" ||
      process.env.PROXY_MODE === "extension"
        ? "extension"
        : "native",
    userAgent: carrierKey === "fedex" || carrierKey === "dhl" ? null : undefined,
    disableBlocking:
      carrierKey === "fedex"
        ? booleanEnv("FEDEX_DISABLE_BLOCKING", false)
        : booleanEnv(`DISABLE_BLOCKING_${carrierKey.toUpperCase().replaceAll("-", "_")}`, false),
    warmTimeoutMs:
      carrierKey === "fedex"
        ? Number(process.env.FEDEX_WARM_TIMEOUT_MS ?? 180000)
        : undefined,
    warmWaitUntil: carrierKey === "fedex" ? "domcontentloaded" : undefined,
    persistentProfileDir:
      carrierKey === "fedex"
        ? process.env.FEDEX_PROFILE_DIR ?? ".browser-profiles/fedex"
        : undefined,
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

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
