import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CarrierVerificationStatus =
  | "verified"
  | "implemented_needs_retest"
  | "scaffolded_unverified"
  | "unvalidated";

export interface CarrierVerification {
  carrier: string;
  status: CarrierVerificationStatus;
  sample?: string;
  sample_source?: string;
  result?: string;
  efficiency_path?: string;
}

interface ValidationFile {
  results?: Array<Omit<CarrierVerification, "status"> & { status?: string }>;
}

let cache: Map<string, CarrierVerification> | null = null;

function loadVerificationMap(): Map<string, CarrierVerification> {
  if (cache) return cache;
  const path = join(process.cwd(), "data/carrier-catalogs/module-validation-results.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ValidationFile;
  cache = new Map();
  for (const row of parsed.results ?? []) {
    const status =
      row.status === "verified" ||
      row.status === "implemented_needs_retest" ||
      row.status === "scaffolded_unverified"
        ? row.status
        : "unvalidated";
    cache.set(row.carrier, { ...row, status });
  }
  return cache;
}

export function carrierVerification(id: string): CarrierVerification {
  return loadVerificationMap().get(id) ?? { carrier: id, status: "unvalidated" };
}
