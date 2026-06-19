import { Worker } from "bullmq";
import { migrate, pool, query } from "../db.ts";
import { redisConnection, type ScrapeJob } from "../queue.ts";
import { enqueueWebhookEvent } from "../webhook-dispatch.ts";
import { SessionPool } from "./session-pool.ts";

function normalizeStatus(status: string | undefined): string {
  if (!status || status === "unknown") return "unknown";
  if (status === "pickup") return "out_for_delivery";
  if (status === "warning") return "exception";
  return status;
}

interface ExistingTracking {
  id: string;
  account_id: string;
  status: string;
}

async function run() {
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

      const result = await poolSessions.track(carrier, job.data.tracking_number);

      if (!result.ok || !result.track) {
        await query(
          `update trackings
           set exception = $2, last_scraped_at = now(), updated_at = now()
           where id = $1`,
          [job.data.tracking_id, result.error ?? "scrape failed"],
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
      const updateResult = await query(
        `update trackings
         set status = $2,
             events = $3::jsonb,
             service_level = coalesce($4, service_level),
             weight_grams = coalesce($5, weight_grams),
             delivered_at = case when $2 = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
             last_scraped_at = now(),
             next_scrape_at = case when $2 in ('delivered', 'exception') then null else next_scrape_at end,
             updated_at = now()
         where id = $1
         returning *`,
        [
          job.data.tracking_id,
          status,
          JSON.stringify(result.track.events),
          result.track.serviceLevel ?? null,
          result.track.weightGrams ?? null,
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
  console.error(`[scrape-worker] running concurrency=${concurrency}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
