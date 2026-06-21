import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthContext } from "../api/types.ts";
import { carrierVerification } from "./verification.ts";
import { listRegisteredCarriers } from "./registry.ts";

export interface CarrierApiContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  requestId: string;
  auth: AuthContext;
  carrierId: string;
  carrier: Record<string, unknown> | null;
  json: (status: number, body: unknown) => void;
  error: (status: number, code: string, message: string) => void;
}

export interface CarrierApiAdapter {
  describe?: (carrierId: string) => Record<string, unknown> | null;
  handleRequest?: (ctx: CarrierApiContext) => Promise<boolean> | boolean;
}

export interface CarrierApiCatalogEntry {
  id: string;
  display_name: string;
  source: "hand_coded" | "config";
  api: Record<string, unknown>;
}

const carrierApiAdapters = new Map<string, CarrierApiAdapter>();
let builtInsInitialized = false;

function matchCarrierRoute(pathname: string, carrierId: string, suffix: string): boolean {
  return pathname === `/v1/carriers/${carrierId}${suffix}`;
}

export function registerCarrierApiAdapter(carrierId: string, adapter: CarrierApiAdapter): void {
  carrierApiAdapters.set(carrierId, adapter);
}

export function ensureBuiltInCarrierApiAdapters(): void {
  if (builtInsInitialized) return;
  builtInsInitialized = true;
  for (const carrier of listRegisteredCarriers()) {
    registerCarrierApiAdapter(carrier.id, createCarrierApiAdapter(carrier));
  }
}

export function getCarrierApiAdapter(carrierId: string): CarrierApiAdapter | null {
  ensureBuiltInCarrierApiAdapters();
  return carrierApiAdapters.get(carrierId) ?? null;
}

export function listCarrierApiAdapterIds(): string[] {
  ensureBuiltInCarrierApiAdapters();
  return [...carrierApiAdapters.keys()].sort();
}

function createCarrierApiAdapter(carrier: ReturnType<typeof listRegisteredCarriers>[number]): CarrierApiAdapter {
  const verification = carrierVerification(carrier.id);

  return {
    describe: () => ({
      id: carrier.id,
      display_name: carrier.displayName,
      source: carrier.source,
      mode: carrier.catalog?.mode ?? "scraper",
      regions: carrier.catalog?.regions ?? [],
      tier: carrier.catalog?.tier ?? null,
      tracking_number_pattern: carrier.catalog?.trackingNumberPattern ?? null,
      validation: {
        endpoint: `/v1/carriers/${carrier.id}/validate?number={number}`,
        pattern: carrier.catalog?.trackingNumberPattern ?? null,
        checks: ["format"],
      },
      tracking: {
        state: "scraper",
        notes: carrier.source === "config" ? "Config-backed carrier adapter." : "Hand-coded carrier adapter.",
      },
      verification,
    }),
    handleRequest: async ({ req, url, carrierId, json, error }) => {
      if (req.method !== "GET") return false;
      if (matchCarrierRoute(url.pathname, carrierId, "/validate")) {
        const number = url.searchParams.get("number");
        if (!number) {
          error(400, "bad_request", "number is required");
          return true;
        }
        const pattern = carrier.catalog?.trackingNumberPattern ? new RegExp(carrier.catalog.trackingNumberPattern, "i") : null;
        json(200, {
          carrier: carrierId,
          number,
          valid: pattern ? pattern.test(number) : true,
          pattern: carrier.catalog?.trackingNumberPattern ?? null,
          source: carrier.source,
          verification,
        });
        return true;
      }
      return false;
    },
  };
}

export function registerBuiltInCarrierApiAdapters(): void {
  ensureBuiltInCarrierApiAdapters();
}

export function listCarrierApiCatalog(): CarrierApiCatalogEntry[] {
  ensureBuiltInCarrierApiAdapters();
  return listRegisteredCarriers().map((carrier) => ({
    id: carrier.id,
    display_name: carrier.displayName,
    source: carrier.source,
    api: createCarrierApiAdapter(carrier).describe?.(carrier.id) ?? {},
  }));
}
