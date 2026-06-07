export type Status =
  | "in_transit"
  | "delivered"
  | "pickup"
  | "exception"
  | "warning"
  | "unknown";

export interface Event {
  date: string | null;
  location: string;
  description: string;
  status: Status;
}

export interface TrackAddress {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface Track {
  carrier: string;
  trackingNumber: string;
  delivered: boolean;
  recipient?: string;
  events: Event[];
  /** Optional richer fields populated when the carrier API returns them.
   *  Saved onto ParsedOrder on refresh so the value sticks long after the
   *  carrier-side data ages out. */
  shippingAddress?: TrackAddress;
  weightGrams?: number;
  dimensionsCm?: { length: number; width: number; height: number };
  signedBy?: string;
  serviceLevel?: string;
  /** Verbatim carrier JSON for forensics (clamped at the route layer). */
  raw?: Record<string, unknown>;
}

export type Carrier = "dhl" | "dhl-express" | "ups" | "fedex" | "usps";

export interface ScrapeResult {
  ok: boolean;
  track?: Track;
  error?: string;
}
