import { createConfigCarrier, listCarrierCatalog, listCarrierConfigIds } from "../config/adapter.ts";
import type { Carrier } from "../session.ts";
import type { CarrierCatalogEntry } from "../config/adapter.ts";
import {
  cainiaoCarrier,
  chinaPostCarrier,
  fourPxCarrier,
  sfExpressCarrier,
  yanwenCarrier,
} from "./china-crossborder.ts";
import { dhlEcommerceCarrier } from "./dhl-ecommerce.ts";
import { dhlCarrier } from "./dhl.ts";
import { dhlExpressCarrier } from "./dhl-express.ts";
import { dpdUkCarrier } from "./dpd-uk.ts";
import { fedexCarrier } from "./fedex.ts";
import { canadaPostCarrier } from "./canada-post.ts";
import { lasershipCarrier, ontracCarrier } from "./ontrac.ts";
import { purolatorCarrier } from "./purolator.ts";
import { postNordDkCarrier, postNordSeCarrier } from "./postnord.ts";
import { royalMailCarrier } from "./royal-mail.ts";
import { upsCarrier } from "./ups.ts";
import { uspsCarrier } from "./usps.ts";
import { yunExpressCarrier } from "./yunexpress.ts";

export type CarrierFactory = () => Carrier;

export interface RegisteredCarrier {
  id: string;
  displayName: string;
  source: "hand_coded" | "config";
  factory: CarrierFactory;
  catalog: CarrierCatalogEntry | null;
}

const handCodedCatalog: Record<string, Pick<CarrierCatalogEntry, "displayName" | "regions" | "tier" | "trackingNumberPattern">> = {
  "4px": {
    displayName: "4PX",
    regions: ["CN", "GLOBAL"],
    tier: 3,
    trackingNumberPattern: "^4PX[A-Z0-9]{10,24}$|^[A-Z]{2}\\d{9}[A-Z]{2}$",
  },
  cainiao: {
    displayName: "Cainiao",
    regions: ["CN", "GLOBAL"],
    tier: 3,
    trackingNumberPattern: "^(LP\\d{12,18}|S000\\d{8,18}|[A-Z]{2}\\d{9}[A-Z]{2}|[A-Z]{2}\\d{10,24})$",
  },
  "china-post": {
    displayName: "China Post",
    regions: ["CN", "GLOBAL"],
    tier: 1,
    trackingNumberPattern: "^[A-Z]{2}\\d{9}CN$",
  },
  dhl: {
    displayName: "DHL Worldwide",
    regions: ["GLOBAL"],
    tier: 1,
    trackingNumberPattern: "^(\\d{10,11}|3S[A-Z0-9]{10})$",
  },
  "dhl-express": {
    displayName: "DHL Express",
    regions: ["GLOBAL"],
    tier: 1,
    trackingNumberPattern: "^\\d{10}$",
  },
  "dhl-ecommerce": {
    displayName: "DHL eCommerce",
    regions: ["US", "GLOBAL"],
    tier: 2,
    trackingNumberPattern: "^(GM\\d{16,22}|LX[A-Z0-9]{10,24}|RX[A-Z0-9]{10,24}|[A-Z]{2}\\d{9}DE)$",
  },
  "dpd-uk": {
    displayName: "DPD UK",
    regions: ["GB", "EU"],
    tier: 1,
    trackingNumberPattern: "^\\d{14}$|^[A-Z0-9]{10,16}$",
  },
  fedex: {
    displayName: "FedEx",
    regions: ["GLOBAL"],
    tier: 1,
    trackingNumberPattern: "^(\\d{12}|\\d{15}|\\d{20}|\\d{22})$",
  },
  "canada-post": {
    displayName: "Canada Post",
    regions: ["CA"],
    tier: 1,
    trackingNumberPattern: "^[A-Z]{2}\\d{9}CA$|^\\d{16}$",
  },
  ontrac: {
    displayName: "OnTrac",
    regions: ["US"],
    tier: 1,
    trackingNumberPattern: "^[CD]\\d{14}$|^1LS[A-Z0-9]{12,20}$",
  },
  lasership: {
    displayName: "LaserShip",
    regions: ["US"],
    tier: 1,
    trackingNumberPattern: "^1LS[A-Z0-9]{12,20}$|^LX[A-Z0-9]{10,20}$",
  },
  purolator: {
    displayName: "Purolator",
    regions: ["CA", "US"],
    tier: 1,
    trackingNumberPattern: "^[A-Z0-9]{10,35}$",
  },
  "royal-mail": {
    displayName: "Royal Mail",
    regions: ["GB"],
    tier: 1,
    trackingNumberPattern: "^[A-Z]{2}\\d{9}GB$",
  },
  "postnord-se": {
    displayName: "PostNord Sweden",
    regions: ["SE", "Nordics"],
    tier: 1,
    trackingNumberPattern: "^[A-Z]{2}\\d{9}SE$|^[A-Z0-9]{10,24}$",
  },
  "postnord-dk": {
    displayName: "PostNord Denmark",
    regions: ["DK", "Nordics"],
    tier: 1,
    trackingNumberPattern: "^[A-Z]{2}\\d{9}DK$|^[A-Z0-9]{10,24}$",
  },
  "sf-express": {
    displayName: "SF Express",
    regions: ["CN", "GLOBAL"],
    tier: 2,
    trackingNumberPattern: "^(SF\\d{12}|\\d{12,15})$",
  },
  ups: {
    displayName: "UPS",
    regions: ["GLOBAL"],
    tier: 1,
    trackingNumberPattern: "^1Z[A-Z0-9]{16}$",
  },
  usps: {
    displayName: "USPS",
    regions: ["US"],
    tier: 1,
    trackingNumberPattern: "^(92|93|94|95)\\d{18,20}$",
  },
  yunexpress: {
    displayName: "YunExpress",
    regions: ["CN", "GLOBAL"],
    tier: 3,
    trackingNumberPattern: "^YT\\d{16}$|^YUN[A-Z0-9]{10,20}$",
  },
  yanwen: {
    displayName: "Yanwen",
    regions: ["CN", "GLOBAL"],
    tier: 3,
    trackingNumberPattern: "^([A-Z]{2}\\d{9}(YP|CN)|LP\\d{12,18}|YW[A-Z0-9]{8,24})$",
  },
};

