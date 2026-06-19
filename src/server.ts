import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { listCarrierCatalog } from "./config/adapter.ts";
import { migrate, pool, query } from "./db.ts";
import { detectCarrier } from "./detect.ts";
import { appUrl, sendEmail } from "./email.ts";
import { enqueueScrape } from "./queue.ts";
import { enqueueWebhookEvent } from "./webhook-dispatch.ts";
import { signWebhookBody, type WebhookEventType } from "./webhooks.ts";

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

interface AuthContext {
  accountId: string;
  apiKeyId: string | null;
  userId: string | null;
  mode: "live" | "test";
  scopes: string[];
}

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
  const origin = process.env.CORS_ORIGIN ?? "http://localhost:3017";
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
  return process.env.EMAIL_PROVIDER === "dev" ? token : undefined;
}

function error(res: ServerResponse, status: number, code: string, message: string, requestId: string): void {
  json(res, status, { error: { code, message, request_id: requestId } }, requestId);
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

async function auth(req: IncomingMessage): Promise<AuthContext | null> {
  const header = req.headers.authorization ?? "";
  const value = Array.isArray(header) ? header[0] ?? "" : header;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (match) {
    const token = match[1]!;
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
    if (key) return { accountId: key.account_id, apiKeyId: key.id, userId: null, mode: key.mode, scopes: key.scopes };
  }

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

function nextScrapeAt(status: TrackingStatus, from = new Date()): string | null {
  const minutes: Partial<Record<TrackingStatus, number>> = {
    not_yet_scanned: 240,
    in_transit: 120,
    out_for_delivery: 30,
  };
  const value = minutes[status];
  return value ? new Date(from.getTime() + value * 60_000).toISOString() : null;
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
    next_scrape_at: nextScrapeAt(status),
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

function pageParams(url: URL) {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  return { limit, offset };
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

async function createSession(res: ServerResponse, user: UserRow): Promise<void> {
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

function openApi() {
  const paginated = (schema: string) => ({
    type: "object",
    required: ["data", "pagination"],
    properties: {
      data: { type: "array", items: { $ref: `#/components/schemas/${schema}` } },
      pagination: { $ref: "#/components/schemas/Pagination" },
    },
  });
  const ok = (schema: unknown) => ({ description: "Success", content: { "application/json": { schema } } });
  const created = (schema: unknown) => ({ description: "Created", content: { "application/json": { schema } } });
  const errorResponse = { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
  return {
    openapi: "3.1.0",
    info: {
      title: "Trackified API",
      version: "1.0.0",
      description: "REST API for shipment tracking registration, carrier detection, event timelines, webhooks, account usage, and API key management.",
    },
    servers: [{ url: "https://api.trackified.dev" }, { url: "http://localhost:8788" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/auth/signup": {
        post: {
          summary: "Create an account and dashboard session",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SignupRequest" } } } },
          responses: { "201": created({ $ref: "#/components/schemas/AuthResponse" }), "409": errorResponse },
        },
      },
      "/v1/auth/login": {
        post: {
          summary: "Create a dashboard session",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } } },
          responses: { "200": ok({ $ref: "#/components/schemas/AuthResponse" }), "401": errorResponse },
        },
      },
      "/v1/auth/me": {
        get: { summary: "Get current dashboard user", responses: { "200": ok({ $ref: "#/components/schemas/MeResponse" }), "401": errorResponse } },
      },
      "/v1/auth/logout": {
        post: { summary: "Revoke dashboard session", responses: { "200": ok({ type: "object", properties: { logged_out: { type: "boolean" } } }) } },
      },
      "/v1/auth/password-reset/request": {
        post: { summary: "Request password reset", security: [], responses: { "200": ok({ type: "object", properties: { requested: { type: "boolean" } } }) } },
      },
      "/v1/auth/password-reset/confirm": {
        post: { summary: "Confirm password reset", security: [], responses: { "200": ok({ type: "object", properties: { reset: { type: "boolean" } } }), "400": errorResponse } },
      },
      "/v1/auth/email-verification/request": {
        post: { summary: "Request email verification", responses: { "200": ok({ type: "object", properties: { requested: { type: "boolean" } } }) } },
      },
      "/v1/auth/email-verification/confirm": {
        post: { summary: "Confirm email verification", responses: { "200": ok({ type: "object", properties: { verified: { type: "boolean" } } }), "400": errorResponse } },
      },
      "/v1/billing/stripe/webhook": {
        post: { summary: "Receive Stripe billing events", security: [], responses: { "200": ok({ type: "object", properties: { received: { type: "boolean" } } }), "400": errorResponse } },
      },
      "/v1/trackings": {
        get: {
          summary: "List trackings",
          parameters: [{ $ref: "#/components/parameters/Limit" }, { $ref: "#/components/parameters/Offset" }, { name: "status", in: "query", schema: { $ref: "#/components/schemas/TrackingStatus" } }, { name: "carrier", in: "query", schema: { type: "string" } }],
          responses: { "200": ok(paginated("Tracking")), "401": errorResponse },
        },
        post: {
          summary: "Register a tracking number",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateTrackingRequest" } } } },
          responses: { "201": created({ $ref: "#/components/schemas/Tracking" }), "400": errorResponse, "401": errorResponse },
        },
      },
      "/v1/trackings/{id}": {
        get: { summary: "Get a tracking", parameters: [{ $ref: "#/components/parameters/TrackingId" }], responses: { "200": ok({ $ref: "#/components/schemas/Tracking" }), "404": errorResponse } },
        put: {
          summary: "Update tracking metadata",
          parameters: [{ $ref: "#/components/parameters/TrackingId" }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateTrackingRequest" } } } },
          responses: { "200": ok({ $ref: "#/components/schemas/Tracking" }), "404": errorResponse },
        },
        delete: { summary: "Stop tracking", parameters: [{ $ref: "#/components/parameters/TrackingId" }], responses: { "200": ok({ $ref: "#/components/schemas/DeleteResponse" }), "404": errorResponse } },
      },
      "/v1/trackings/{id}/retrack": {
        post: { summary: "Queue a fresh carrier lookup", parameters: [{ $ref: "#/components/parameters/TrackingId" }], responses: { "202": ok({ $ref: "#/components/schemas/QueuedTracking" }), "404": errorResponse } },
      },
      "/v1/trackings/bulk": {
        post: {
          summary: "Register up to 40 tracking numbers",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["trackings"], properties: { trackings: { type: "array", maxItems: 40, items: { $ref: "#/components/schemas/CreateTrackingRequest" } } } } } } },
          responses: { "207": ok({ type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/BulkTrackingResult" } } } }) },
        },
      },
      "/v1/trackings/lookup/bulk": {
        post: {
          summary: "Queue synchronous-style bulk lookup",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["trackings"], properties: { trackings: { type: "array", maxItems: 40, items: { $ref: "#/components/schemas/CreateTrackingRequest" } } } } } } },
          responses: { "202": ok({ type: "object", properties: { timeout_ms: { type: "integer" }, data: { type: "array", items: { $ref: "#/components/schemas/BulkLookupResult" } } } }) },
        },
      },
      "/v1/carriers": {
        get: { summary: "List carrier catalog", parameters: [{ $ref: "#/components/parameters/Limit" }, { $ref: "#/components/parameters/Offset" }], responses: { "200": ok(paginated("Carrier")) } },
      },
      "/v1/carriers/detect": {
        get: { summary: "Detect carrier candidates for a tracking number", parameters: [{ name: "number", in: "query", required: true, schema: { type: "string" } }], responses: { "200": ok({ $ref: "#/components/schemas/CarrierDetection" }), "400": errorResponse } },
      },
      "/v1/carriers/{id}": {
        get: { summary: "Get carrier metadata", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": ok({ $ref: "#/components/schemas/Carrier" }), "404": errorResponse } },
      },
      "/v1/webhooks": {
        get: { summary: "List webhooks", responses: { "200": ok(paginated("Webhook")) } },
        post: { summary: "Create webhook", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateWebhookRequest" } } } }, responses: { "201": created({ $ref: "#/components/schemas/Webhook" }), "400": errorResponse } },
      },
      "/v1/webhooks/{id}": {
        delete: { summary: "Delete webhook", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": ok({ $ref: "#/components/schemas/DeleteResponse" }), "404": errorResponse } },
      },
      "/v1/webhooks/{id}/test": {
        post: { summary: "Generate a signed webhook test payload", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": ok({ $ref: "#/components/schemas/WebhookTest" }), "404": errorResponse } },
      },
      "/v1/webhook-deliveries": {
        get: { summary: "List webhook delivery attempts", parameters: [{ $ref: "#/components/parameters/Limit" }, { $ref: "#/components/parameters/Offset" }], responses: { "200": ok(paginated("WebhookDelivery")) } },
      },
      "/v1/account/usage": { get: { summary: "Get account usage", responses: { "200": ok({ $ref: "#/components/schemas/Usage" }) } } },
      "/v1/account/email-outbox": {
        get: { summary: "List account email delivery records", responses: { "200": ok(paginated("EmailOutboxEntry")) } },
      },
      "/v1/account/plan": { get: { summary: "Get account plan", responses: { "200": ok({ $ref: "#/components/schemas/Plan" }) } } },
      "/v1/account/billing/checkout": {
        post: { summary: "Create billing checkout URL", responses: { "200": ok({ $ref: "#/components/schemas/BillingLink" }), "501": errorResponse } },
      },
      "/v1/account/billing/portal": {
        post: { summary: "Create billing portal URL", responses: { "200": ok({ $ref: "#/components/schemas/BillingLink" }), "501": errorResponse } },
      },
      "/v1/account/team": {
        get: { summary: "List team members and invites", responses: { "200": ok({ $ref: "#/components/schemas/Team" }) } },
      },
      "/v1/account/team/invites": {
        post: { summary: "Create team invite", responses: { "201": created({ type: "object" }), "400": errorResponse } },
      },
      "/v1/account/team/invites/accept": {
        post: { summary: "Accept team invite", responses: { "200": ok({ $ref: "#/components/schemas/AuthResponse" }), "400": errorResponse } },
      },
      "/v1/account/white-label": {
        get: { summary: "Get white-label tracking page settings", responses: { "200": ok({ $ref: "#/components/schemas/WhiteLabelSettings" }) } },
        put: {
          summary: "Update white-label tracking page settings",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WhiteLabelSettingsInput" } } } },
          responses: { "200": ok({ $ref: "#/components/schemas/WhiteLabelSettings" }) },
        },
      },
      "/v1/account/api-keys": {
        get: { summary: "List API keys", responses: { "200": ok(paginated("ApiKey")) } },
        post: { summary: "Create API key", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateApiKeyRequest" } } } }, responses: { "201": created({ $ref: "#/components/schemas/CreatedApiKey" }) } },
      },
      "/v1/account/api-keys/{id}": {
        delete: { summary: "Revoke API key", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": ok({ type: "object", properties: { revoked: { type: "boolean" }, id: { type: "string" } } }), "404": errorResponse } },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      parameters: {
        Limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        Offset: { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        TrackingId: { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^trk_" } },
      },
      schemas: {
        TrackingStatus: { type: "string", enum: ["not_yet_scanned", "in_transit", "out_for_delivery", "delivered", "exception", "unknown"] },
        SignupRequest: { type: "object", required: ["company", "email", "password"], properties: { company: { type: "string" }, name: { type: "string" }, email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } },
        LoginRequest: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string" } } },
        DashboardUser: { type: "object", properties: { id: { type: "string" }, account_id: { type: "string" }, account_name: { type: ["string", "null"] }, email: { type: "string", format: "email" }, name: { type: ["string", "null"] } } },
        AuthResponse: { type: "object", properties: { user: { $ref: "#/components/schemas/DashboardUser" } } },
        MeResponse: { type: "object", properties: { authenticated: { type: "boolean" }, user: { anyOf: [{ $ref: "#/components/schemas/DashboardUser" }, { type: "null" }] }, account_id: { type: "string" } } },
        CreateTrackingRequest: { type: "object", required: ["tracking_number"], properties: { tracking_number: { type: "string" }, carrier: { type: "string" }, custom_id: { type: "string" }, customer_email: { type: "string", format: "email" } } },
        UpdateTrackingRequest: { type: "object", properties: { carrier: { type: "string" }, custom_id: { type: "string" }, customer_email: { type: "string", format: "email" } } },
        TrackingEvent: { type: "object", properties: { occurred_at: { type: "string", format: "date-time" }, status: { type: "string" }, location: { type: "string" }, description: { type: "string" }, via_carrier: { type: "string" } } },
        Tracking: { type: "object", required: ["id", "tracking_number", "status", "events", "created_at", "updated_at"], properties: { id: { type: "string" }, tracking_number: { type: "string" }, carrier: { type: ["string", "null"] }, carrier_detected: { type: "boolean" }, status: { $ref: "#/components/schemas/TrackingStatus" }, delivered_at: { type: ["string", "null"], format: "date-time" }, estimated_delivery: { type: ["string", "null"], format: "date" }, origin: { type: ["object", "null"] }, destination: { type: ["object", "null"] }, events: { type: "array", items: { $ref: "#/components/schemas/TrackingEvent" } }, service_level: { type: ["string", "null"] }, weight_grams: { type: ["integer", "null"] }, exception: { type: ["string", "null"] }, last_scraped_at: { type: ["string", "null"], format: "date-time" }, next_scrape_at: { type: ["string", "null"], format: "date-time" }, custom_id: { type: ["string", "null"] }, customer_email: { type: ["string", "null"] }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" } } },
        QueuedTracking: { type: "object", properties: { queued: { type: "boolean" }, tracking: { $ref: "#/components/schemas/Tracking" } } },
        BulkTrackingResult: { type: "object", properties: { ok: { type: "boolean" }, tracking: { $ref: "#/components/schemas/Tracking" }, error: { type: "string" } } },
        BulkLookupResult: { type: "object", properties: { ok: { type: "boolean" }, queued: { type: "boolean" }, tracking_id: { type: "string" }, tracking_number: { type: "string" }, error: { type: "string" } } },
        Carrier: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" }, regions: { type: "array", items: { type: "string" } } } },
        CarrierDetection: { type: "object", properties: { tracking_number: { type: "string" }, candidates: { type: "array", items: { type: "object", properties: { carrier: { type: "string" }, confidence: { type: "number" }, reason: { type: "string" } } } } } },
        CreateWebhookRequest: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, event_types: { type: "array", items: { type: "string" } } } },
        Webhook: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, event_types: { type: "array", items: { type: "string" } }, secret_preview: { type: "string" }, enabled: { type: "boolean" }, consecutive_failures: { type: "integer" }, created_at: { type: "string", format: "date-time" }, disabled_at: { type: ["string", "null"], format: "date-time" } } },
        WebhookTest: { type: "object", properties: { delivered: { type: "boolean" }, dry_run: { type: "boolean" }, signature: { type: "string" }, body: { type: "object" } } },
        WebhookDelivery: { type: "object", properties: { id: { type: "string" }, webhook_id: { type: "string" }, url: { type: ["string", "null"] }, event_type: { type: "string" }, status: { type: ["integer", "null"] }, attempts: { type: "integer" }, error: { type: ["string", "null"] }, delivered_at: { type: ["string", "null"], format: "date-time" }, created_at: { type: "string", format: "date-time" } } },
        Usage: { type: "object", properties: { period_start: { type: "string" }, period_end: { type: "string" }, trackings_used: { type: "integer" }, trackings_limit: { type: "integer" }, rate_limit_per_minute: { type: "integer" }, webhook_deliveries: { type: "integer" }, carrier_volume: { type: "array", items: { type: "object", properties: { carrier: { type: "string" }, count: { type: "integer" } } } } } },
        EmailOutboxEntry: { type: "object", properties: { id: { type: "string" }, to_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, provider: { type: "string" }, status: { type: "string" }, error: { type: ["string", "null"] }, sent_at: { type: ["string", "null"], format: "date-time" }, created_at: { type: "string", format: "date-time" } } },
        Plan: { type: "object", properties: { account_id: { type: "string" }, account_name: { type: "string" }, tier: { type: "string" }, monthly_price_usd: { type: "number" }, trackings_limit: { type: "integer" }, rate_limit_per_minute: { type: "integer" }, bulk_limit: { type: "integer" }, realtime_ws: { type: "boolean" }, overage_usd_per_tracking: { type: "number" } } },
        BillingLink: { type: "object", properties: { configured: { type: "boolean" }, url: { type: "string" }, error: { type: "object" } } },
        Team: { type: "object", properties: { users: { type: "array", items: { type: "object" } }, invites: { type: "array", items: { type: "object" } } } },
        WhiteLabelSettings: { type: "object", properties: { account_id: { type: "string" }, domain: { type: ["string", "null"] }, brand_name: { type: ["string", "null"] }, accent_color: { type: "string" }, support_url: { type: ["string", "null"] }, pii_public: { type: "boolean" }, updated_at: { type: "string", format: "date-time" } } },
        WhiteLabelSettingsInput: { type: "object", properties: { domain: { type: "string" }, brand_name: { type: "string" }, accent_color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, support_url: { type: "string" }, pii_public: { type: "boolean" } } },
        ApiKey: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, prefix: { type: "string" }, mode: { type: "string", enum: ["live", "test"] }, scopes: { type: "array", items: { type: "string" } }, created_at: { type: "string", format: "date-time" }, last_used_at: { type: ["string", "null"], format: "date-time" }, revoked_at: { type: ["string", "null"], format: "date-time" } } },
        CreatedApiKey: { allOf: [{ $ref: "#/components/schemas/ApiKey" }, { type: "object", properties: { token: { type: "string", description: "Shown once at creation time." } } }] },
        CreateApiKeyRequest: { type: "object", properties: { name: { type: "string" }, mode: { type: "string", enum: ["live", "test"] }, scopes: { type: "array", items: { type: "string" } } } },
        Pagination: { type: "object", required: ["limit", "offset", "total"], properties: { limit: { type: "integer" }, offset: { type: "integer" }, total: { type: "integer" } } },
        DeleteResponse: { type: "object", properties: { deleted: { type: "boolean" }, id: { type: "string" } } },
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, request_id: { type: "string" } } } } },
      },
    },
  };
}

