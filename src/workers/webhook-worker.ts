import { Worker } from "bullmq";
import { migrate, pool, query } from "../db.ts";
import { redisConnection, type WebhookJob } from "../queue.ts";
import { deliverWebhook, type WebhookEvent, type WebhookEventType } from "../webhooks.ts";

interface DeliveryRow {
  id: string;
  account_id: string;
  webhook_id: string;
  event_type: WebhookEventType;
  attempts: number;
  payload: WebhookEvent;
}

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  event_types: WebhookEventType[];
  disabled_at: string | null;
}

async function run() {
  await migrate();
  const concurrency = Number(process.env.WEBHOOK_WORKER_CONCURRENCY ?? 10);
  const worker = new Worker<WebhookJob>(
    "webhooks",
    async (job) => {
      const deliveryResult = await query<DeliveryRow>(
        `select id, account_id, webhook_id, event_type, attempts, payload
         from webhook_deliveries
         where id = $1 and delivered_at is null`,
        [job.data.delivery_id],
      );
      const delivery = deliveryResult.rows[0];
      if (!delivery) return;

      const hookResult = await query<WebhookRow>(
        `select id, url, secret, event_types, disabled_at
         from webhooks
         where id = $1 and account_id = $2 and enabled = true`,
        [delivery.webhook_id, delivery.account_id],
      );
      const hook = hookResult.rows[0];
      if (!hook || hook.disabled_at) {
        await query(`update webhook_deliveries set error = 'webhook endpoint disabled' where id = $1`, [delivery.id]);
        return;
      }

      const result = await deliverWebhook(
        { id: hook.id, url: hook.url, secret: hook.secret, eventTypes: hook.event_types },
        delivery.payload,
        { retryDelaysMs: [] },
      );

      await query(
        `update webhook_deliveries
         set attempts = attempts + 1,
             status = $2,
             error = $3,
             delivered_at = case when $4 then now() else delivered_at end,
             next_attempt_at = case when $4 then null else now() + interval '30 seconds' end
         where id = $1`,
        [delivery.id, result.status ?? null, result.error ?? null, result.ok],
      );
      await query(
        `update webhooks
         set consecutive_failures = case when $2 then 0 else consecutive_failures + 1 end,
             disabled_at = case when not $2 and consecutive_failures + 1 >= 100 then now() else disabled_at end,
             enabled = case when not $2 and consecutive_failures + 1 >= 100 then false else enabled end
         where id = $1`,
        [hook.id, result.ok],
      );
      if (!result.ok) throw new Error(result.error ?? `webhook delivery failed ${result.status ?? ""}`.trim());
    },
    {
      connection: redisConnection(),
      concurrency,
    },
  );

  const shutdown = async () => {
    await worker.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.error(`[webhook-worker] running concurrency=${concurrency}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
