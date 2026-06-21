import { listCarrierApiAdapterIds, registerBuiltInCarrierApiAdapters } from "../carriers/api-registry.ts";
import { listRegisteredCarrierIds } from "../carriers/registry.ts";

const errors: string[] = [];

function assert(condition: unknown, message: string) {
  if (!condition) errors.push(message);
}

registerBuiltInCarrierApiAdapters();

const registeredIds = listRegisteredCarrierIds();
const adapterIds = listCarrierApiAdapterIds();
const registeredSet = new Set(registeredIds);
const adapterSet = new Set(adapterIds);

for (const id of registeredIds) {
  assert(adapterSet.has(id), `${id}: registered carrier is missing an API adapter`);
}

for (const id of adapterIds) {
  assert(registeredSet.has(id), `${id}: API adapter exists without a registered carrier`);
}

assert(
  registeredIds.length === adapterIds.length,
  `registry mismatch: ${registeredIds.length} registered carriers vs ${adapterIds.length} API adapters`,
);

if (errors.length > 0) {
  console.error(`Carrier API registry validation failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Validated ${registeredIds.length} carrier registrations and ${adapterIds.length} API adapters.`);
