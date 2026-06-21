import { listCarrierConfigIds, loadCarrierConfig } from "../config/adapter.ts";
import { listPublicCarrierCatalog, listRegisteredCarrierIds } from "../carriers/registry.ts";

const requiredStatuses = ["delivered", "exception", "pickup", "in_transit"] as const;
const ids = listCarrierConfigIds();
const errors: string[] = [];

function assert(condition: unknown, message: string) {
  if (!condition) errors.push(message);
}

function isValidUrlTemplate(value: string): boolean {
  try {
    new URL(value.replaceAll("{n}", "TRACKINGNUMBER"));
    return true;
  } catch {
    return false;
  }
}

for (const id of ids) {
  let config;
  try {
    config = loadCarrierConfig(id);
  } catch (error) {
    errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  assert(config.id === id, `${id}: config id must match filename`);
  assert(isValidUrlTemplate(config.warmUrl), `${id}: warmUrl must be an absolute URL template`);
  if (config.fetchUrl) {
    assert(isValidUrlTemplate(config.fetchUrl), `${id}: fetchUrl must be an absolute URL template`);
  }
  if (config.queryStrategy === "json_endpoint") {
    assert(config.parseJson?.eventsPath, `${id}: json_endpoint requires parseJson.eventsPath`);
    assert(config.parseJson?.descriptionPath, `${id}: json_endpoint requires parseJson.descriptionPath`);
  } else {
    assert(config.parseHtml?.events, `${id}: ${config.queryStrategy} requires parseHtml.events`);
    assert(config.parseHtml?.description, `${id}: ${config.queryStrategy} requires parseHtml.description`);
  }

  if (config.trackingNumberPattern) {
    try {
      new RegExp(config.trackingNumberPattern, "i");
    } catch (error) {
      errors.push(`${id}: invalid trackingNumberPattern: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const rule of config.statusMap) {
    try {
      new RegExp(rule.pattern, rule.flags ?? "i");
    } catch (error) {
      errors.push(`${id}: invalid statusMap pattern for ${rule.status}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const pattern of config.failurePatterns ?? []) {
    try {
      new RegExp(pattern, "i");
    } catch (error) {
      errors.push(`${id}: invalid failurePatterns regex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const statuses = new Set(config.statusMap.map((rule) => rule.status));
  for (const status of requiredStatuses) {
    assert(statuses.has(status), `${id}: missing ${status} statusMap rule`);
  }
}

const registeredIds = listRegisteredCarrierIds();
const duplicateIds = registeredIds.filter((id, index) => registeredIds.indexOf(id) !== index);
assert(duplicateIds.length === 0, `duplicate registered carrier ids: ${duplicateIds.join(", ")}`);

const catalogIds = new Set(listPublicCarrierCatalog().map((carrier) => carrier.id));
for (const id of registeredIds) {
  assert(catalogIds.has(id), `${id}: registered carrier is missing from public catalog`);
}

if (errors.length > 0) {
  console.error(`Carrier validation failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Validated ${ids.length} config carriers and ${registeredIds.length} registered carriers.`);
