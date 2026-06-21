import { pageParams } from "../api-helpers.ts";
import { randomBytes, randomUUID } from "node:crypto";
import type { ApiRouteContext } from "./types.ts";

export async function handleWebhookRoutes({ req, res, url, auth, requestId, deps }: ApiRouteContext): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/webhooks") {
    const { limit, offset } = pageParams(url);
    const result = await deps.query<{ total_count?: string } & Record<string, unknown>>(
      `select *, count(*) over() as total_count
       from webhooks
       where account_id = $1 and disabled_at is null
       order by created_at desc limit $2 offset $3`,
      [auth.accountId, limit, offset],
    );
    const total = Number((result.rows[0] as { total_count?: string } | undefined)?.total_count ?? 0);
    deps.json(res, 200, { data: result.rows.map((row) => deps.publicWebhook(row)), pagination: { limit, offset, total } }, requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/webhooks") {
    const body = await deps.readBody(req);
    if (typeof body.url !== "string") {
      deps.error(res, 400, "bad_request", "url is required", requestId);
      return true;
    }
    if (!deps.validWebhookUrl(body.url)) {
      deps.error(res, 400, "bad_request", "webhook url must be a valid HTTPS URL", requestId);
      return true;
    }
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const result = await deps.query<{ total_count?: string } & Record<string, unknown>>(
      `insert into webhooks (id, account_id, url, event_types, secret, created_at)
       values ($1, $2, $3, $4, $5, now())
       returning *`,
      [
        `wh_${randomUUID().replaceAll("-", "")}`,
        auth.accountId,
        body.url,
        Array.isArray(body.event_types) ? body.event_types.map(String) : ["tracking.updated", "tracking.delivered"],
        secret,
      ],
    );
    deps.json(res, 201, deps.publicWebhook(result.rows[0]!), requestId);
    return true;
  }

  const webhookAction = /^\/v1\/webhooks\/([^/]+)(?:\/(test))?$/.exec(url.pathname);
  if (webhookAction) {
    const result = await deps.query<{ id: string; secret: string } & Record<string, unknown>>(
      `select * from webhooks where id = $1 and account_id = $2`,
      [webhookAction[1], auth.accountId],
    );
    const hook = result.rows[0];
    if (!hook) {
      deps.error(res, 404, "not_found", "webhook not found", requestId);
      return true;
    }
    if (req.method === "DELETE" && !webhookAction[2]) {
      await deps.query(`update webhooks set enabled = false, disabled_at = now() where id = $1 and account_id = $2`, [hook.id, auth.accountId]);
      deps.json(res, 200, { deleted: true, id: hook.id }, requestId);
      return true;
    }
    if (req.method === "POST" && webhookAction[2] === "test") {
      const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: "tracking.updated", created_at: new Date().toISOString(), data: { test: true } });
      await deps.query(
        `insert into webhook_deliveries
         (id, account_id, webhook_id, event_type, status, attempts, payload, created_at)
         values ($1, $2, $3, 'tracking.updated', null, 0, $4::jsonb, now())`,
        [`whd_${randomUUID().replaceAll("-", "")}`, auth.accountId, hook.id, body],
      );
      deps.json(res, 200, { delivered: false, dry_run: true, signature: deps.signWebhookBody(body, hook.secret), body: JSON.parse(body) }, requestId);
      return true;
    }
  }

  if (req.method === "GET" && url.pathname === "/v1/webhook-deliveries") {
    const { limit, offset } = pageParams(url);
    const result = await deps.query(
      `select wd.id, wd.webhook_id, w.url, wd.event_type, wd.status, wd.attempts, wd.error,
              wd.delivered_at, wd.created_at, count(*) over() as total_count
       from webhook_deliveries wd
       left join webhooks w on w.id = wd.webhook_id
       where wd.account_id = $1
       order by wd.created_at desc
       limit $2 offset $3`,
      [auth.accountId, limit, offset],
    );
    const total = Number((result.rows[0] as { total_count?: string } | undefined)?.total_count ?? 0);
    deps.json(res, 200, { data: result.rows, pagination: { limit, offset, total } }, requestId);
    return true;
  }

  return false;
}
