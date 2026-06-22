import { migrate, pool, query } from "../db.ts";
import { createLogger } from "../logger.ts";
import { enqueueScrape, enqueueWebhook } from "../queue.ts";
import { carrierDisabled } from "../carrier-flags.ts";

interface DueTracking {
  id: string;
  tracking_number: string;
  carrier: string | null;
  status: string;
}

async function tick(): Promise<void> {
  const result = await query<DueTracking>(
    `select id, tracking_number, carrier, status
     from trackings
     where stopped_at is null
       and carrier is not null
       and status not in ('delivered', 'exception')
       and next_scrape_at is not null
       and next_scrape_at <= now()
     order by next_scrape_at asc
     limit $1`,
    [Number(process.env.SCHEDULER_BATCH_SIZE ?? 100)],
  );

  const leaseSeconds = Number(process.env.SCHEDULER_SCRAPE_LEASE_SECONDS ?? 300);
  for (const tracking of result.rows) {
    if (carrierDisabled(tracking.carrier)) {
      await query(
        `update trackings
         set next_scrape_at = now() + ($2::text || ' seconds')::interval,
             updated_at = now()
         where id = $1`,
        [tracking.id, leaseSeconds],
      );
      continue;
    }
    await enqueueScrape({
      tracking_id: tracking.id,
      carrier: tracking.carrier,
      tracking_number: tracking.tracking_number,
      reason: "scheduled",
    });
    await query(
      `update trackings
       set next_scrape_at = now() + ($2::text || ' seconds')::interval,
           updated_at = now()
       where id = $1`,
      [tracking.id, leaseSeconds],
    );
  }

  const webhookResult = await query<{ id: string }>(
    `select id
     from webhook_deliveries
     where delivered_at is null
       and attempts < 5
       and (next_attempt_at is null or next_attempt_at <= now())
     order by created_at asc
     limit $1`,
    [Number(process.env.SCHEDULER_WEBHOOK_BATCH_SIZE ?? 100)],
  );
  for (const delivery of webhookResult.rows) {
    await enqueueWebhook({ delivery_id: delivery.id });
  }
}

async function run() {
  const logger = createLogger("scheduler");
  await migrate();
  const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000);
  logger.info("running", { interval_ms: intervalMs });
  await tick();
  const timer = setInterval(() => {
    tick().catch((error) => logger.error("tick failed", { error: String(error) }));
  }, intervalMs);

  const shutdown = async () => {
    clearInterval(timer);
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

run().catch((error) => {
  createLogger("scheduler").error("fatal", { error: String(error) });
  process.exit(1);
});
