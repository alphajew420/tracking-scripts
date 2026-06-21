import { Worker } from "bullmq";
import { migrate, pool, query } from "../db.ts";
import { createLogger } from "../logger.ts";
import { redisConnection, releaseScrapeEnqueueLock, type ScrapeJob } from "../queue.ts";
import { failedScrapeRetryAt, nextScrapeAt } from "../scrape-cadence.ts";
import { enqueueWebhookEvent } from "../webhook-dispatch.ts";
import { SessionPool } from "./session-pool.ts";

function normalizeStatus(status: string | undefined): string {
  if (!status || status === "unknown") return "unknown";
  if (status === "pickup") return "out_for_delivery";
  if (status === "warning") return "exception";
  return status;
}

function scrapeTimeoutMs(carrier: string): number {
  const carrierKey = carrier.toUpperCase().replaceAll("-", "_");
  const override = process.env[`SCRAPE_TIMEOUT_MS_${carrierKey}`];
  return Number(override ?? process.env.SCRAPE_TIMEOUT_MS ?? 120_000);
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

interface ExistingTracking {
  id: string;
  account_id: string;
  status: string;
}

async function run() {
  const logger = createLogger("scrape-worker");
  await migrate();
  const poolSessions = new SessionPool();
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 3);

  const worker = new Worker<ScrapeJob>(
    "scrapes",
    async (job) => {
      const carrier = job.data.carrier;
      if (!carrier) throw new Error("carrier is required before scrape");
      const existingResult = await query<ExistingTracking>(
        `select id, account_id, status from trackings where id = $1`,
        [job.data.tracking_id],
      );
      const existing = existingResult.rows[0];
      if (!existing) throw new Error("tracking not found");

      const startedAt = Date.now();
      logger.info("scrape started", {
        job_id: job.id,
        tracking_id: job.data.tracking_id,
        carrier,
        reason: job.data.reason,
      });
      let result;
      try {
        result = await withTimeout(
          poolSessions.track(carrier, job.data.tracking_number),
          scrapeTimeoutMs(carrier),
          `${carrier}: scrape timed out`,
        );
        logger.info("scrape finished", {
          job_id: job.id,
          tracking_id: job.data.tracking_id,
          carrier,
          ok: result.ok,
          elapsed_ms: Date.now() - startedAt,
          error: result.ok ? undefined : result.error,
        });
      } catch (error) {
        result = { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        logger.info("scrape finished", {
          job_id: job.id,
          tracking_id: job.data.tracking_id,
          carrier,
          ok: false,
          elapsed_ms: Date.now() - startedAt,
          error: result.error,
        });
        await poolSessions.invalidate(carrier);
      }

      try {
        if (!result.ok || !result.track) {
          await poolSessions.invalidate(carrier);
          await query(
            `update trackings
             set exception = $2,
                 last_scraped_at = now(),
                 next_scrape_at = $3::timestamptz,
                 updated_at = now()
             where id = $1`,
            [job.data.tracking_id, result.error ?? "scrape failed", failedScrapeRetryAt()],
          );
          await enqueueWebhookEvent(existing.account_id, "tracking.exception", {
            tracking_id: job.data.tracking_id,
            error: result.error ?? "tracking update failed",
          });
          throw new Error(result.error ?? "scrape failed");
        }

        const status = result.track.delivered
          ? "delivered"
          : normalizeStatus(result.track.events[0]?.status);
        const nextScrape = nextScrapeAt(status);
        const updateResult = await query(
          `update trackings
           set status = $2,
               events = $3::jsonb,
               service_level = coalesce($4, service_level),
               weight_grams = coalesce($5, weight_grams),
               exception = null,
               delivered_at = case when $2 = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
               last_scraped_at = now(),
               next_scrape_at = $6::timestamptz,
               updated_at = now()
           where id = $1
           returning *`,
          [
            job.data.tracking_id,
            status,
            JSON.stringify(result.track.events),
            result.track.serviceLevel ?? null,
            result.track.weightGrams ?? null,
            nextScrape,
          ],
        );
        const updated = updateResult.rows[0];
        await enqueueWebhookEvent(existing.account_id, "tracking.updated", updated);
        if (existing.status !== status) {
          await enqueueWebhookEvent(existing.account_id, "tracking.status_changed", {
            tracking: updated,
            previous_status: existing.status,
            current_status: status,
          });
        }
        if (status === "delivered") await enqueueWebhookEvent(existing.account_id, "tracking.delivered", updated);
        if (status === "exception") await enqueueWebhookEvent(existing.account_id, "tracking.exception", updated);
      } finally {
        await releaseScrapeEnqueueLock(job.data.tracking_id);
      }
    },
    {
      connection: redisConnection(),
      concurrency,
      limiter: { max: Number(process.env.WORKER_RATE_MAX ?? 60), duration: 60_000 },
    },
  );

  const shutdown = async () => {
    await worker.close();
    await poolSessions.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  logger.info("running", { concurrency });
}

run().catch((error) => {
  createLogger("scrape-worker").error("fatal", { error: String(error) });
  process.exit(1);
});
