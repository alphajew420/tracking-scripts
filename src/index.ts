// Public library API. Apps import from here:
//
//   import { TrackingSession, uspsCarrier, createUpsApiCarrier } from "tracker-ts";
//
//   // Scraper (no creds, fragile):
//   const s1 = new TrackingSession(uspsCarrier);
//   const r1 = await s1.track("9400...");
//   await s1.close();
//
//   // Official API (creds required, stable):
//   const s2 = new TrackingSession(
//     createUpsApiCarrier({ clientId: "...", clientSecret: "..." })
//   );
//   const r2 = await s2.track("1Z...");
//   await s2.close();

export {
  TrackingSession,
  trackOnce,
  type Carrier,
  type ScraperCarrier,
  type ApiCarrier,
  type SessionOptions,
} from "./session.ts";

export type {
  Event,
  ScrapeResult,
  Status,
  Track,
} from "./types.ts";

// Scraper carriers — CLI/dev-only. The Shippified production app (src/server/, src/app/)
// must not import these; carrier tracking in production goes through the API carriers below,
// which return a clean "missing credentials" error when keys aren't configured.
export { dhlCarrier } from "./carriers/dhl.ts";
export { dhlExpressCarrier } from "./carriers/dhl-express.ts";
export { fedexCarrier, createFedexCarrier } from "./carriers/fedex.ts";
export { upsCarrier } from "./carriers/ups.ts";
export { uspsCarrier } from "./carriers/usps.ts";

// API carriers (free for these 4 — USPS tracking API is paid, so scraper-only).
export {
  createDhlApiCarrier,
  type DhlApiOptions,
} from "./carriers/dhl-api.ts";
export { createDhlExpressApiCarrier } from "./carriers/dhl-express-api.ts";
export {
  createUpsApiCarrier,
  type UpsApiOptions,
} from "./carriers/ups-api.ts";
export {
  createFedexApiCarrier,
  type FedexApiOptions,
} from "./carriers/fedex-api.ts";
