import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listRegisteredCarriers } from "../carriers/registry.ts";

interface ValidationResult {
  carrier: string;
  status: "verified" | "implemented_needs_retest" | "scaffolded_unverified" | string;
  sample?: string;
  result?: string;
}

interface ValidationFile {
  generated_at: string;
  policy: string;
  results: ValidationResult[];
}

const validationPath = join(process.cwd(), "data/carrier-catalogs/module-validation-results.json");
const validation = JSON.parse(readFileSync(validationPath, "utf8")) as ValidationFile;
const registeredCarriers = listRegisteredCarriers();
const registered = registeredCarriers.map((carrier) => carrier.id);
const byCarrier = new Map(validation.results.map((result) => [result.carrier, result]));

const verified = registered.filter((id) => byCarrier.get(id)?.status === "verified");
const implementedNeedsRetest = registered.filter((id) => byCarrier.get(id)?.status === "implemented_needs_retest");
const scaffolded = registered.filter((id) => byCarrier.get(id)?.status === "scaffolded_unverified");
const unvalidatedHandCoded = registeredCarriers
  .filter((carrier) => carrier.source === "hand_coded" && !byCarrier.has(carrier.id))
  .map((carrier) => carrier.id);
const unvalidatedConfig = registeredCarriers
  .filter((carrier) => carrier.source === "config" && !byCarrier.has(carrier.id))
  .map((carrier) => carrier.id);

const output = {
  generated_at: new Date().toISOString(),
  validation_generated_at: validation.generated_at,
  policy: validation.policy,
  counts: {
    registered: registered.length,
    verified: verified.length,
    implemented_needs_retest: implementedNeedsRetest.length,
    scaffolded_unverified: scaffolded.length,
    unvalidated_hand_coded: unvalidatedHandCoded.length,
    unvalidated_config: unvalidatedConfig.length,
  },
  verified,
  implemented_needs_retest: implementedNeedsRetest,
  scaffolded_unverified: scaffolded,
  unvalidated_hand_coded: unvalidatedHandCoded,
  unvalidated_config: unvalidatedConfig,
};

console.log(JSON.stringify(output, null, 2));
