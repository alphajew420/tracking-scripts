import type { ApiCarrier } from "../session.ts";
import { createDhlApiCarrier, type DhlApiOptions } from "./dhl-api.ts";

/**
 * Thin wrapper around the unified DHL API with service=express. Same key
 * works (DHL_API_KEY env var). Separate factory so the app can register
 * "dhl-express" distinctly from "dhl".
 */
export function createDhlExpressApiCarrier(
  opts: Omit<DhlApiOptions, "service" | "name"> = {},
): ApiCarrier {
  return createDhlApiCarrier({ ...opts, service: "express", name: "dhl-express" });
}
