import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { createLogger } from "./logger.ts";
import { listPublicCarrierCatalog } from "./carriers/registry.ts";
import { carrierVerification } from "./carriers/verification.ts";
import { migrate, pool, query } from "./db.ts";
import { detectCarrier } from "./detect.ts";
import { sendEmail } from "./email.ts";
import { enqueueScrape } from "./queue.ts";
import { attachRealtimeServer } from "./realtime.ts";
import { enqueueWebhookEvent } from "./webhook-dispatch.ts";
import { signWebhookBody, type WebhookEventType } from "./webhooks.ts";
import { bulkRows, pageParams, validWebhookUrl } from "./api-helpers.ts";
import { initialScrapeFallbackAt } from "./scrape-cadence.ts";
import { handlePublicRoutes } from "./api/public.ts";
import { handleAccountRoutes } from "./api/account.ts";
import { handleCarrierRoutes } from "./api/carriers.ts";
import { handleTrackingRoutes } from "./api/trackings.ts";
import { handleWebhookRoutes } from "./api/webhooks.ts";
import type { ApiRouteDeps, AuthContext } from "./api/types.ts";
import { registerBuiltInCarrierApiAdapters } from "./carriers/api-registry.ts";
import { apiBaseUrl, webBaseUrl } from "../lib/site.ts";
import { appUrl } from "../lib/site.ts";

type TrackingStatus =
  | "not_yet_scanned"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "unknown";

interface TrackingRecord {
  id: string;
  tracking_number: string;
  carrier: string | null;
  carrier_detected: boolean;
  status: TrackingStatus;
  delivered_at: string | null;
  estimated_delivery: string | null;
  origin: Record<string, unknown> | null;
  destination: Record<string, unknown> | null;
  events: unknown[];
  service_level: string | null;
  weight_grams: number | null;
  estimated_delivery_window: { from: string; to: string } | null;
  transit_days_remaining: number | null;
  exception: string | null;
  last_scraped_at: string | null;
  next_scrape_at: string | null;
  custom_id: string | null;
  customer_email: string | null;
  created_at: string;
  updated_at: string;
}

