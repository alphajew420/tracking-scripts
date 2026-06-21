// Public library API. Apps import from here:
//
//   import { TrackingSession, uspsCarrier } from "tracker-ts";
//
//   const session = new TrackingSession(uspsCarrier);
//   const result = await session.track("9400...");
//   await session.close();

export {
  TrackingSession,
  trackOnce,
  type Carrier,
  type ScraperCarrier,
  type SessionOptions,
} from "./session.ts";

export type {
  Event,
  ScrapeResult,
  Status,
  Track,
} from "./types.ts";

export {
  createConfigCarrier,
  createConfigScraperCarrier,
  listCarrierConfigIds,
  loadCarrierConfig,
  type CarrierAdapterConfig,
  type CarrierCatalogEntry,
} from "./config/adapter.ts";
export {
  getCarrierFactory,
  listPublicCarrierCatalog,
  listRegisteredCarrierIds,
  listRegisteredCarriers,
  type CarrierFactory,
  type RegisteredCarrier,
} from "./carriers/registry.ts";
export { detectCarrier, type CarrierCandidate } from "./detect.ts";
export {
  deliverWebhook,
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_RETRY_DELAYS_MS,
  type WebhookDeliveryResult,
  type WebhookEndpoint,
  type WebhookEvent,
  type WebhookEventType,
} from "./webhooks.ts";

// Hand-coded scraper carriers.
export { dhlCarrier } from "./carriers/dhl.ts";
export { dhlExpressCarrier, createDhlExpressCarrier } from "./carriers/dhl-express.ts";
export { fedexCarrier, createFedexCarrier } from "./carriers/fedex.ts";
export { upsCarrier } from "./carriers/ups.ts";
export { uspsCarrier } from "./carriers/usps.ts";
