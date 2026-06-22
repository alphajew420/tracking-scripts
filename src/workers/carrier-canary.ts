import { createLogger } from "../logger.ts";
import { migrate, pool } from "../db.ts";
import { sendDiscordWebhook } from "../discord.ts";
import { activeProxySession, markProxySessionBad, proxySessionHealth } from "../proxy-session-manager.ts";
import { SessionPool } from "./session-pool.ts";

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function carrierEnv(name: string, carrier: string): string | undefined {
  return process.env[`${name}_${carrier.toUpperCase().replaceAll("-", "_")}`] ?? process.env[name];
}

function canaryNumber(carrier: string): string | null {
  const value = carrierEnv("CANARY_TRACKING_NUMBER", carrier) ?? carrierEnv("FEDEX_CANARY_TRACKING_NUMBER", carrier);
  return value && value.trim() ? value.trim() : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runCanary(carrier: string, poolSessions: SessionPool): Promise<boolean> {
  const logger = createLogger(`canary:${carrier}`);
  const number = canaryNumber(carrier);
  if (!number) {
    logger.warn("missing canary tracking number");
    return false;
  }

  const timeoutMs = Number(carrierEnv("CANARY_TIMEOUT_MS", carrier) ?? process.env.FEDEX_CANARY_TIMEOUT_MS ?? 240_000);
  const startedAt = Date.now();
  const sessionBefore = carrier === "fedex" ? await activeProxySession(carrier) : null;

  try {
    const result = await withTimeout(
      poolSessions.track(carrier, number),
      timeoutMs,
      `${carrier}: canary timed out`,
    );
    const elapsedMs = Date.now() - startedAt;
    if (result.ok && result.track?.events.length) {
      logger.info("passed", {
        elapsed_ms: elapsedMs,
        tracking_number: number,
        event_count: result.track.events.length,
        proxy_session: sessionBefore,
      });
      return true;
    }

    const reason = result.ok ? "canary returned no normalized events" : result.error ?? "canary failed";
    logger.warn("failed", { elapsed_ms: elapsedMs, reason, proxy_session: sessionBefore });
    if (carrier === "fedex") {
      const next = await markProxySessionBad({ carrier, session: sessionBefore, reason });
      await sendDiscordWebhook(`Trackified ${carrier} canary failed: ${reason}. Rotated session ${sessionBefore ?? "unknown"} -> ${next ?? "unknown"}.`);
    }
    await poolSessions.invalidate(carrier);
    return false;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn("failed", { elapsed_ms: Date.now() - startedAt, reason, proxy_session: sessionBefore });
    if (carrier === "fedex") {
      const next = await markProxySessionBad({ carrier, session: sessionBefore, reason });
      await sendDiscordWebhook(`Trackified ${carrier} canary failed: ${reason}. Rotated session ${sessionBefore ?? "unknown"} -> ${next ?? "unknown"}.`);
    }
    await poolSessions.invalidate(carrier);
    return false;
  }
}

async function run(): Promise<void> {
  const logger = createLogger("carrier-canary");
  await migrate();
  const carrier = process.argv[2] ?? process.env.CANARY_CARRIER ?? "fedex";
  const intervalMs = Number(carrierEnv("CANARY_INTERVAL_MS", carrier) ?? 15 * 60_000);
  const once = booleanEnv("CANARY_ONCE", false) || process.argv.includes("--once");
  const poolSessions = new SessionPool();

  logger.info("running", {
    carrier,
    interval_ms: intervalMs,
    once,
    health: carrier === "fedex" ? await proxySessionHealth(carrier) : undefined,
  });

  const execute = async () => {
    await runCanary(carrier, poolSessions);
  };

  await execute();
  if (once) {
    await poolSessions.close();
    await pool.end();
    return;
  }

  const timer = setInterval(() => {
    execute().catch((error) => logger.error("tick failed", { error: String(error) }));
  }, intervalMs);

  const shutdown = async () => {
    clearInterval(timer);
    await poolSessions.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

run().catch((error) => {
  createLogger("carrier-canary").error("fatal", { error: String(error) });
  process.exit(1);
});
