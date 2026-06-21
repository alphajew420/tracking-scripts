import { URL } from "node:url";

export function pageParams(url: URL) {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  return { limit, offset };
}

export function bulkRows(body: Record<string, unknown>): { ok: true; rows: unknown[] } | { ok: false; message: string } {
  if (!Array.isArray(body.trackings)) return { ok: false, message: "trackings must be an array" };
  if (body.trackings.length === 0) return { ok: false, message: "trackings must include at least one item" };
  if (body.trackings.length > 40) return { ok: false, message: "bulk requests are limited to 40 trackings" };
  return { ok: true, rows: body.trackings };
}

export function validWebhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || (process.env.NODE_ENV !== "production" && parsed.protocol === "http:");
  } catch {
    return false;
  }
}