interface ApiKeyRow {
  id: string;
  account_id: string;
  name: string;
  prefix: string;
  mode: "live" | "test";
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface WebhookRow {
  id: string;
  account_id: string;
  url: string;
  event_types: WebhookEventType[];
  secret: string;
  enabled: boolean;
  consecutive_failures: number;
  created_at: string;
  disabled_at: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  plan_tier: string;
  monthly_tracking_limit: number;
  rate_limit_per_minute: number;
  bulk_limit: number;
  realtime_ws: boolean;
  overage_usd_per_tracking: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_status: string;
  created_at: string;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const logger = createLogger("tracking-api");

interface UserRow {
  id: string;
  account_id: string;
  email: string;
  name: string | null;
  password_hash: string;
  account_name?: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  account_id: string;
}

interface WhiteLabelRow {
  account_id: string;
  domain: string | null;
  brand_name: string | null;
  accent_color: string;
  support_url: string | null;
  pii_public: boolean;
  updated_at: string;
}

const bootstrapKeys = (process.env.TRACKING_API_KEYS ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const rateBuckets = new Map<string, RateBucket>();

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function passwordHash(password: string, salt = randomBytes(16).toString("hex")): string {
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [, salt, hash] = encoded.split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function nowIso(): string {
  return new Date().toISOString();
}

function json(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const origin = process.env.CORS_ORIGIN ?? webBaseUrl();
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization,content-type,idempotency-key",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    vary: "origin",
  });
  res.end(JSON.stringify(body, null, 2));
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => {
        const [key, ...value] = part.trim().split("=");
        return [key, decodeURIComponent(value.join("=") ?? "")];
      })
      .filter(([key]) => key),
  );
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `trackified_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function publicToken(token?: string) {
  return process.env.NODE_ENV !== "production" && process.env.EMAIL_PROVIDER === "dev" ? token : undefined;
}

function error(res: ServerResponse, status: number, code: string, message: string, requestId: string): void {
  json(res, status, { error: { code, message, request_id: requestId } }, requestId);
}

function publicApiBaseUrl(): string {
  return apiBaseUrl();
}

function publicCarrierCatalog() {
  return listPublicCarrierCatalog().map((carrier) => ({
    ...carrier,
    verification: carrierVerification(carrier.id),
  }));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        resolve(typeof parsed === "object" && parsed ? parsed : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function authToken(token: string): Promise<AuthContext | null> {
  if (bootstrapKeys.includes(token)) {
    return {
      accountId: process.env.DEV_ACCOUNT_ID ?? "acct_dev",
      apiKeyId: null,
      userId: null,
      mode: token.startsWith("live_") ? "live" : "test",
      scopes: ["*"],
    };
  }
  const result = await query<ApiKeyRow>(
    `update api_keys
     set last_used_at = now()
     where token_hash = $1 and revoked_at is null
     returning id, account_id, mode, scopes`,
    [tokenHash(token)],
  );
  const key = result.rows[0];
  return key ? { accountId: key.account_id, apiKeyId: key.id, userId: null, mode: key.mode, scopes: key.scopes } : null;
}

async function auth(req: IncomingMessage): Promise<AuthContext | null> {
  const header = req.headers.authorization ?? "";
  const value = Array.isArray(header) ? header[0] ?? "" : header;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (match) return authToken(match[1]!);

  const sessionToken = parseCookies(req).trackified_session;
  if (!sessionToken) return null;
  const sessionResult = await query<SessionRow>(
    `select id, user_id, account_id
     from sessions
     where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [tokenHash(sessionToken)],
  );
  const session = sessionResult.rows[0];
  return session ? { accountId: session.account_id, apiKeyId: null, userId: session.user_id, mode: "live", scopes: ["*"] } : null;
}

async function accountPlan(accountId: string): Promise<AccountRow> {
  const result = await query<AccountRow>(`select * from accounts where id = $1`, [accountId]);
  const account = result.rows[0];
  if (!account) throw new Error("account not found");
  return account;
}

async function assertRateLimit(ctx: AuthContext): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number; limit: number }> {
  const account = await accountPlan(ctx.accountId);
  const limit = Number(account.rate_limit_per_minute ?? 60);
  const now = Date.now();
  const key = `${ctx.accountId}:${ctx.apiKeyId ?? ctx.userId ?? "session"}`;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return { ok: true };
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000), limit };
  }
  bucket.count += 1;
  return { ok: true };
}

async function assertTrackingQuota(ctx: AuthContext, additional: number): Promise<{ ok: true } | { ok: false; used: number; limit: number }> {
  const account = await accountPlan(ctx.accountId);
  const limit = Number(account.monthly_tracking_limit ?? 100);
  if (limit <= 0) return { ok: true };
  const result = await query<{ count: string }>(
    `select count(*) from trackings
     where account_id = $1 and created_at >= date_trunc('month', now())`,
    [ctx.accountId],
  );
  const used = Number(result.rows[0]?.count ?? 0);
  return used + additional <= limit ? { ok: true } : { ok: false, used, limit };
}

