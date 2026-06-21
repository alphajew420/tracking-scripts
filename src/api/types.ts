import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { QueryResult, QueryResultRow } from "pg";
import type { WebhookEventType } from "../webhooks.ts";

export interface AuthContext {
  accountId: string;
  apiKeyId: string | null;
  userId: string | null;
  mode: "live" | "test";
  scopes: string[];
}

export interface ApiRouteDeps {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  readRawBody(req: IncomingMessage): Promise<string>;
  json(res: ServerResponse, status: number, body: unknown, requestId: string): void;
  error(res: ServerResponse, status: number, code: string, message: string, requestId: string): void;
  auth(req: IncomingMessage): Promise<AuthContext | null>;
  assertRateLimit(ctx: AuthContext): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number; limit: number }>;
  verifyStripeSignature(rawBody: string, header: string | undefined): boolean;
  applyStripeEvent(payload: Record<string, unknown>): Promise<void>;
  createSession(res: ServerResponse, user: { id: string; account_id: string; email: string; name: string | null; account_name?: string }): Promise<void>;
  sessionCookie(token: string, maxAgeSeconds: number): string;
  tokenHash(token: string): string;
  passwordHash(password: string): string;
  verifyPassword(password: string, encoded: string): boolean;
  parseCookies(req: IncomingMessage): Record<string, string>;
  publicCarrierCatalog(): unknown[];
  detectCarrier(number: string): unknown[];
  listTrackingsForAccount(url: URL, ctx: AuthContext): Promise<unknown>;
  insertTracking(input: Record<string, unknown>, ctx: AuthContext): Promise<unknown>;
  getTracking(id: string, ctx: AuthContext): Promise<unknown | null>;
  assertTrackingQuota(ctx: AuthContext, additional: number): Promise<{ ok: true } | { ok: false; used: number; limit: number }>;
  enqueueWebhookEvent(accountId: string, eventType: WebhookEventType, payload: unknown): Promise<void>;
  enqueueScrape(input: { tracking_id: string; carrier: string | null; tracking_number: string; reason: string }): Promise<void>;
  publicWebhook(record: unknown): unknown;
  getWhiteLabel(ctx: AuthContext): Promise<unknown>;
  updateWhiteLabel(ctx: AuthContext, input: Record<string, unknown>): Promise<unknown>;
  listApiKeys(url: URL, ctx: AuthContext): Promise<unknown>;
  makeApiKey(input: Record<string, unknown>, ctx: AuthContext): Promise<unknown>;
  accountPlan(accountId: string): Promise<{ id: string; name: string; plan_tier: string; monthly_tracking_limit: number; rate_limit_per_minute: number; bulk_limit: number; realtime_ws: boolean; overage_usd_per_tracking: string; stripe_customer_id: string | null }>;
  stripePriceForTier(tier: string): string | undefined;
  stripeRequest(path: string, params: Record<string, string>): Promise<Record<string, unknown>>;
  validWebhookUrl(value: string): boolean;
  signWebhookBody(body: string, secret: string): string;
  publicToken(token?: string): string | undefined;
  publicApiBaseUrl(): string;
  appUrl(path: string): string;
  sendEmail(input: { accountId: string; to: string; subject: string; body: string }): Promise<void>;
  currentUser(ctx: AuthContext): Promise<{ id: string; account_id: string; account_name?: string | null; email: string; name: string | null } | null>;
  publicUser(row: { id: string; account_id: string; account_name?: string | null; email: string; name: string | null }): {
    id: string;
    account_id: string;
    account_name: string | null;
    email: string;
    name: string | null;
  };
  sendVerificationEmail(user: { id: string; account_id: string; email: string; name: string | null; account_name?: string }): Promise<string | undefined>;
  sendPasswordResetEmail(user: { id: string; account_id: string; email: string; name: string | null; account_name?: string }): Promise<string | undefined>;
}

export interface ApiRouteBaseContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  requestId: string;
  deps: ApiRouteDeps;
}

export interface ApiRouteContext extends ApiRouteBaseContext {
  auth: AuthContext;
}

export interface PublicRouteContext extends ApiRouteBaseContext {
}
