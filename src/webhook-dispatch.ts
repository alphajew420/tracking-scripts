import { randomUUID } from "node:crypto";
import { query } from "./db.ts";
import { enqueueWebhook } from "./queue.ts";
import type { WebhookEvent, WebhookEventType } from "./webhooks.ts";

interface WebhookRow {
  id: string;
  account_id: string;
  event_types: WebhookEventType[];
}

export async function enqueueWebhookEvent(accountId: string, type: WebhookEventType, data: unknown): Promise<void> {
  const hooks = await query<WebhookRow>(
    `select id, account_id, event_types
     from webhooks
     where account_id = $1 and enabled = true and disabled_at is null and $2 = any(event_types)`,
    [accountId, type],
  );

  const event: WebhookEvent = {
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type,
    created_at: new Date().toISOString(),
    data,
  };

  for (const hook of hooks.rows) {
    const deliveryId = `whd_${randomUUID().replaceAll("-", "")}`;
    await query(
      `insert into webhook_deliveries
       (id, account_id, webhook_id, event_type, attempts, payload, next_attempt_at, created_at)
       values ($1, $2, $3, $4, 0, $5::jsonb, now(), now())`,
      [deliveryId, accountId, hook.id, type, JSON.stringify(event)],
    );
    await enqueueWebhook({ delivery_id: deliveryId });
  }
}
