import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookEventType =
  | "tracking.created"
  | "tracking.updated"
  | "tracking.status_changed"
  | "tracking.delivered"
  | "tracking.exception"
  | "tracking.expired";

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  created_at: string;
  data: unknown;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  eventTypes: WebhookEventType[];
  consecutiveFailures?: number;
  disabledAt?: string | null;
}

export interface WebhookDeliveryResult {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

export const WEBHOOK_RETRY_DELAYS_MS = [
  30_000,
  5 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

export function signWebhookBody(body: string, secret: string, timestamp = Date.now()): string {
  const seconds = Math.floor(timestamp / 1000);
  const payload = `${seconds}.${body}`;
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return `t=${seconds},v1=${hmac}`;
}

export function verifyWebhookSignature(params: {
  body: string;
  secret: string;
  header: string;
  now?: number;
  toleranceMs?: number;
}): boolean {
  const parts = Object.fromEntries(
    params.header.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    }),
  );
  const timestampSeconds = Number(parts.t);
  if (!Number.isFinite(timestampSeconds) || !parts.v1) return false;

  const now = params.now ?? Date.now();
  const toleranceMs = params.toleranceMs ?? 5 * 60_000;
  if (Math.abs(now - timestampSeconds * 1000) > toleranceMs) return false;

  const expected = signWebhookBody(params.body, params.secret, timestampSeconds * 1000)
    .split("v1=")[1]!;
  const actual = parts.v1;
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverWebhook(
  endpoint: WebhookEndpoint,
  event: WebhookEvent,
  opts: { retryDelaysMs?: readonly number[]; fetchFn?: typeof fetch } = {},
): Promise<WebhookDeliveryResult> {
  if (endpoint.disabledAt) {
    return { ok: false, attempts: 0, error: "webhook endpoint disabled" };
  }
  if (!endpoint.eventTypes.includes(event.type)) {
    return { ok: true, attempts: 0 };
  }

  const body = JSON.stringify(event);
  const retryDelays = opts.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS;
  const fetchFn = opts.fetchFn ?? fetch;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const response = await fetchFn(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tracking-signature": signWebhookBody(body, endpoint.secret),
        },
        body,
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, attempts: attempt + 1, status: response.status };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String((error as Error).message ?? error);
    }

    const delay = retryDelays[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }

  return {
    ok: false,
    attempts: retryDelays.length + 1,
    status: lastStatus,
    error: lastError,
  };
}
