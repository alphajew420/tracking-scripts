import { createLogger } from "../logger.ts";
import { migrate, pool } from "../db.ts";
import { sendDiscordWebhook } from "../discord.ts";
import { activeProxySession, markProxySessionBad, proxySessionHealth } from "../proxy-session-manager.ts";
import { cleanupBrowserTempArtifacts } from "../browser-temp-cleanup.ts";
import { SessionPool } from "./session-pool.ts";

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function carrierEnv(name: string, carrier: string): string | undefined {
  return process.env[`${name}_${carrier.toUpperCase().replaceAll("-", "_")}`] ?? process.env[name];
}

function numberCarrierEnv(name: string, carrier: string, fallback: number): number {
  const value = carrierEnv(name, carrier);
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

  const attempts = numberCarrierEnv("CANARY_ATTEMPTS", carrier, 3);
  const timeoutMs = numberCarrierEnv("CANARY_ATTEMPT_TIMEOUT_MS", carrier, numberCarrierEnv("CANARY_TIMEOUT_MS", carrier, 240_000));
  const startedAt = Date.now();
  const cleanup = cleanupBrowserTempArtifacts();

  logger.info("started", {
    tracking_number: number,
    attempts,
    timeout_ms: timeoutMs,
    cleanup,
  });

  let lastReason = "canary failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    const proxySession = carrier === "fedex" ? await activeProxySession(carrier) : null;
    logger.info("attempt started", { attempt, attempts, proxy_session: proxySession });

    try {
      const result = await withTimeout(
        poolSessions.track(carrier, number),
        timeoutMs,
        `${carrier}: canary attempt timed out`,
      );
      const attemptElapsedMs = Date.now() - attemptStartedAt;
      if (result.ok && result.track?.events.length) {
        logger.info("passed", {
          attempt,
          elapsed_ms: Date.now() - startedAt,
          attempt_elapsed_ms: attemptElapsedMs,
          tracking_number: number,
          event_count: result.track.events.length,
          proxy_session: proxySession,
        });
        return true;
      }

      lastReason = result.ok ? "canary returned no normalized events" : result.error ?? "canary failed";
      logger.warn("attempt failed", { attempt, attempts, attempt_elapsed_ms: attemptElapsedMs, reason: lastReason, proxy_session: proxySession });
      if (carrier === "fedex") {
        await markProxySessionBad({ carrier, session: proxySession, reason: lastReason });
      }
      await poolSessions.invalidate(carrier);
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      logger.warn("attempt failed", {
        attempt,
        attempts,
        attempt_elapsed_ms: Date.now() - attemptStartedAt,
        reason: lastReason,
        proxy_session: proxySession,
      });
      if (carrier === "fedex") {
        await markProxySessionBad({ carrier, session: proxySession, reason: lastReason });
      }
      await poolSessions.invalidate(carrier);
    }
  }

  logger.warn("failed", { elapsed_ms: Date.now() - startedAt, reason: lastReason, attempts });
  if (carrier === "fedex") {
    await sendDiscordWebhook(`Trackified ${carrier} canary failed after ${attempts} attempts: ${lastReason}.`);
  }
  return false;
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
