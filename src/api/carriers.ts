import { pageParams } from "../api-helpers.ts";
import type { ApiRouteContext } from "./types.ts";
import { getCarrierApiAdapter, listCarrierApiCatalog } from "../carriers/api-registry.ts";
import { listCarrierValidationSummary } from "../../lib/carrier-validation.ts";

export async function handleCarrierRoutes({ req, res, url, requestId, auth, deps }: ApiRouteContext): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/carriers") {
    const { limit, offset } = pageParams(url);
    const catalog = deps.publicCarrierCatalog();
    deps.json(res, 200, { data: catalog.slice(offset, offset + limit), pagination: { limit, offset, total: catalog.length } }, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/carriers/adapters") {
    const { limit, offset } = pageParams(url);
    const catalog = listCarrierApiCatalog();
    deps.json(res, 200, { data: catalog.slice(offset, offset + limit), pagination: { limit, offset, total: catalog.length } }, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/carriers/status") {
    const summary = listCarrierValidationSummary();
    deps.json(res, 200, summary, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/carriers/detect") {
    const number = url.searchParams.get("number");
    if (!number) {
      deps.error(res, 400, "bad_request", "number is required", requestId);
      return true;
    }
    deps.json(res, 200, { tracking_number: number, candidates: deps.detectCarrier(number) }, requestId);
    return true;
  }

  const carrierMatch = /^\/v1\/carriers\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && carrierMatch) {
    const carrierId = carrierMatch[1]!;
    const carrier = deps.publicCarrierCatalog().find((item) => (item as { id?: string }).id === carrierId);
    if (!carrier) {
      deps.error(res, 404, "not_found", "carrier not found", requestId);
      return true;
    }
    const adapter = getCarrierApiAdapter(carrierId);
    const apiDetails = adapter?.describe?.(carrierId) ?? null;
    deps.json(res, 200, apiDetails ? { ...carrier, api: apiDetails } : carrier, requestId);
    return true;
  }

  const carrierAction = /^\/v1\/carriers\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (carrierAction) {
    const adapter = getCarrierApiAdapter(carrierAction[1]!);
    if (!adapter?.handleRequest) return false;
    return adapter.handleRequest({
      req,
      res,
      url,
      requestId,
      auth,
      carrierId: carrierAction[1]!,
      carrier: deps.publicCarrierCatalog().find((item) => (item as { id?: string }).id === carrierAction[1]!) as Record<string, unknown> | null,
      json: (status, body) => deps.json(res, status, body, requestId),
      error: (status, code, message) => deps.error(res, status, code, message, requestId),
    });
  }

  return false;
}
