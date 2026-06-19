import { listCarrierCatalog } from "./config/adapter.ts";

export interface CarrierCandidate {
  carrier: string;
  confidence: number;
  reason: string;
}

interface Detector {
  carrier: string;
  confidence: number;
  reason: string;
  pattern: RegExp;
}

const DETECTORS: Detector[] = [
  {
    carrier: "ups",
    confidence: 0.99,
    reason: "UPS 1Z tracking-number format",
    pattern: /^1Z[A-Z0-9]{16}$/i,
  },
  {
    carrier: "usps",
    confidence: 0.95,
    reason: "USPS IMpb 20-22 digit format",
    pattern: /^(92|93|94|95)\d{18,20}$/,
  },
  {
    carrier: "fedex",
    confidence: 0.86,
    reason: "FedEx numeric tracking-number length",
    pattern: /^(\d{12}|\d{15}|\d{20}|\d{22})$/,
  },
  {
    carrier: "dhl",
    confidence: 0.82,
    reason: "DHL parcel numeric or 3S format",
    pattern: /^(\d{10,11}|3S[A-Z0-9]{10})$/i,
  },
  {
    carrier: "dhl-express",
    confidence: 0.82,
    reason: "DHL Express 10-digit format",
    pattern: /^\d{10}$/,
  },
  {
    carrier: "royal-mail",
    confidence: 0.96,
    reason: "UPU S10 number ending in GB",
    pattern: /^[A-Z]{2}\d{9}GB$/i,
  },
  {
    carrier: "canada-post",
    confidence: 0.94,
    reason: "UPU S10 number ending in CA",
    pattern: /^[A-Z]{2}\d{9}CA$/i,
  },
  {
    carrier: "la-poste",
    confidence: 0.94,
    reason: "UPU S10 number ending in FR",
    pattern: /^[A-Z]{2}\d{9}FR$/i,
  },
  {
    carrier: "deutsche-post",
    confidence: 0.94,
    reason: "UPU S10 number ending in DE",
    pattern: /^[A-Z]{2}\d{9}DE$/i,
  },
  {
    carrier: "japan-post",
    confidence: 0.94,
    reason: "UPU S10 number ending in JP",
    pattern: /^[A-Z]{2}\d{9}JP$/i,
  },
  {
    carrier: "china-post",
    confidence: 0.96,
    reason: "UPU S10 number ending in CN",
    pattern: /^[A-Z]{2}\d{9}CN$/i,
  },
  {
    carrier: "ontrac",
    confidence: 0.91,
    reason: "OnTrac C/D-prefix or 1LS format",
    pattern: /^([CD]\d{14}|1LS[A-Z0-9]{12,20})$/i,
  },
  {
    carrier: "lasership",
    confidence: 0.88,
    reason: "LaserShip 1LS/LX format",
    pattern: /^(1LS[A-Z0-9]{12,20}|LX[A-Z0-9]{10,20})$/i,
  },
  {
    carrier: "yunexpress",
    confidence: 0.9,
    reason: "YunExpress YT/YUN format",
    pattern: /^(YT\d{16}|YUN[A-Z0-9]{10,20})$/i,
  },
  {
    carrier: "4px",
    confidence: 0.86,
    reason: "4PX-prefixed format",
    pattern: /^4PX[A-Z0-9]{10,24}$/i,
  },
];

function normalizeTrackingNumber(num: string): string {
  return num.replace(/\s|-/g, "").toUpperCase();
}

export function detectCarrier(num: string): CarrierCandidate[] {
  const normalized = normalizeTrackingNumber(num);
  const candidates = new Map<string, CarrierCandidate>();

  for (const detector of DETECTORS) {
    if (!detector.pattern.test(normalized)) continue;
    candidates.set(detector.carrier, {
      carrier: detector.carrier,
      confidence: detector.confidence,
      reason: detector.reason,
    });
  }

  const hasStrongMatch = Array.from(candidates.values()).some(
    (candidate) => candidate.confidence >= 0.85,
  );
  if (!hasStrongMatch) {
    for (const carrier of listCarrierCatalog()) {
      if (!carrier.trackingNumberPattern) continue;
      const pattern = new RegExp(carrier.trackingNumberPattern, "i");
      if (!pattern.test(normalized) || candidates.has(carrier.id)) continue;
      candidates.set(carrier.id, {
        carrier: carrier.id,
        confidence: 0.62,
        reason: "carrier registry trackingNumberPattern match",
      });
    }
  }

  return Array.from(candidates.values()).sort(
    (a, b) => b.confidence - a.confidence || a.carrier.localeCompare(b.carrier),
  );
}
