import { readFileSync } from "node:fs";
import { join } from "node:path";
import { carrierVerification, type CarrierVerification } from "@/src/carriers/verification.ts";

export type CarrierValidationState = "verified" | "needs_retest" | "needs_real_sample" | "unvalidated";

export interface CarrierValidationSummary {
  carrier: string;
  status: CarrierValidationState;
  sample: string | null;
  sample_source: string | null;
  result: string | null;
  efficiency_path: string | null;
}

interface ValidationFile {
  results?: Array<Omit<CarrierVerification, "status"> & { status?: string }>;
}

let cache: Map<string, CarrierValidationSummary> | null = null;

function loadMap(): Map<string, CarrierValidationSummary> {
  if (cache) return cache;
  const path = join(process.cwd(), "data/carrier-catalogs/module-validation-results.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ValidationFile;
  cache = new Map();
  for (const row of parsed.results ?? []) {
    const status: CarrierValidationState =
      row.status === "verified"
        ? "verified"
        : row.status === "implemented_needs_retest"
          ? "needs_retest"
          : row.status === "scaffolded_unverified"
            ? "needs_real_sample"
            : "unvalidated";
    cache.set(row.carrier, {
      carrier: row.carrier,
      status,
      sample: row.sample ?? null,
      sample_source: row.sample_source ?? null,
      result: row.result ?? null,
      efficiency_path: row.efficiency_path ?? null,
    });
  }
  return cache;
}

export function getCarrierValidation(carrierId: string): CarrierValidationSummary {
  return loadMap().get(carrierId) ?? {
    carrier: carrierId,
    status: carrierVerification(carrierId).status === "verified"
      ? "verified"
      : carrierVerification(carrierId).status === "implemented_needs_retest"
        ? "needs_retest"
        : carrierVerification(carrierId).status === "scaffolded_unverified"
          ? "needs_real_sample"
          : "unvalidated",
    sample: carrierVerification(carrierId).sample ?? null,
    sample_source: carrierVerification(carrierId).sample_source ?? null,
    result: carrierVerification(carrierId).result ?? null,
    efficiency_path: carrierVerification(carrierId).efficiency_path ?? null,
  };
}

export function listCarrierValidationSummary() {
  const values = [...loadMap().values()];
  const counts = values.reduce(
    (acc, row) => {
      acc[row.status] += 1;
      return acc;
    },
    {
      verified: 0,
      needs_retest: 0,
      needs_real_sample: 0,
      unvalidated: 0,
    } as Record<CarrierValidationState, number>,
  );
  return { counts, values };
}
