import { SessionPool } from "../workers/session-pool.ts";

const trackingNumber = process.argv[2] ?? process.env.FEDEX_CANARY_TRACKING_NUMBER ?? "382150811542";
const timeoutMs = Number(process.env.FEDEX_CANARY_TIMEOUT_MS ?? 180_000);

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`FedEx canary timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const startedAt = Date.now();
const pool = new SessionPool();

try {
  const result = await withTimeout(pool.track("fedex", trackingNumber), timeoutMs);
  const elapsedMs = Date.now() - startedAt;
  const passed = result.ok && Boolean(result.track);
  const summary = passed
    ? {
        ok: true,
        elapsed_ms: elapsedMs,
        tracking_number: trackingNumber,
        delivered: result.track!.delivered,
        event_count: result.track!.events.length,
        first_event: result.track!.events[0] ?? null,
        runtime: {
          proxy_mode: process.env.PROXY_FEDEX_MODE ?? process.env.PROXY_MODE ?? null,
          track_surface: process.env.FEDEX_TRACK_SURFACE ?? null,
          browser_channel: process.env.BROWSER_CHANNEL_FEDEX ?? process.env.BROWSER_CHANNEL ?? null,
          headless_fedex: process.env.HEADLESS_FEDEX ?? null,
          user_agent_mode: process.env.BROWSER_USER_AGENT_FEDEX ?? process.env.BROWSER_USER_AGENT ?? null,
          has_fixed_proxy_session: Boolean(process.env.PROXY_SESSION_FEDEX ?? process.env.PROXY_SESSION),
          fallback_session_count: (process.env.PROXY_SESSION_FALLBACKS_FEDEX ?? process.env.PROXY_SESSION_FALLBACKS ?? "")
            .split(",")
            .filter((value) => value.trim()).length,
        },
      }
    : {
        ok: false,
        elapsed_ms: elapsedMs,
        tracking_number: trackingNumber,
        error: result.ok ? "FedEx canary returned no normalized track" : result.error,
      };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(passed ? 0 : 1);
} finally {
  await pool.close();
}