async function route(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "OPTIONS") return json(res, 204, {}, requestId);
  if (url.pathname === "/healthz") return json(res, 200, { ok: true }, requestId);
  if (url.pathname === "/openapi.json") return json(res, 200, openApi(), requestId);
  if (req.method === "POST" && url.pathname === "/v1/billing/stripe/webhook") {
    const rawBody = await readRawBody(req);
    const signature = Array.isArray(req.headers["stripe-signature"]) ? req.headers["stripe-signature"][0] : req.headers["stripe-signature"];
    if (!verifyStripeSignature(rawBody, signature)) {
      return error(res, 400, "bad_signature", "invalid Stripe signature", requestId);
    }
    const payload = rawBody ? JSON.parse(rawBody) : {};
    await applyStripeEvent(payload);
    return json(res, 200, { received: true }, requestId);
  }
  const publicTrackingMatch = /^\/public\/trackings\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && publicTrackingMatch) {
    const result = await query(
      `select t.id, t.tracking_number, t.carrier, t.status, t.delivered_at, t.estimated_delivery,
              t.events, t.service_level, t.exception, t.last_scraped_at, t.created_at, t.updated_at,
              w.brand_name, w.accent_color, w.support_url, w.pii_public
       from trackings t
       left join white_label_settings w on w.account_id = t.account_id
       where t.id = $1 and t.stopped_at is null`,
      [publicTrackingMatch[1]],
    );
    const row = result.rows[0];
    if (!row) return error(res, 404, "not_found", "tracking not found", requestId);
    return json(res, 200, {
      id: row.id,
      tracking_number: row.pii_public ? row.tracking_number : `${String(row.tracking_number).slice(0, 4)}...${String(row.tracking_number).slice(-4)}`,
      carrier: row.carrier,
      status: row.status,
      delivered_at: row.delivered_at,
      estimated_delivery: row.estimated_delivery,
      events: row.events ?? [],
      service_level: row.service_level,
      exception: row.exception,
      last_scraped_at: row.last_scraped_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      brand: {
        name: row.brand_name ?? "Trackified",
        accent_color: row.accent_color ?? "#08756f",
        support_url: row.support_url,
      },
    }, requestId);
  }
  if (!url.pathname.startsWith("/v1/")) return error(res, 404, "not_found", "route not found", requestId);

  if (req.method === "POST" && url.pathname === "/v1/auth/signup") {
    const body = await readBody(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const company = typeof body.company === "string" && body.company.trim() ? body.company.trim() : "New workspace";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    if (!email || !email.includes("@")) return error(res, 400, "bad_request", "valid email is required", requestId);
    if (password.length < 8) return error(res, 400, "bad_request", "password must be at least 8 characters", requestId);
    const accountId = `acct_${randomUUID().replaceAll("-", "")}`;
    const userId = `usr_${randomUUID().replaceAll("-", "")}`;
    try {
      await query("begin");
      await query(
        `insert into accounts (id, name) values ($1, $2)`,
        [accountId, company],
      );
      const userResult = await query<UserRow>(
        `insert into users (id, account_id, email, name, password_hash)
         values ($1, $2, $3, $4, $5)
         returning *`,
        [userId, accountId, email, name, passwordHash(password)],
      );
      await query("commit");
      const user = { ...userResult.rows[0]!, account_name: company };
      const verificationToken = await sendVerificationEmail(user);
      await createSession(res, user);
      return json(res, 201, { user: publicUser(user), verification_token: verificationToken }, requestId);
    } catch (err) {
      await query("rollback").catch(() => undefined);
      if (String((err as Error).message).includes("duplicate key")) {
        return error(res, 409, "conflict", "email is already registered", requestId);
      }
      throw err;
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/login") {
    const body = await readBody(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const result = await query<UserRow>(
      `select u.*, a.name as account_name
       from users u
       join accounts a on a.id = u.account_id
       where u.email = $1`,
      [email],
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return error(res, 401, "unauthorized", "invalid email or password", requestId);
    }
    await createSession(res, user);
    return json(res, 200, { user: publicUser(user) }, requestId);
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/password-reset/request") {
    const body = await readBody(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const userResult = await query<UserRow>(`select * from users where email = $1`, [email]);
    const user = userResult.rows[0];
    if (!user) return json(res, 200, { requested: true }, requestId);
    const token = await sendPasswordResetEmail(user);
    return json(res, 200, { requested: true, token: publicToken(token) }, requestId);
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/password-reset/confirm") {
    const body = await readBody(req);
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8) return error(res, 400, "bad_request", "password must be at least 8 characters", requestId);
    const tokenResult = await query<{ id: string; user_id: string }>(
      `select id, user_id from user_tokens
       where token_hash = $1 and kind = 'password_reset' and used_at is null and expires_at > now()`,
      [tokenHash(token)],
    );
    const row = tokenResult.rows[0];
    if (!row) return error(res, 400, "bad_request", "invalid or expired reset token", requestId);
    await query(`update users set password_hash = $2, updated_at = now() where id = $1`, [row.user_id, passwordHash(password)]);
    await query(`update user_tokens set used_at = now() where id = $1`, [row.id]);
    await query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [row.user_id]);
    return json(res, 200, { reset: true }, requestId);
  }

  const ctx = await auth(req);
  if (!ctx) return error(res, 401, "unauthorized", "missing or invalid API key", requestId);
  const rateLimit = await assertRateLimit(ctx);
  if (!rateLimit.ok) {
    res.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
    return error(res, 429, "rate_limited", `rate limit exceeded (${rateLimit.limit}/min)`, requestId);
  }

  if (req.method === "GET" && url.pathname === "/v1/auth/me") {
    const user = await currentUser(ctx);
    return json(res, 200, { authenticated: Boolean(user), user, account_id: ctx.accountId }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
    const sessionToken = parseCookies(req).trackified_session;
    if (sessionToken) {
      await query(`update sessions set revoked_at = now() where token_hash = $1`, [tokenHash(sessionToken)]);
    }
    res.setHeader("set-cookie", sessionCookie("", 0));
    return json(res, 200, { logged_out: true }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/auth/email-verification/request") {
    const user = await currentUser(ctx);
    if (!user) return error(res, 400, "bad_request", "dashboard session required", requestId);
    const fullUser = await query<UserRow>(`select * from users where id = $1 and account_id = $2`, [user.id, ctx.accountId]);
    const token = fullUser.rows[0] ? await sendVerificationEmail(fullUser.rows[0]!) : undefined;
    return json(res, 200, { requested: true, token }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/v1/account/email-outbox") {
    const { limit, offset } = pageParams(url);
    const result = await query(
      `select id, to_email, subject, body, provider, status, error, sent_at, created_at,
              count(*) over() as total_count
       from email_outbox
       where account_id = $1
       order by created_at desc
       limit $2 offset $3`,
      [ctx.accountId, limit, offset],
    );
    const total = Number((result.rows[0] as { total_count?: string } | undefined)?.total_count ?? 0);
    return json(res, 200, { data: result.rows, pagination: { limit, offset, total } }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/auth/email-verification/confirm") {
    const body = await readBody(req);
    const token = typeof body.token === "string" ? body.token : "";
    const tokenResult = await query<{ id: string; user_id: string }>(
      `select id, user_id from user_tokens
       where token_hash = $1 and kind = 'email_verify' and used_at is null and expires_at > now()`,
      [tokenHash(token)],
    );
    const row = tokenResult.rows[0];
    if (!row) return error(res, 400, "bad_request", "invalid or expired verification token", requestId);
    await query(`update users set email_verified_at = now(), updated_at = now() where id = $1`, [row.user_id]);
    await query(`update user_tokens set used_at = now() where id = $1`, [row.id]);
    return json(res, 200, { verified: true }, requestId);
  }

  if (req.method === "GET" && url.pathname === "/v1/carriers") {
    const { limit, offset } = pageParams(url);
    const catalog = listCarrierCatalog();
    return json(res, 200, { data: catalog.slice(offset, offset + limit), pagination: { limit, offset, total: catalog.length } }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/v1/carriers/detect") {
    const number = url.searchParams.get("number");
    if (!number) return error(res, 400, "bad_request", "number is required", requestId);
    return json(res, 200, { tracking_number: number, candidates: detectCarrier(number) }, requestId);
  }
  const carrierMatch = /^\/v1\/carriers\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && carrierMatch) {
    const carrier = listCarrierCatalog().find((item) => item.id === carrierMatch[1]);
    return carrier ? json(res, 200, carrier, requestId) : error(res, 404, "not_found", "carrier not found", requestId);
  }

  if (req.method === "POST" && url.pathname === "/v1/trackings") {
    const quota = await assertTrackingQuota(ctx, 1);
    if (!quota.ok) return error(res, 402, "quota_exceeded", `monthly tracking quota exceeded (${quota.used}/${quota.limit})`, requestId);
    const tracking = await insertTracking(await readBody(req), ctx);
    await enqueueWebhookEvent(ctx.accountId, "tracking.created", tracking);
    return json(res, 201, tracking, requestId);
  }
  if (req.method === "GET" && url.pathname === "/v1/trackings") {
    return json(res, 200, await listTrackingsForAccount(url, ctx), requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/trackings/bulk") {
    const body = await readBody(req);
    const rows = Array.isArray(body.trackings) ? body.trackings.slice(0, 40) : [];
    const quota = await assertTrackingQuota(ctx, rows.length);
    if (!quota.ok) return error(res, 402, "quota_exceeded", `monthly tracking quota exceeded (${quota.used}/${quota.limit})`, requestId);
    const data = [];
    for (const row of rows) {
      try {
        const tracking = await insertTracking(row as Record<string, unknown>, ctx);
        await enqueueWebhookEvent(ctx.accountId, "tracking.created", tracking);
        data.push({ ok: true, tracking });
      } catch (err) {
        data.push({ ok: false, error: String((err as Error).message ?? err) });
      }
    }
    return json(res, 207, { data }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/trackings/lookup/bulk") {
    const body = await readBody(req);
    const rows = Array.isArray(body.trackings) ? body.trackings.slice(0, 40) : [];
    const quota = await assertTrackingQuota(ctx, rows.length);
    if (!quota.ok) return error(res, 402, "quota_exceeded", `monthly tracking quota exceeded (${quota.used}/${quota.limit})`, requestId);
    const data = [];
    for (const row of rows) {
      try {
        const tracking = await insertTracking(row as Record<string, unknown>, ctx);
        await enqueueWebhookEvent(ctx.accountId, "tracking.created", tracking);
        data.push({ ok: true, queued: true, tracking_id: tracking.id, tracking_number: tracking.tracking_number });
      } catch (err) {
        data.push({ ok: false, error: String((err as Error).message ?? err) });
      }
    }
    return json(res, 202, { data, timeout_ms: 12000 }, requestId);
  }

  const trackingAction = /^\/v1\/trackings\/([^/]+)(?:\/(retrack))?$/.exec(url.pathname);
  if (trackingAction) {
    const tracking = await getTracking(trackingAction[1]!, ctx);
    if (!tracking) return error(res, 404, "not_found", "tracking not found", requestId);
    if (req.method === "GET" && !trackingAction[2]) return json(res, 200, tracking, requestId);
    if (req.method === "PUT" && !trackingAction[2]) {
      const body = await readBody(req);
      const result = await query<TrackingRecord>(
        `update trackings
         set custom_id = coalesce($2, custom_id),
             customer_email = coalesce($3, customer_email),
             carrier = coalesce($4, carrier),
             updated_at = now()
         where id = $1 and account_id = $5 and stopped_at is null
         returning *`,
        [
          tracking.id,
          typeof body.custom_id === "string" ? body.custom_id : null,
          typeof body.customer_email === "string" ? body.customer_email : null,
          typeof body.carrier === "string" ? body.carrier : null,
          ctx.accountId,
        ],
      );
      const updated = normalizeTracking(result.rows[0]!);
      await enqueueWebhookEvent(ctx.accountId, "tracking.updated", updated);
      return json(res, 200, updated, requestId);
    }
    if (req.method === "DELETE" && !trackingAction[2]) {
      await query(`update trackings set stopped_at = now(), updated_at = now() where id = $1 and account_id = $2`, [tracking.id, ctx.accountId]);
      return json(res, 200, { deleted: true, id: tracking.id }, requestId);
    }
    if (req.method === "POST" && trackingAction[2] === "retrack") {
      await enqueueScrape({ tracking_id: tracking.id, carrier: tracking.carrier, tracking_number: tracking.tracking_number, reason: "retrack" });
      return json(res, 202, { queued: true, tracking }, requestId);
    }
  }

  if (req.method === "GET" && url.pathname === "/v1/webhooks") {
    const { limit, offset } = pageParams(url);
    const result = await query<WebhookRow>(
      `select *, count(*) over() as total_count
       from webhooks
       where account_id = $1 and disabled_at is null
       order by created_at desc limit $2 offset $3`,
      [ctx.accountId, limit, offset],
    );
    const total = Number((result.rows[0] as WebhookRow & { total_count?: string } | undefined)?.total_count ?? 0);
    return json(res, 200, { data: result.rows.map(publicWebhook), pagination: { limit, offset, total } }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/webhooks") {
    const body = await readBody(req);
    if (typeof body.url !== "string") return error(res, 400, "bad_request", "url is required", requestId);
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const result = await query<WebhookRow>(
      `insert into webhooks (id, account_id, url, event_types, secret, created_at)
       values ($1, $2, $3, $4, $5, now())
       returning *`,
      [
        `wh_${randomUUID().replaceAll("-", "")}`,
        ctx.accountId,
        body.url,
        Array.isArray(body.event_types) ? body.event_types.map(String) : ["tracking.updated", "tracking.delivered"],
        secret,
      ],
    );
    return json(res, 201, publicWebhook(result.rows[0]!), requestId);
  }
  const webhookAction = /^\/v1\/webhooks\/([^/]+)(?:\/(test))?$/.exec(url.pathname);
  if (webhookAction) {
    const result = await query<WebhookRow>(`select * from webhooks where id = $1 and account_id = $2`, [webhookAction[1], ctx.accountId]);
    const hook = result.rows[0];
    if (!hook) return error(res, 404, "not_found", "webhook not found", requestId);
    if (req.method === "DELETE" && !webhookAction[2]) {
      await query(`update webhooks set enabled = false, disabled_at = now() where id = $1 and account_id = $2`, [hook.id, ctx.accountId]);
      return json(res, 200, { deleted: true, id: hook.id }, requestId);
    }
    if (req.method === "POST" && webhookAction[2] === "test") {
      const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: "tracking.updated", created_at: nowIso(), data: { test: true } });
      await query(
        `insert into webhook_deliveries
         (id, account_id, webhook_id, event_type, status, attempts, payload, created_at)
         values ($1, $2, $3, 'tracking.updated', null, 0, $4::jsonb, now())`,
        [`whd_${randomUUID().replaceAll("-", "")}`, ctx.accountId, hook.id, body],
      );
      return json(res, 200, { delivered: false, dry_run: true, signature: signWebhookBody(body, hook.secret), body: JSON.parse(body) }, requestId);
    }
  }

  if (req.method === "GET" && url.pathname === "/v1/webhook-deliveries") {
    const { limit, offset } = pageParams(url);
    const result = await query(
      `select wd.id, wd.webhook_id, w.url, wd.event_type, wd.status, wd.attempts, wd.error,
              wd.delivered_at, wd.created_at, count(*) over() as total_count
       from webhook_deliveries wd
       left join webhooks w on w.id = wd.webhook_id
       where wd.account_id = $1
       order by wd.created_at desc
       limit $2 offset $3`,
      [ctx.accountId, limit, offset],
    );
    const total = Number((result.rows[0] as { total_count?: string } | undefined)?.total_count ?? 0);
    return json(res, 200, { data: result.rows, pagination: { limit, offset, total } }, requestId);
  }

  if (req.method === "GET" && url.pathname === "/v1/account/white-label") {
    return json(res, 200, await getWhiteLabel(ctx), requestId);
  }
  if (req.method === "PUT" && url.pathname === "/v1/account/white-label") {
    return json(res, 200, await updateWhiteLabel(ctx, await readBody(req)), requestId);
  }

  if (req.method === "GET" && url.pathname === "/v1/account/usage") {
    const result = await query<{ count: string }>(
      `select count(*) from trackings where account_id = $1 and created_at >= date_trunc('month', now())`,
      [ctx.accountId],
    );
    const webhookResult = await query<{ count: string }>(
      `select count(*) from webhook_deliveries where account_id = $1 and created_at >= date_trunc('month', now())`,
      [ctx.accountId],
    );
    const carrierResult = await query<{ carrier: string; count: string }>(
      `select coalesce(carrier, 'unknown') as carrier, count(*)::text
       from trackings
       where account_id = $1 and created_at >= date_trunc('month', now())
       group by coalesce(carrier, 'unknown')
       order by count(*) desc`,
      [ctx.accountId],
    );
    const accountResult = await query<AccountRow>(`select * from accounts where id = $1`, [ctx.accountId]);
    const account = accountResult.rows[0];
    const windowResult = await query<{ period_start: string; period_end: string }>(
      `select date_trunc('month', now())::text as period_start,
              (date_trunc('month', now()) + interval '1 month')::text as period_end`,
    );
    return json(res, 200, {
      period_start: windowResult.rows[0]?.period_start,
      period_end: windowResult.rows[0]?.period_end,
      trackings_used: Number(result.rows[0]?.count ?? 0),
      trackings_limit: Number(account?.monthly_tracking_limit ?? process.env.FREE_TRACKINGS_LIMIT ?? 100),
      rate_limit_per_minute: Number(account?.rate_limit_per_minute ?? process.env.FREE_RATE_LIMIT_PER_MINUTE ?? 60),
      webhook_deliveries: Number(webhookResult.rows[0]?.count ?? 0),
      carrier_volume: carrierResult.rows.map((row) => ({ carrier: row.carrier, count: Number(row.count) })),
    }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/v1/account/plan") {
    const accountResult = await query<AccountRow>(`select * from accounts where id = $1`, [ctx.accountId]);
    const account = accountResult.rows[0];
    return json(res, 200, {
      account_id: ctx.accountId,
      account_name: account?.name ?? "Development account",
      tier: account?.plan_tier ?? process.env.DEFAULT_PLAN_TIER ?? "free",
      monthly_price_usd: Number(process.env.DEFAULT_PLAN_PRICE_USD ?? 0),
      trackings_limit: Number(account?.monthly_tracking_limit ?? 100),
      rate_limit_per_minute: Number(account?.rate_limit_per_minute ?? 60),
      bulk_limit: Number(account?.bulk_limit ?? process.env.DEFAULT_BULK_LIMIT ?? 5),
      realtime_ws: account?.realtime_ws ?? process.env.DEFAULT_REALTIME_WS === "true",
      overage_usd_per_tracking: Number(account?.overage_usd_per_tracking ?? process.env.DEFAULT_OVERAGE_USD_PER_TRACKING ?? 0.01),
    }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/account/billing/checkout") {
    const body = await readBody(req);
    const tier = typeof body.tier === "string" ? body.tier : "starter";
    const price = stripePriceForTier(tier);
    const successUrl = process.env.STRIPE_SUCCESS_URL ?? appUrl("/dashboard/billing?checkout=success");
    const cancelUrl = process.env.STRIPE_CANCEL_URL ?? appUrl("/dashboard/billing?checkout=cancelled");
    if (!process.env.STRIPE_SECRET_KEY || !price) {
      const checkoutBase = process.env.STRIPE_CHECKOUT_BASE_URL;
      if (!checkoutBase) {
        return json(res, 501, { configured: false, error: { code: "not_configured", message: "Stripe checkout is not configured" } }, requestId);
      }
      return json(res, 200, {
        configured: true,
        url: `${checkoutBase}?client_reference_id=${encodeURIComponent(ctx.accountId)}&tier=${encodeURIComponent(tier)}`,
      }, requestId);
    }
    const session = await stripeRequest("/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      client_reference_id: ctx.accountId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      "metadata[account_id]": ctx.accountId,
      "metadata[tier]": tier,
    });
    return json(res, 200, { configured: true, url: session.url }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/account/billing/portal") {
    const account = await accountPlan(ctx.accountId);
    if (!process.env.STRIPE_SECRET_KEY || !account.stripe_customer_id) {
      const portalBase = process.env.STRIPE_PORTAL_BASE_URL;
      if (portalBase && account.stripe_customer_id) {
        return json(res, 200, {
          configured: true,
          url: `${portalBase}?customer=${encodeURIComponent(account.stripe_customer_id)}`,
        }, requestId);
      }
      return json(res, 501, { configured: false, error: { code: "not_configured", message: "Stripe billing portal is not configured for this account" } }, requestId);
    }
    const session = await stripeRequest("/billing_portal/sessions", {
      customer: account.stripe_customer_id,
      return_url: process.env.STRIPE_PORTAL_RETURN_URL ?? appUrl("/dashboard/billing"),
    });
    return json(res, 200, { configured: true, url: session.url }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/v1/account/team") {
    const users = await query(
      `select id, email, name, email_verified_at, created_at
       from users
       where account_id = $1
       order by created_at asc`,
      [ctx.accountId],
    );
    const invites = await query(
      `select id, email, role, accepted_at, expires_at, created_at
       from team_invites
       where account_id = $1 and accepted_at is null and expires_at > now()
       order by created_at desc`,
      [ctx.accountId],
    );
    return json(res, 200, { users: users.rows, invites: invites.rows }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/account/team/invites") {
    const body = await readBody(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = typeof body.role === "string" && body.role.trim() ? body.role.trim() : "member";
    if (!email || !email.includes("@")) return error(res, 400, "bad_request", "valid email is required", requestId);
    const token = `inv_${randomBytes(32).toString("base64url")}`;
    const result = await query(
      `insert into team_invites (id, account_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + interval '7 days')
       returning id, email, role, accepted_at, expires_at, created_at`,
      [`inv_${randomUUID().replaceAll("-", "")}`, ctx.accountId, email, role, tokenHash(token), ctx.userId],
    );
    await sendEmail({
      accountId: ctx.accountId,
      to: email,
      subject: "You have been invited to Trackified",
      body: `Accept your invite: ${appUrl(`/accept-invite?token=${encodeURIComponent(token)}`)}`,
    });
    return json(res, 201, { invite: result.rows[0], token: publicToken(token) }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/account/team/invites/accept") {
    const body = await readBody(req);
    const token = typeof body.token === "string" ? body.token : "";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8) return error(res, 400, "bad_request", "password must be at least 8 characters", requestId);
    const inviteResult = await query<{ id: string; account_id: string; email: string }>(
      `select id, account_id, email from team_invites
       where token_hash = $1 and accepted_at is null and expires_at > now()`,
      [tokenHash(token)],
    );
    const invite = inviteResult.rows[0];
    if (!invite) return error(res, 400, "bad_request", "invalid or expired invite", requestId);
    const userId = `usr_${randomUUID().replaceAll("-", "")}`;
    const userResult = await query<UserRow>(
      `insert into users (id, account_id, email, name, password_hash)
       values ($1, $2, $3, $4, $5)
       on conflict (email) do update set account_id = excluded.account_id, updated_at = now()
       returning *`,
      [userId, invite.account_id, invite.email, name, passwordHash(password)],
    );
    await query(`update team_invites set accepted_at = now() where id = $1`, [invite.id]);
    await createSession(res, userResult.rows[0]!);
    return json(res, 200, { user: publicUser(userResult.rows[0]!) }, requestId);
  }
  if (req.method === "GET" && url.pathname === "/v1/account/api-keys") {
    return json(res, 200, await listApiKeys(url, ctx), requestId);
  }
  if (req.method === "POST" && url.pathname === "/v1/account/api-keys") {
    return json(res, 201, await makeApiKey(await readBody(req), ctx), requestId);
  }
  const keyMatch = /^\/v1\/account\/api-keys\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && keyMatch) {
    const result = await query<ApiKeyRow>(
      `update api_keys set revoked_at = now() where id = $1 and account_id = $2 and revoked_at is null returning id`,
      [keyMatch[1], ctx.accountId],
    );
    if (!result.rows[0]) return error(res, 404, "not_found", "api key not found", requestId);
    return json(res, 200, { revoked: true, id: result.rows[0].id }, requestId);
  }

  if (req.method === "GET" && url.pathname === "/v1/stream") {
    return json(res, 426, { error: { code: "upgrade_required", message: "connect with WebSocket in production deployment" } }, requestId);
  }

  return error(res, 404, "not_found", "route not found", requestId);
}

const port = Number(process.env.PORT ?? 8787);

await migrate();

createServer((req, res) => {
  const requestId = req.headers["x-request-id"]?.toString() ?? randomUUID();
  route(req, res, requestId).catch((err) => {
    error(res, 500, "internal_error", String(err?.message ?? err), requestId);
  });
}).listen(port, () => {
  const digest = createHmac("sha256", "trackified").update(String(port)).digest("hex").slice(0, 8);
  console.error(`[tracking-api] listening on http://localhost:${port} (${digest})`);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
