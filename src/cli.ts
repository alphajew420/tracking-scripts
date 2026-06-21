import { TrackingSession, type Carrier } from "./session.ts";
import { getCarrierFactory, listRegisteredCarrierIds } from "./carriers/registry.ts";
import { detectCarrier } from "./detect.ts";
import { proxyForCarrier } from "./proxy.ts";
import { createLogger } from "./logger.ts";
import { buildCarrierSessionOptions } from "./carrier-runtime.ts";
import type { ScrapeResult } from "./types.ts";

const logger = createLogger("cli");

process.on("unhandledRejection", (err: any) => {
  const msg = String(err?.message ?? err);
  if (/Target page, context or browser has been closed/.test(msg)) return;
  logger.error("unhandled rejection", { error: msg });
});

function usage(): never {
  console.error(`usage: track <carrier> <tracking-number> [<num> ...] [--json] [--debug] [--chrome]
       track detect <tracking-number>

  carriers:  ${listRegisteredCarrierIds().join(", ")}

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

  const make = getCarrierFactory(carrierKey);
  if (!make) {
    console.error(`unknown carrier: ${carrierKey}`);
    usage();
  }

  const debug = flags.has("--debug");
  const asJson = flags.has("--json");
  // Internal helper only. Public flows should use the API.
  const headless = flags.has("--headless");
  const session = new TrackingSession(make(), {
    ...buildCarrierSessionOptions(carrierKey, { headless, debug, proxy: proxyForCarrier(carrierKey) }),
    onWarm: debug ? () => logger.info("session warmed", { carrier: carrierKey }) : undefined,
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
    logger.error("fatal", { error: String(e) });
    process.exit(1);
  });
