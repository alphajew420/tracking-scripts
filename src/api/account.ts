import { pageParams } from "../api-helpers.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApiRouteContext } from "./types.ts";

export async function handleAccountRoutes({ req, res, url, auth, requestId, deps }: ApiRouteContext): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/account/email-outbox") {
    const { limit, offset } = pageParams(url);
    const result = await deps.query(
      `select id, to_email, subject, body, provider, status, error, sent_at, created_at,
              count(*) over() as total_count
       from email_outbox
       where account_id = $1
       order by created_at desc
       limit $2 offset $3`,
      [auth.accountId, limit, offset],
    );
    const total = Number((result.rows[0] as { total_count?: string } | undefined)?.total_count ?? 0);
    deps.json(res, 200, { data: result.rows, pagination: { limit, offset, total } }, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/account/white-label") {
    deps.json(res, 200, await deps.getWhiteLabel(auth), requestId);
    return true;
  }

  if (req.method === "PUT" && url.pathname === "/v1/account/white-label") {
    deps.json(res, 200, await deps.updateWhiteLabel(auth, await deps.readBody(req)), requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/account/usage") {
    const result = await deps.query<{ count: string }>(
      `select count(*) from trackings where account_id = $1 and created_at >= date_trunc('month', now())`,
      [auth.accountId],
    );
    const webhookResult = await deps.query<{ count: string }>(
      `select count(*) from webhook_deliveries where account_id = $1 and created_at >= date_trunc('month', now())`,
      [auth.accountId],
    );
    const carrierResult = await deps.query<{ carrier: string; count: string }>(
      `select coalesce(carrier, 'unknown') as carrier, count(*)::text
       from trackings
       where account_id = $1 and created_at >= date_trunc('month', now())
       group by coalesce(carrier, 'unknown')
       order by count(*) desc`,
      [auth.accountId],
    );
    const accountResult = await deps.query<{ monthly_tracking_limit: number; rate_limit_per_minute: number }>(
      `select monthly_tracking_limit, rate_limit_per_minute from accounts where id = $1`,
      [auth.accountId],
    );
    const windowResult = await deps.query<{ period_start: string; period_end: string }>(
      `select date_trunc('month', now())::text as period_start,
              (date_trunc('month', now()) + interval '1 month')::text as period_end`,
    );
    deps.json(res, 200, {
      period_start: windowResult.rows[0]?.period_start,
      period_end: windowResult.rows[0]?.period_end,
      trackings_used: Number(result.rows[0]?.count ?? 0),
      trackings_limit: Number(accountResult.rows[0]?.monthly_tracking_limit ?? process.env.FREE_TRACKINGS_LIMIT ?? 100),
      rate_limit_per_minute: Number(accountResult.rows[0]?.rate_limit_per_minute ?? process.env.FREE_RATE_LIMIT_PER_MINUTE ?? 60),
      webhook_deliveries: Number(webhookResult.rows[0]?.count ?? 0),
      carrier_volume: carrierResult.rows.map((row) => ({ carrier: row.carrier, count: Number(row.count) })),
    }, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/account/plan") {
    const account = await deps.accountPlan(auth.accountId);
    deps.json(res, 200, {
      account_id: auth.accountId,
      account_name: account.name ?? "Development account",
      tier: account.plan_tier ?? process.env.DEFAULT_PLAN_TIER ?? "free",
      monthly_price_usd: Number(process.env.DEFAULT_PLAN_PRICE_USD ?? 0),
      trackings_limit: Number(account.monthly_tracking_limit ?? 100),
      rate_limit_per_minute: Number(account.rate_limit_per_minute ?? 60),
      bulk_limit: Number(account.bulk_limit ?? process.env.DEFAULT_BULK_LIMIT ?? 5),
      realtime_ws: account.realtime_ws ?? process.env.DEFAULT_REALTIME_WS === "true",
      overage_usd_per_tracking: Number(account.overage_usd_per_tracking ?? process.env.DEFAULT_OVERAGE_USD_PER_TRACKING ?? 0.01),
    }, requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/account/billing/checkout") {
    const body = await deps.readBody(req);
    const tier = typeof body.tier === "string" ? body.tier : "starter";
    const price = deps.stripePriceForTier(tier);
    const successUrl = process.env.STRIPE_SUCCESS_URL ?? deps.appUrl("/dashboard/billing?checkout=success");
    const cancelUrl = process.env.STRIPE_CANCEL_URL ?? deps.appUrl("/dashboard/billing?checkout=cancelled");
    if (!process.env.STRIPE_SECRET_KEY || !price) {
      const checkoutBase = process.env.STRIPE_CHECKOUT_BASE_URL;
      if (!checkoutBase) {
        deps.json(res, 501, { configured: false, error: { code: "not_configured", message: "Stripe checkout is not configured" } }, requestId);
        return true;
      }
      deps.json(res, 200, {
        configured: true,
        url: `${checkoutBase}?client_reference_id=${encodeURIComponent(auth.accountId)}&tier=${encodeURIComponent(tier)}`,
      }, requestId);
      return true;
    }
    const session = await deps.stripeRequest("/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      client_reference_id: auth.accountId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      "metadata[account_id]": auth.accountId,
      "metadata[tier]": tier,
    });
    deps.json(res, 200, { configured: true, url: session.url }, requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/account/billing/portal") {
    const account = await deps.accountPlan(auth.accountId);
    if (!process.env.STRIPE_SECRET_KEY || !account.stripe_customer_id) {
      const portalBase = process.env.STRIPE_PORTAL_BASE_URL;
      if (portalBase && account.stripe_customer_id) {
        deps.json(res, 200, {
          configured: true,
          url: `${portalBase}?customer=${encodeURIComponent(account.stripe_customer_id)}`,
        }, requestId);
        return true;
      }
      deps.json(res, 501, { configured: false, error: { code: "not_configured", message: "Stripe billing portal is not configured for this account" } }, requestId);
      return true;
    }
    const session = await deps.stripeRequest("/billing_portal/sessions", {
      customer: account.stripe_customer_id,
      return_url: process.env.STRIPE_PORTAL_RETURN_URL ?? deps.appUrl("/dashboard/billing"),
    });
    deps.json(res, 200, { configured: true, url: session.url }, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/account/team") {
    const users = await deps.query(
      `select id, email, name, email_verified_at, created_at
       from users
       where account_id = $1
       order by created_at asc`,
      [auth.accountId],
    );
    const invites = await deps.query(
      `select id, email, role, accepted_at, expires_at, created_at
       from team_invites
       where account_id = $1 and accepted_at is null and expires_at > now()
       order by created_at desc`,
      [auth.accountId],
    );
    deps.json(res, 200, { users: users.rows, invites: invites.rows }, requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/account/team/invites") {
    const body = await deps.readBody(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = typeof body.role === "string" && body.role.trim() ? body.role.trim() : "member";
    if (!email || !email.includes("@")) {
      deps.error(res, 400, "bad_request", "valid email is required", requestId);
      return true;
    }
    const token = `inv_${randomBytes(32).toString("base64url")}`;
    const result = await deps.query(
      `insert into team_invites (id, account_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + interval '7 days')
       returning id, email, role, accepted_at, expires_at, created_at`,
      [`inv_${randomUUID().replaceAll("-", "")}`, auth.accountId, email, role, createHash("sha256").update(token).digest("hex"), auth.userId],
    );
    await deps.sendEmail({
      accountId: auth.accountId,
      to: email,
      subject: "You have been invited to Trackified",
      body: `Accept your invite: ${deps.appUrl(`/accept-invite?token=${encodeURIComponent(token)}`)}`,
    });
    deps.json(res, 201, { invite: result.rows[0], token: deps.publicToken(token) }, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/account/api-keys") {
    deps.json(res, 200, await deps.listApiKeys(url, auth), requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/account/api-keys") {
    deps.json(res, 201, await deps.makeApiKey(await deps.readBody(req), auth), requestId);
    return true;
  }

  const keyMatch = /^\/v1\/account\/api-keys\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && keyMatch) {
    const result = await deps.query<{ id: string }>(
      `update api_keys set revoked_at = now() where id = $1 and account_id = $2 and revoked_at is null returning id`,
      [keyMatch[1], auth.accountId],
    );
    if (!result.rows[0]) {
      deps.error(res, 404, "not_found", "api key not found", requestId);
      return true;
    }
    deps.json(res, 200, { revoked: true, id: result.rows[0].id }, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/stream") {
    deps.json(res, 426, { error: { code: "upgrade_required", message: "connect with WebSocket in production deployment" } }, requestId);
    return true;
  }

  return false;
}
