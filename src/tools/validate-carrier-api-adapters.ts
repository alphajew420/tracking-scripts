import { URL } from "node:url";
import {
  getCarrierApiAdapter,
  listCarrierApiAdapterIds,
  listCarrierApiCatalog,
  registerBuiltInCarrierApiAdapters,
} from "../carriers/api-registry.ts";
import { listRegisteredCarriers } from "../carriers/registry.ts";

interface CapturedResponse {
  status: number | null;
  body: unknown;
  code: string | null;
  message: string | null;
}

const errors: string[] = [];

function assert(condition: unknown, message: string) {
  if (!condition) errors.push(message);
}

function captureContext() {
  const response: CapturedResponse = { status: null, body: null, code: null, message: null };
  return {
    response,
    json(status: number, body: unknown) {
      response.status = status;
      response.body = body;
    },
    error(status: number, code: string, message: string) {
      response.status = status;
      response.code = code;
      response.message = message;
    },
  };
}

registerBuiltInCarrierApiAdapters();

const carriers = listRegisteredCarriers();
const adapterIds = listCarrierApiAdapterIds();
const catalog = listCarrierApiCatalog();

assert(
  carriers.length === adapterIds.length,
  `carrier count mismatch: ${carriers.length} registrations vs ${adapterIds.length} adapters`,
);
assert(
  carriers.length === catalog.length,
  `carrier count mismatch: ${carriers.length} registrations vs ${catalog.length} adapter catalog entries`,
);

for (const carrier of carriers) {
  const adapter = getCarrierApiAdapter(carrier.id);
  assert(adapter != null, `${carrier.id}: missing adapter`);
  if (!adapter) continue;

  const manifest = adapter.describe?.(carrier.id);
  assert(manifest != null, `${carrier.id}: describe() returned null`);
  assert(typeof manifest === "object", `${carrier.id}: describe() must return an object`);

  const ctx = captureContext();
  const handled = await adapter.handleRequest?.({
    req: { method: "GET" } as never,
    res: {} as never,
    url: new URL(`https://example.com/v1/carriers/${carrier.id}/validate?number=TRACK123456`),
    requestId: `test-${carrier.id}`,
    auth: { accountId: "acct_test", apiKeyId: "key_test", userId: null, mode: "test", scopes: ["read:carriers"] },
    carrierId: carrier.id,
    carrier: {
      id: carrier.id,
      display_name: carrier.displayName,
      source: carrier.source,
    },
    json: ctx.json,
    error: ctx.error,
  });

  assert(handled === true, `${carrier.id}: /validate route was not handled`);
  assert(ctx.response.status === 200, `${carrier.id}: /validate did not return 200`);
  assert(ctx.response.body != null, `${carrier.id}: /validate did not return a body`);
  assert(
    typeof ctx.response.body === "object" &&
      ctx.response.body !== null &&
      (ctx.response.body as { carrier?: string }).carrier === carrier.id,
    `${carrier.id}: /validate body did not include the carrier id`,
  );
}

if (errors.length > 0) {
  console.error(`Carrier API adapter validation failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Validated ${carriers.length} carrier adapters, manifests, and validate routes.`);
