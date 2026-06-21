import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCarrierFactory, listRegisteredCarrierIds } from "../carriers/registry.ts";
import { TrackingSession, type SessionOptions } from "../session.ts";
import { proxyForCarrier } from "../proxy.ts";
import { buildCarrierSessionOptions } from "../carrier-runtime.ts";

interface ValidationResult {
  carrier: string;
  status: string;
  sample?: string | null;
  sample_source?: string | null;
}

interface ValidationFile {
  results: ValidationResult[];
}

interface VerificationOutput {
  carrier: string;
  sample: string | null;
  sample_source: string | null;
  ok: boolean;
  verified: boolean;
  events: number;
  delivered: boolean | null;
  error: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(arg, next);
      index += 1;
    } else {
      flags.add(arg);
    }
  }

  return { values, flags };
}

function sessionOptions(carrier: string, headless: boolean): SessionOptions {
  return buildCarrierSessionOptions(carrier, { headless, proxy: proxyForCarrier(carrier) });
}

async function verify(result: ValidationResult, headless: boolean): Promise<VerificationOutput> {
  const sample = result.sample ?? null;
  if (!sample) {
    return {
      carrier: result.carrier,
      sample,
      sample_source: result.sample_source ?? null,
      ok: false,
      verified: false,
      events: 0,
      delivered: null,
      error: "no sample in validation ledger",
    };
  }

  const factory = getCarrierFactory(result.carrier);
  if (!factory) {
    return {
      carrier: result.carrier,
      sample,
      sample_source: result.sample_source ?? null,
      ok: false,
      verified: false,
      events: 0,
      delivered: null,
      error: "carrier is not registered",
    };
  }

  const session = new TrackingSession(factory(), sessionOptions(result.carrier, headless));
  try {
    const scrape = await session.track(sample);
    const events = scrape.track?.events.length ?? 0;
    return {
      carrier: result.carrier,
      sample,
      sample_source: result.sample_source ?? null,
      ok: scrape.ok,
      verified: scrape.ok && events > 0,
      events,
      delivered: scrape.track?.delivered ?? null,
      error: scrape.ok ? null : scrape.error ?? "unknown error",
    };
  } finally {
    await session.close();
  }
}

async function main() {
  const { values, flags } = parseArgs();
  const carrierFilter = values.get("--carrier");
  const statusFilter = values.get("--status");
  const limit = Number(values.get("--limit") ?? 0);
  const headless = flags.has("--headless");

  const path = join(process.cwd(), "data/carrier-catalogs/module-validation-results.json");
  const validation = JSON.parse(readFileSync(path, "utf8")) as ValidationFile;
  const registered = new Set(listRegisteredCarrierIds());
  let entries = validation.results.filter((entry) => registered.has(entry.carrier));

  if (carrierFilter) {
    const wanted = new Set(carrierFilter.split(",").map((carrier) => carrier.trim()).filter(Boolean));
    entries = entries.filter((entry) => wanted.has(entry.carrier));
  }
  if (statusFilter) {
    const wanted = new Set(statusFilter.split(",").map((status) => status.trim()).filter(Boolean));
    entries = entries.filter((entry) => wanted.has(entry.status));
  }
  if (limit > 0) entries = entries.slice(0, limit);

  const results: VerificationOutput[] = [];
  for (const entry of entries) {
    results.push(await verify(entry, headless));
  }

  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    count: results.length,
    verified: results.filter((result) => result.verified).map((result) => result.carrier),
    failed: results.filter((result) => !result.verified).map((result) => result.carrier),
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