const handCodedFactories: Record<string, CarrierFactory> = {
  "4px": () => fourPxCarrier,
  cainiao: () => cainiaoCarrier,
  "canada-post": () => canadaPostCarrier,
  "china-post": () => chinaPostCarrier,
  dhl: () => dhlCarrier,
  "dhl-express": () => dhlExpressCarrier,
  "dhl-ecommerce": () => dhlEcommerceCarrier,
  "dpd-uk": () => dpdUkCarrier,
  fedex: () => fedexCarrier,
  lasership: () => lasershipCarrier,
  ontrac: () => ontracCarrier,
  purolator: () => purolatorCarrier,
  "postnord-dk": () => postNordDkCarrier,
  "postnord-se": () => postNordSeCarrier,
  "royal-mail": () => royalMailCarrier,
  "sf-express": () => sfExpressCarrier,
  ups: () => upsCarrier,
  usps: () => uspsCarrier,
  yanwen: () => yanwenCarrier,
  yunexpress: () => yunExpressCarrier,
};

function handCodedEntry(id: string, factory: CarrierFactory): RegisteredCarrier {
  const catalog = handCodedCatalog[id];
  return {
    id,
    displayName: catalog?.displayName ?? id,
    source: "hand_coded",
    factory,
    catalog: catalog
      ? {
          id,
          displayName: catalog.displayName,
          mode: "scraper",
          regions: catalog.regions,
          tier: catalog.tier,
          trackingNumberPattern: catalog.trackingNumberPattern,
        }
      : null,
  };
}

export function listRegisteredCarriers(): RegisteredCarrier[] {
  const entries = new Map<string, RegisteredCarrier>();

  for (const [id, factory] of Object.entries(handCodedFactories)) {
    entries.set(id, handCodedEntry(id, factory));
  }

  for (const catalog of listCarrierCatalog()) {
    if (entries.has(catalog.id)) continue;
    entries.set(catalog.id, {
      id: catalog.id,
      displayName: catalog.displayName,
      source: "config",
      factory: () => createConfigCarrier(catalog.id),
      catalog,
    });
  }

  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function listRegisteredCarrierIds(): string[] {
  return listRegisteredCarriers().map((carrier) => carrier.id);
}

export function getCarrierFactory(id: string): CarrierFactory | null {
  if (handCodedFactories[id]) return handCodedFactories[id];
  if (listCarrierConfigIds().includes(id)) return () => createConfigCarrier(id);
  return null;
}

export function listPublicCarrierCatalog(): CarrierCatalogEntry[] {
  return listRegisteredCarriers()
    .map((carrier) => carrier.catalog)
    .filter((carrier): carrier is CarrierCatalogEntry => carrier != null);
}
