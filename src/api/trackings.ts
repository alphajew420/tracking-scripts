import { bulkRows } from "../api-helpers.ts";
import type { ApiRouteContext } from "./types.ts";

export async function handleTrackingRoutes({ req, res, url, auth, requestId, deps }: ApiRouteContext): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/v1/trackings") {
    const quota = await deps.assertTrackingQuota(auth, 1);
    if (!quota.ok) {
      deps.error(res, 402, "quota_exceeded", `monthly tracking quota exceeded (${quota.used}/${quota.limit})`, requestId);
      return true;
    }
    const tracking = await deps.insertTracking(await deps.readBody(req), auth);
    await deps.enqueueWebhookEvent(auth.accountId, "tracking.created", tracking);
    deps.json(res, 201, tracking, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/trackings") {
    deps.json(res, 200, await deps.listTrackingsForAccount(url, auth), requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/trackings/bulk") {
    const body = await deps.readBody(req);
    const parsedRows = bulkRows(body);
    if (!parsedRows.ok) {
      deps.error(res, 400, "bad_request", parsedRows.message, requestId);
      return true;
    }
    const rows = parsedRows.rows;
    const quota = await deps.assertTrackingQuota(auth, rows.length);
    if (!quota.ok) {
      deps.error(res, 402, "quota_exceeded", `monthly tracking quota exceeded (${quota.used}/${quota.limit})`, requestId);
      return true;
    }
    const data = [];
    for (const row of rows) {
      try {
        const tracking = await deps.insertTracking(row as Record<string, unknown>, auth);
        await deps.enqueueWebhookEvent(auth.accountId, "tracking.created", tracking);
        data.push({ ok: true, tracking });
      } catch (err) {
        data.push({ ok: false, error: String((err as Error).message ?? err) });
      }
    }
    deps.json(res, 207, { data }, requestId);
    return true;
  }

  if (req.method === "POST" && (url.pathname === "/v1/trackings/lookup/bulk" || url.pathname === "/v1/trackings/getrack/bulk")) {
    const body = await deps.readBody(req);
    const parsedRows = bulkRows(body);
    if (!parsedRows.ok) {
      deps.error(res, 400, "bad_request", parsedRows.message, requestId);
      return true;
    }
    const rows = parsedRows.rows;
    const quota = await deps.assertTrackingQuota(auth, rows.length);
    if (!quota.ok) {
      deps.error(res, 402, "quota_exceeded", `monthly tracking quota exceeded (${quota.used}/${quota.limit})`, requestId);
      return true;
    }
    const data = [];
    for (const row of rows) {
      try {
        const tracking = await deps.insertTracking(row as Record<string, unknown>, auth);
        await deps.enqueueWebhookEvent(auth.accountId, "tracking.created", tracking);
        const queuedTracking = tracking as { id: string; tracking_number: string };
        data.push({ ok: true, queued: true, tracking_id: queuedTracking.id, tracking_number: queuedTracking.tracking_number });
      } catch (err) {
        data.push({ ok: false, error: String((err as Error).message ?? err) });
      }
    }
    deps.json(res, 202, { data, timeout_ms: 12000 }, requestId);
    return true;
  }

  const trackingAction = /^\/v1\/trackings\/([^/]+)(?:\/(retrack))?$/.exec(url.pathname);
  if (trackingAction) {
    const tracking = await deps.getTracking(trackingAction[1]!, auth);
    if (!tracking) {
      deps.error(res, 404, "not_found", "tracking not found", requestId);
      return true;
    }
    if (req.method === "GET" && !trackingAction[2]) {
      deps.json(res, 200, tracking, requestId);
      return true;
    }
    if (req.method === "PUT" && !trackingAction[2]) {
      const body = await deps.readBody(req);
      const result = await deps.query<{ id: string; tracking_number: string; carrier: string | null; carrier_detected: boolean; status: string; delivered_at: string | null; estimated_delivery: string | null; origin: Record<string, unknown> | null; destination: Record<string, unknown> | null; events: unknown[]; service_level: string | null; weight_grams: number | null; estimated_delivery_window: { from: string; to: string } | null; transit_days_remaining: number | null; exception: string | null; last_scraped_at: string | null; next_scrape_at: string | null; custom_id: string | null; customer_email: string | null; created_at: string; updated_at: string }>(
        `update trackings
         set custom_id = coalesce($2, custom_id),
             customer_email = coalesce($3, customer_email),
             carrier = coalesce($4, carrier),
             updated_at = now()
         where id = $1 and account_id = $5 and stopped_at is null
         returning *`,
        [
          (tracking as { id: string }).id,
          typeof body.custom_id === "string" ? body.custom_id : null,
          typeof body.customer_email === "string" ? body.customer_email : null,
          typeof body.carrier === "string" ? body.carrier : null,
          auth.accountId,
        ],
      );
      const updated = result.rows[0]!;
      await deps.enqueueWebhookEvent(auth.accountId, "tracking.updated", updated);
      deps.json(res, 200, updated, requestId);
      return true;
    }
    if (req.method === "DELETE" && !trackingAction[2]) {
      await deps.query(`update trackings set stopped_at = now(), updated_at = now() where id = $1 and account_id = $2`, [(tracking as { id: string }).id, auth.accountId]);
      deps.json(res, 200, { deleted: true, id: (tracking as { id: string }).id }, requestId);
      return true;
    }
    if (req.method === "POST" && trackingAction[2] === "retrack") {
      await deps.query(
        `update trackings
         set next_scrape_at = now() + interval '1 minute',
             updated_at = now()
         where id = $1 and account_id = $2 and stopped_at is null`,
        [(tracking as { id: string }).id, auth.accountId],
      );
      await deps.enqueueScrape({ tracking_id: (tracking as { id: string; carrier: string | null; tracking_number: string }).id, carrier: (tracking as { carrier: string | null }).carrier, tracking_number: (tracking as { tracking_number: string }).tracking_number, reason: "retrack" });
      deps.json(res, 202, { queued: true, tracking }, requestId);
      return true;
    }
  }

  return false;
}
