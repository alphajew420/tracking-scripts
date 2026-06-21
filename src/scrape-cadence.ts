export type ScrapeCadenceStatus =
  | "not_yet_scanned"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "unknown";

const CADENCE_MINUTES: Partial<Record<ScrapeCadenceStatus, number>> = {
  not_yet_scanned: 240,
  in_transit: 120,
  out_for_delivery: 30,
};

export function scrapeCadenceInterval(status: string): string | null {
  switch (status) {
    case "not_yet_scanned":
      return "4 hours";
    case "in_transit":
      return "2 hours";
    case "out_for_delivery":
      return "30 minutes";
    default:
      return null;
  }
}

export function nextScrapeAt(status: ScrapeCadenceStatus | string, from = new Date()): string | null {
  const value = CADENCE_MINUTES[status as ScrapeCadenceStatus];
  return value ? new Date(from.getTime() + value * 60_000).toISOString() : null;
}

export function initialScrapeFallbackAt(from = new Date()): string {
  return new Date(from.getTime() + 60_000).toISOString();
}

export function failedScrapeRetryAt(from = new Date()): string {
  return new Date(from.getTime() + 15 * 60_000).toISOString();
}