function normalizeTracking(row: TrackingRecord): TrackingRecord {
  return {
    id: row.id,
    tracking_number: row.tracking_number,
    carrier: row.carrier,
    carrier_detected: row.carrier_detected,
    status: row.status,
    estimated_delivery: row.estimated_delivery,
    origin: row.origin,
    destination: row.destination,
    events: row.events ?? [],
    service_level: row.service_level,
    weight_grams: row.weight_grams,
    estimated_delivery_window: row.estimated_delivery_window,
    transit_days_remaining: row.transit_days_remaining,
    exception: row.exception,
    custom_id: row.custom_id,
    customer_email: row.customer_email,
    delivered_at: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    last_scraped_at: row.last_scraped_at ? new Date(row.last_scraped_at).toISOString() : null,
    next_scrape_at: row.next_scrape_at ? new Date(row.next_scrape_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

async function insertTracking(input: Record<string, unknown>, ctx: AuthContext): Promise<TrackingRecord> {
  if (typeof input.tracking_number !== "string" || !input.tracking_number.trim()) {
    throw new Error("tracking_number is required");
  }
  const candidates = typeof input.carrier === "string" ? [] : detectCarrier(input.tracking_number);
  const status: TrackingStatus = "not_yet_scanned";
  const tracking = {
    id: `trk_${randomUUID().replaceAll("-", "")}`,
    tracking_number: input.tracking_number.trim(),
    carrier: typeof input.carrier === "string" ? input.carrier : candidates[0]?.carrier ?? null,
    carrier_detected: typeof input.carrier !== "string" && candidates.length > 0,
    status,
    next_scrape_at: initialScrapeFallbackAt(),
    custom_id: typeof input.custom_id === "string" ? input.custom_id : null,
    customer_email: typeof input.customer_email === "string" ? input.customer_email : null,
  };
  const result = await query<TrackingRecord>(
    `insert into trackings (
       id, account_id, tracking_number, carrier, carrier_detected, status, events,
       next_scrape_at, custom_id, customer_email, created_at, updated_at
     )
     values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7, $8, $9, now(), now())
     returning *`,
    [
      tracking.id,
      ctx.accountId,
      tracking.tracking_number,
      tracking.carrier,
      tracking.carrier_detected,
      tracking.status,
      tracking.next_scrape_at,
      tracking.custom_id,
      tracking.customer_email,
    ],
  );
  const row = normalizeTracking(result.rows[0]!);
  await enqueueScrape({
    tracking_id: row.id,
    carrier: row.carrier,
    tracking_number: row.tracking_number,
    reason: "created",
  });
  return row;
}

async function listTrackings(url: URL) {
  const { limit, offset } = pageParams(url);
  const clauses = ["stopped_at is null"];
  const values: unknown[] = [];
  const status = url.searchParams.get("status");
  const carrier = url.searchParams.get("carrier");
  if (status) {
    values.push(status);
    clauses.push(`status = $${values.length}`);
  }
  if (carrier) {
    values.push(carrier);
    clauses.push(`carrier = $${values.length}`);
  }
  values.push(limit, offset);
  const where = clauses.join(" and ");
  const result = await query<TrackingRecord>(
    `select *, count(*) over() as total_count
     from trackings
     where ${where}
     order by created_at desc
     limit $${values.length - 1} offset $${values.length}`,
    values,
  );
  const total = Number((result.rows[0] as TrackingRecord & { total_count?: string } | undefined)?.total_count ?? 0);
  return { data: result.rows.map(normalizeTracking), pagination: { limit, offset, total } };
}

async function listTrackingsForAccount(url: URL, ctx: AuthContext) {
  const { limit, offset } = pageParams(url);
  const clauses = ["account_id = $1", "stopped_at is null"];
  const values: unknown[] = [ctx.accountId];
  const status = url.searchParams.get("status");
  const carrier = url.searchParams.get("carrier");
  if (status) {
    values.push(status);
    clauses.push(`status = $${values.length}`);
  }
  if (carrier) {
    values.push(carrier);
    clauses.push(`carrier = $${values.length}`);
  }
  values.push(limit, offset);
  const where = clauses.join(" and ");
  const result = await query<TrackingRecord>(
    `select *, count(*) over() as total_count
     from trackings
     where ${where}
     order by created_at desc
     limit $${values.length - 1} offset $${values.length}`,
    values,
  );
  const total = Number((result.rows[0] as TrackingRecord & { total_count?: string } | undefined)?.total_count ?? 0);
  return { data: result.rows.map(normalizeTracking), pagination: { limit, offset, total } };
}

async function getTracking(id: string, ctx: AuthContext): Promise<TrackingRecord | null> {
  const result = await query<TrackingRecord>(
    `select * from trackings where id = $1 and account_id = $2 and stopped_at is null`,
    [id, ctx.accountId],
  );
  return result.rows[0] ? normalizeTracking(result.rows[0]) : null;
}

async function makeApiKey(input: Record<string, unknown>, ctx: AuthContext) {
  const mode = input.mode === "live" ? "live" : "test";
  const prefix = `${mode}_${randomBytes(4).toString("hex")}`;
  const token = `${prefix}_${randomBytes(24).toString("base64url")}`;
  const result = await query<ApiKeyRow>(
    `insert into api_keys (id, account_id, name, token_hash, prefix, mode, scopes, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     returning id, account_id, name, prefix, mode, scopes, created_at, last_used_at, revoked_at`,
    [
      `key_${randomUUID().replaceAll("-", "")}`,
      ctx.accountId,
      typeof input.name === "string" ? input.name : `${mode} key`,
      tokenHash(token),
      prefix,
      mode,
      Array.isArray(input.scopes) ? input.scopes.map(String) : ["trackings:read", "trackings:write"],
    ],
  );
  return { ...publicApiKey(result.rows[0]!), token };
}

async function listApiKeys(url: URL, ctx: AuthContext) {
  const { limit, offset } = pageParams(url);
  const result = await query<ApiKeyRow>(
    `select id, account_id, name, prefix, mode, scopes, created_at, last_used_at, revoked_at,
            count(*) over() as total_count
     from api_keys
     where account_id = $1
     order by created_at desc
     limit $2 offset $3`,
    [ctx.accountId, limit, offset],
  );
  const total = Number((result.rows[0] as ApiKeyRow & { total_count?: string } | undefined)?.total_count ?? 0);
  return { data: result.rows.map(publicApiKey), pagination: { limit, offset, total } };
}

function publicApiKey(record: ApiKeyRow) {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    mode: record.mode,
    scopes: record.scopes,
    created_at: record.created_at,
    last_used_at: record.last_used_at,
    revoked_at: record.revoked_at,
  };
}

function publicUser(row: UserRow) {
  return {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name ?? null,
    email: row.email,
    name: row.name,
  };
}

async function createSession(
  res: ServerResponse,
  user: { id: string; account_id: string; email: string; name: string | null; account_name?: string },
): Promise<void> {
  const token = `sess_${randomBytes(32).toString("base64url")}`;
  const maxAgeSeconds = 60 * 60 * 24 * 30;
  await query(
    `insert into sessions (id, user_id, account_id, token_hash, expires_at)
     values ($1, $2, $3, $4, now() + interval '30 days')`,
    [`ses_${randomUUID().replaceAll("-", "")}`, user.id, user.account_id, tokenHash(token)],
  );
  res.setHeader("set-cookie", sessionCookie(token, maxAgeSeconds));
}

async function currentUser(ctx: AuthContext): Promise<ReturnType<typeof publicUser> | null> {
  if (!ctx.userId) return null;
  const result = await query<UserRow>(
    `select u.*, a.name as account_name
     from users u
     join accounts a on a.id = u.account_id
     where u.id = $1 and u.account_id = $2`,
    [ctx.userId, ctx.accountId],
  );
  return result.rows[0] ? publicUser(result.rows[0]!) : null;
}

async function createUserToken(userId: string, kind: "email_verify" | "password_reset", ttl: "1 hour" | "24 hours"): Promise<string> {
  const prefix = kind === "email_verify" ? "ver" : "rst";
  const token = `${prefix}_${randomBytes(32).toString("base64url")}`;
  await query(
    `insert into user_tokens (id, user_id, token_hash, kind, expires_at)
     values ($1, $2, $3, $4, now() + ($5::text)::interval)`,
    [`utok_${randomUUID().replaceAll("-", "")}`, userId, tokenHash(token), kind, ttl],
  );
  return token;
}

async function sendVerificationEmail(user: UserRow): Promise<string | undefined> {
  const token = await createUserToken(user.id, "email_verify", "24 hours");
  await sendEmail({
    accountId: user.account_id,
    to: user.email,
    subject: "Verify your Trackified email",
    body: `Verify your email: ${appUrl(`/verify-email?token=${encodeURIComponent(token)}`)}`,
  });
  return publicToken(token);
}

async function sendPasswordResetEmail(user: UserRow): Promise<string | undefined> {
  const token = await createUserToken(user.id, "password_reset", "1 hour");
  await sendEmail({
    accountId: user.account_id,
    to: user.email,
    subject: "Reset your Trackified password",
    body: `Reset your password: ${appUrl(`/reset-password?token=${encodeURIComponent(token)}`)}`,
  });
  return publicToken(token);
}

function stripePriceForTier(tier: string): string | undefined {
  const key = `STRIPE_PRICE_${tier.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return process.env[key];
}

async function stripeRequest(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured");
  const body = new URLSearchParams(params);
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data?.error?.message ?? `Stripe request failed: ${response.status}`);
  return data;
}

function verifyStripeSignature(rawBody: string, header: string | undefined): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return !process.env.STRIPE_SECRET_KEY;
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => {
    const [key, value] = part.split("=");
    return [key, value];
  }));
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(parts.v1, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

async function applyStripeEvent(payload: Record<string, unknown>): Promise<void> {
  const eventId = typeof payload.id === "string" ? payload.id : `evt_local_${randomUUID().replaceAll("-", "")}`;
  const type = typeof payload.type === "string" ? payload.type : "unknown";
  const data = payload.data as { object?: Record<string, unknown> } | undefined;
  const object = data?.object ?? {};
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const accountId =
    typeof metadata?.account_id === "string" ? metadata.account_id :
    typeof object.client_reference_id === "string" ? object.client_reference_id :
    null;

  await query(
    `insert into billing_events (id, account_id, provider_event_id, event_type, payload)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (provider_event_id) do nothing`,
    [`bevt_${randomUUID().replaceAll("-", "")}`, accountId, eventId, type, JSON.stringify(payload)],
  );
  if (!accountId) return;

  if (type === "checkout.session.completed") {
    await query(
      `update accounts
       set stripe_customer_id = coalesce($2, stripe_customer_id),
           stripe_subscription_id = coalesce($3, stripe_subscription_id),
           billing_status = 'active',
           updated_at = now()
       where id = $1`,
      [
        accountId,
        typeof object.customer === "string" ? object.customer : null,
        typeof object.subscription === "string" ? object.subscription : null,
      ],
    );
  }
  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const active = object.status === "active" || object.status === "trialing";
    await query(
      `update accounts
       set stripe_subscription_id = coalesce($2, stripe_subscription_id),
           billing_status = $3,
           updated_at = now()
       where id = $1`,
      [
        accountId,
        typeof object.id === "string" ? object.id : null,
        active ? "active" : "past_due",
      ],
    );
  }
}

async function getWhiteLabel(ctx: AuthContext) {
  const result = await query<WhiteLabelRow>(
    `select account_id, domain, brand_name, accent_color, support_url, pii_public, updated_at
     from white_label_settings
     where account_id = $1`,
    [ctx.accountId],
  );
  return result.rows[0] ?? {
    account_id: ctx.accountId,
    domain: null,
    brand_name: null,
    accent_color: "#08756f",
    support_url: null,
    pii_public: false,
    updated_at: nowIso(),
  };
}

async function updateWhiteLabel(ctx: AuthContext, input: Record<string, unknown>) {
  const result = await query<WhiteLabelRow>(
    `insert into white_label_settings (account_id, domain, brand_name, accent_color, support_url, pii_public, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (account_id) do update
     set domain = excluded.domain,
         brand_name = excluded.brand_name,
         accent_color = excluded.accent_color,
         support_url = excluded.support_url,
         pii_public = excluded.pii_public,
         updated_at = now()
     returning account_id, domain, brand_name, accent_color, support_url, pii_public, updated_at`,
    [
      ctx.accountId,
      typeof input.domain === "string" && input.domain.trim() ? input.domain.trim() : null,
      typeof input.brand_name === "string" && input.brand_name.trim() ? input.brand_name.trim() : null,
      typeof input.accent_color === "string" && /^#[0-9a-f]{6}$/i.test(input.accent_color) ? input.accent_color : "#08756f",
      typeof input.support_url === "string" && input.support_url.trim() ? input.support_url.trim() : null,
      input.pii_public === true,
    ],
  );
  return result.rows[0]!;
}

function publicWebhook(record: WebhookRow) {
  return {
    id: record.id,
    url: record.url,
    event_types: record.event_types,
    enabled: record.enabled,
    consecutive_failures: record.consecutive_failures,
    created_at: record.created_at,
    disabled_at: record.disabled_at,
    secret_preview: `${record.secret.slice(0, 12)}...`,
  };
}

const apiDeps = {
  query,
  readBody,
  readRawBody,
  json,
  error,
  auth,
  assertRateLimit,
  verifyStripeSignature,
  applyStripeEvent,
  createSession,
  sessionCookie,
  tokenHash,
  passwordHash,
  verifyPassword,
  parseCookies,
  publicCarrierCatalog,
  detectCarrier,
  listTrackingsForAccount,
  insertTracking,
  getTracking,
  assertTrackingQuota,
  enqueueWebhookEvent,
  enqueueScrape,
  publicWebhook,
  getWhiteLabel,
  updateWhiteLabel,
  listApiKeys,
  makeApiKey,
  accountPlan,
  stripePriceForTier,
  stripeRequest,
  validWebhookUrl,
  signWebhookBody,
  publicToken,
  publicApiBaseUrl,
  appUrl,
  sendEmail,
  currentUser,
  publicUser,
  sendVerificationEmail,
  sendPasswordResetEmail,
} satisfies ApiRouteDeps;

registerBuiltInCarrierApiAdapters();

async function route(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (await handlePublicRoutes({ req, res, url, requestId, deps: apiDeps })) return;
  if (!url.pathname.startsWith("/v1/")) {
    error(res, 404, "not_found", "route not found", requestId);
    return;
  }

  const ctx = await auth(req);
  if (!ctx) {
    error(res, 401, "unauthorized", "missing or invalid API key", requestId);
    return;
  }
  const rateLimit = await assertRateLimit(ctx);
  if (!rateLimit.ok) {
    res.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
    error(res, 429, "rate_limited", `rate limit exceeded (${rateLimit.limit}/min)`, requestId);
    return;
  }

  if (await handleCarrierRoutes({ req, res, url, requestId, auth: ctx, deps: apiDeps })) return;
  if (await handleTrackingRoutes({ req, res, url, requestId, auth: ctx, deps: apiDeps })) return;
  if (await handleWebhookRoutes({ req, res, url, requestId, auth: ctx, deps: apiDeps })) return;
  if (await handleAccountRoutes({ req, res, url, requestId, auth: ctx, deps: apiDeps })) return;

  error(res, 404, "not_found", "route not found", requestId);
}

const port = Number(process.env.PORT ?? 8787);

await migrate();

const server = createServer((req, res) => {
  const requestId = req.headers["x-request-id"]?.toString() ?? randomUUID();
  route(req, res, requestId).catch((err) => {
    logger.error("request failed", {
      request_id: requestId,
      method: req.method,
      path: req.url,
      error: String(err?.message ?? err),
    });
    error(res, 500, "internal_error", String(err?.message ?? err), requestId);
  });
});

const realtime = attachRealtimeServer({
  server,
  authenticate: (req, token) => token ? authToken(token) : auth(req),
});

server.listen(port, () => {
  const digest = createHmac("sha256", "trackified").update(String(port)).digest("hex").slice(0, 8);
  logger.info("listening", {
    host: "http://localhost",
    port,
    digest,
    api_base: apiBaseUrl(),
    web_base: webBaseUrl(),
  });
});

const shutdown = async () => {
  await realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
