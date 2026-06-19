import { migrate, pool, query } from "../db.ts";
import { enqueueScrape, enqueueWebhook } from "../queue.ts";

interface DueTracking {
  id: string;
  tracking_number: string;
  carrier: string | null;
  status: string;
}

function cadence(status: string): string | null {
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

  for (const tracking of result.rows) {
    const interval = cadence(tracking.status);
    await enqueueScrape({
      tracking_id: tracking.id,
      carrier: tracking.carrier,
      tracking_number: tracking.tracking_number,
      reason: "scheduled",
    });
    await query(
      `update trackings
       set next_scrape_at = case when $2::text is null then null else now() + ($2::text)::interval end,
           updated_at = now()
       where id = $1`,
      [tracking.id, interval],
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
  await migrate();
  const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000);
  console.error(`[scheduler] running interval=${intervalMs}ms`);
  await tick();
  const timer = setInterval(() => {
    tick().catch((error) => console.error("[scheduler]", error));
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
  console.error(error);
  process.exit(1);
});
