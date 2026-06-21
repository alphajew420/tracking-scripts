import { randomUUID } from "node:crypto";
import type { PublicRouteContext } from "./types.ts";
import { detectCarrier } from "../detect.ts";
import { carrierVerification } from "../carriers/verification.ts";
import { sendDiscordWebhook } from "../discord.ts";
import { verifyTurnstile } from "../turnstile.ts";

export async function handlePublicRoutes({ req, res, url, requestId, deps }: PublicRouteContext): Promise<boolean> {
  if (req.method === "OPTIONS") {
    deps.json(res, 204, {}, requestId);
    return true;
  }
  if (url.pathname === "/healthz") {
    deps.json(res, 200, { ok: true }, requestId);
    return true;
  }
  if (url.pathname === "/openapi.json") {
    deps.json(res, 200, openApi(deps.publicApiBaseUrl()), requestId);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/v1/billing/stripe/webhook") {
    const rawBody = await deps.readRawBody(req);
    const signature = Array.isArray(req.headers["stripe-signature"]) ? req.headers["stripe-signature"][0] : req.headers["stripe-signature"];
    if (!deps.verifyStripeSignature(rawBody, signature)) {
      deps.error(res, 400, "bad_signature", "invalid Stripe signature", requestId);
      return true;
    }
    const payload = rawBody ? JSON.parse(rawBody) : {};
    await deps.applyStripeEvent(payload);
    deps.json(res, 200, { received: true }, requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/public/carrier-samples") {
    const body = await deps.readBody(req);
    const trackingNumber = typeof body.tracking_number === "string" ? body.tracking_number.trim() : "";
    const carrierId = typeof body.carrier_id === "string" && body.carrier_id.trim() ? body.carrier_id.trim() : null;
    const carrierName = typeof body.carrier_name === "string" && body.carrier_name.trim() ? body.carrier_name.trim() : null;
    const sourceUrl = typeof body.source_url === "string" && body.source_url.trim() ? body.source_url.trim() : null;
    const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    const powNonce = typeof body.pow_nonce === "string" && body.pow_nonce.trim() ? body.pow_nonce.trim() : null;
    const turnstileToken = typeof body.turnstile_token === "string" && body.turnstile_token.trim() ? body.turnstile_token.trim() : null;
    if (!trackingNumber) {
      deps.error(res, 400, "bad_request", "tracking_number is required", requestId);
      return true;
    }
    if (turnstileToken && !(await verifyTurnstile(turnstileToken, req.socket.remoteAddress ?? undefined))) {
      deps.error(res, 400, "bad_request", "turnstile verification failed", requestId);
      return true;
    }

    const detectedCandidates = detectCarrier(trackingNumber);
    const resolvedCarrierId = carrierId ?? detectedCandidates[0]?.carrier ?? null;
    const validation = resolvedCarrierId ? carrierVerification(resolvedCarrierId) : null;
    const sampleId = `smp_${randomUUID().replaceAll("-", "")}`;
    const turnstileVerified = turnstileToken ? true : null;
    const discordMessage = [
      "Carrier sample submitted",
      `Carrier: ${resolvedCarrierId ?? "unknown"}`,
      `Tracking: ${trackingNumber}`,
      `Validation: ${validation?.status ?? "unvalidated"}`,
      sourceUrl ? `Source: ${sourceUrl}` : null,
      notes ? `Notes: ${notes}` : null,
    ].filter(Boolean).join(" | ");

    const discordNotified = await sendDiscordWebhook(discordMessage);

    await deps.query(
      `insert into carrier_samples
       (id, carrier_id, carrier_name, tracking_number, source_url, notes, detected_candidates, validation_status, turnstile_verified, pow_nonce, discord_notified, created_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, now())`,
      [
        sampleId,
        resolvedCarrierId,
        carrierName,
        trackingNumber,
        sourceUrl,
        notes,
        JSON.stringify(detectedCandidates),
        validation?.status ?? "unvalidated",
        turnstileVerified,
        powNonce,
        discordNotified,
      ],
    );

    deps.json(res, 201, {
      accepted: true,
      carrier_id: resolvedCarrierId,
      detected_candidates: detectedCandidates,
      validation: validation ?? { carrier: carrierId ?? resolvedCarrierId ?? "unknown", status: "unvalidated" },
      discord_notified: discordNotified,
      turnstile_verified: turnstileVerified,
      sample_id: sampleId,
    }, requestId);
    return true;
  }

  const publicTrackingMatch = /^\/public\/trackings\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && publicTrackingMatch) {
    const result = await deps.query(
      `select t.id, t.tracking_number, t.carrier, t.status, t.delivered_at, t.estimated_delivery,
              t.events, t.service_level, t.exception, t.last_scraped_at, t.created_at, t.updated_at,
              w.brand_name, w.accent_color, w.support_url, w.pii_public
       from trackings t
       left join white_label_settings w on w.account_id = t.account_id
       where t.id = $1 and t.stopped_at is null`,
      [publicTrackingMatch[1]],
    );
    const row = result.rows[0];
    if (!row) {
      deps.error(res, 404, "not_found", "tracking not found", requestId);
      return true;
    }
    deps.json(res, 200, {
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
    return true;
  }

  if (!url.pathname.startsWith("/v1/")) return false;

  if (req.method === "POST" && url.pathname === "/v1/auth/signup") {
    const body = await deps.readBody(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const company = typeof body.company === "string" && body.company.trim() ? body.company.trim() : "New workspace";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    if (!email || !email.includes("@")) {
      deps.error(res, 400, "bad_request", "valid email is required", requestId);
      return true;
    }
    if (password.length < 8) {
      deps.error(res, 400, "bad_request", "password must be at least 8 characters", requestId);
      return true;
    }
    const accountId = `acct_${randomUUID().replaceAll("-", "")}`;
    const userId = `usr_${randomUUID().replaceAll("-", "")}`;
    try {
      await deps.query("begin");
      await deps.query(`insert into accounts (id, name) values ($1, $2)`, [accountId, company]);
      const userResult = await deps.query<{ id: string; account_id: string; email: string; name: string | null; password_hash: string }>(
        `insert into users (id, account_id, email, name, password_hash)
         values ($1, $2, $3, $4, $5)
         returning *`,
        [userId, accountId, email, name, deps.passwordHash(password)],
      );
      await deps.query("commit");
      const user = { ...userResult.rows[0]!, account_name: company };
      const verificationToken = await deps.sendVerificationEmail(user);
      await deps.createSession(res, user);
      deps.json(res, 201, { user: deps.publicUser(user), verification_token: verificationToken }, requestId);
      return true;
    } catch (err) {
      await deps.query("rollback").catch(() => undefined);
      if (String((err as Error).message).includes("duplicate key")) {
        deps.error(res, 409, "conflict", "email is already registered", requestId);
        return true;
      }
      throw err;
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/login") {
    const body = await deps.readBody(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const result = await deps.query<{ id: string; account_id: string; email: string; name: string | null; password_hash: string; account_name?: string }>(
      `select u.*, a.name as account_name
       from users u
       join accounts a on a.id = u.account_id
       where u.email = $1`,
      [email],
    );
    const user = result.rows[0];
    if (!user || !deps.verifyPassword(password, user.password_hash)) {
      deps.error(res, 401, "unauthorized", "invalid email or password", requestId);
      return true;
    }
    await deps.createSession(res, user);
    deps.json(res, 200, { user: deps.publicUser(user) }, requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/password-reset/request") {
    const body = await deps.readBody(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const userResult = await deps.query<{ id: string; account_id: string; email: string; name: string | null; password_hash: string }>(`select * from users where email = $1`, [email]);
    const user = userResult.rows[0];
    if (!user) {
      deps.json(res, 200, { requested: true }, requestId);
      return true;
    }
    const token = await deps.sendPasswordResetEmail(user);
    deps.json(res, 200, { requested: true, token: deps.publicToken(token) }, requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/password-reset/confirm") {
    const body = await deps.readBody(req);
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8) {
      deps.error(res, 400, "bad_request", "password must be at least 8 characters", requestId);
      return true;
    }
    const tokenResult = await deps.query<{ id: string; user_id: string }>(
      `select id, user_id from user_tokens
       where token_hash = $1 and kind = 'password_reset' and used_at is null and expires_at > now()`,
      [deps.tokenHash(token)],
    );
    const row = tokenResult.rows[0];
    if (!row) {
      deps.error(res, 400, "bad_request", "invalid or expired reset token", requestId);
      return true;
    }
    await deps.query(`update users set password_hash = $2, updated_at = now() where id = $1`, [row.user_id, deps.passwordHash(password)]);
    await deps.query(`update user_tokens set used_at = now() where id = $1`, [row.id]);
    await deps.query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [row.user_id]);
    deps.json(res, 200, { reset: true }, requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/email-verification/confirm") {
    const body = await deps.readBody(req);
    const token = typeof body.token === "string" ? body.token : "";
    const tokenResult = await deps.query<{ id: string; user_id: string }>(
      `select id, user_id from user_tokens
       where token_hash = $1 and kind = 'email_verify' and used_at is null and expires_at > now()`,
      [deps.tokenHash(token)],
    );
    const row = tokenResult.rows[0];
    if (!row) {
      deps.error(res, 400, "bad_request", "invalid or expired verification token", requestId);
      return true;
    }
    await deps.query(`update users set email_verified_at = now(), updated_at = now() where id = $1`, [row.user_id]);
    await deps.query(`update user_tokens set used_at = now() where id = $1`, [row.id]);
    deps.json(res, 200, { verified: true }, requestId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/account/team/invites/accept") {
    const body = await deps.readBody(req);
    const token = typeof body.token === "string" ? body.token : "";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8) {
      deps.error(res, 400, "bad_request", "password must be at least 8 characters", requestId);
      return true;
    }
    const inviteResult = await deps.query<{ id: string; account_id: string; email: string }>(
      `select id, account_id, email from team_invites
       where token_hash = $1 and accepted_at is null and expires_at > now()`,
      [deps.tokenHash(token)],
    );
    const invite = inviteResult.rows[0];
    if (!invite) {
      deps.error(res, 400, "bad_request", "invalid or expired invite", requestId);
      return true;
    }
    const userId = `usr_${randomUUID().replaceAll("-", "")}`;
    const userResult = await deps.query<{ id: string; account_id: string; email: string; name: string | null; password_hash: string }>(
      `insert into users (id, account_id, email, name, password_hash)
       values ($1, $2, $3, $4, $5)
       on conflict (email) do update set account_id = excluded.account_id, password_hash = excluded.password_hash, name = coalesce(excluded.name, users.name), updated_at = now()
       returning *`,
      [userId, invite.account_id, invite.email, name, deps.passwordHash(password)],
    );
    await deps.query(`update team_invites set accepted_at = now() where id = $1`, [invite.id]);
    await deps.createSession(res, userResult.rows[0]!);
    deps.json(res, 200, { user: deps.publicUser(userResult.rows[0]!) }, requestId);
    return true;
  }

  const ctx = await deps.auth(req);
  if (!ctx) {
    deps.error(res, 401, "unauthorized", "missing or invalid API key", requestId);
    return true;
  }
  const rateLimit = await deps.assertRateLimit(ctx);
  if (!rateLimit.ok) {
    res.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
    deps.error(res, 429, "rate_limited", `rate limit exceeded (${rateLimit.limit}/min)`, requestId);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/auth/me") {
    const user = await deps.currentUser(ctx);
    deps.json(res, 200, { authenticated: Boolean(user), user, account_id: ctx.accountId }, requestId);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
    const sessionToken = deps.parseCookies(req).trackified_session;
    if (sessionToken) {
      await deps.query(`update sessions set revoked_at = now() where token_hash = $1`, [deps.tokenHash(sessionToken)]);
    }
    res.setHeader("set-cookie", deps.sessionCookie("", 0));
    deps.json(res, 200, { logged_out: true }, requestId);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/v1/auth/email-verification/request") {
    const user = await deps.currentUser(ctx);
    if (!user) {
      deps.error(res, 400, "bad_request", "dashboard session required", requestId);
      return true;
    }
    const fullUser = await deps.query<{ id: string; account_id: string; email: string; name: string | null; password_hash: string }>(`select * from users where id = $1 and account_id = $2`, [user.id, ctx.accountId]);
    const token = fullUser.rows[0] ? await deps.sendVerificationEmail(fullUser.rows[0]!) : undefined;
    deps.json(res, 200, { requested: true, token }, requestId);
    return true;
  }

  return false;
}

function openApi(serverUrl: string) {
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
    servers: [{ url: serverUrl }, { url: "http://localhost:8788" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/auth/signup": { post: { summary: "Create an account and dashboard session", security: [], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SignupRequest" } } } }, responses: { "201": created({ $ref: "#/components/schemas/AuthResponse" }), "409": errorResponse } } },
      "/v1/auth/login": { post: { summary: "Create a dashboard session", security: [], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } } }, responses: { "200": ok({ $ref: "#/components/schemas/AuthResponse" }), "401": errorResponse } } },
      "/v1/auth/me": { get: { summary: "Get current dashboard user", responses: { "200": ok({ $ref: "#/components/schemas/MeResponse" }), "401": errorResponse } } },
      "/v1/auth/logout": { post: { summary: "Revoke dashboard session", responses: { "200": ok({ type: "object", properties: { logged_out: { type: "boolean" } } }) } } },
      "/v1/auth/password-reset/request": { post: { summary: "Request password reset", security: [], responses: { "200": ok({ type: "object", properties: { requested: { type: "boolean" } } }) } } },
      "/v1/auth/password-reset/confirm": { post: { summary: "Confirm password reset", security: [], responses: { "200": ok({ type: "object", properties: { reset: { type: "boolean" } } }), "400": errorResponse } } },
      "/v1/auth/email-verification/request": { post: { summary: "Request email verification", responses: { "200": ok({ type: "object", properties: { requested: { type: "boolean" } } }) } } },
      "/v1/auth/email-verification/confirm": { post: { summary: "Confirm email verification", security: [], responses: { "200": ok({ type: "object", properties: { verified: { type: "boolean" } } }), "400": errorResponse } } },
      "/v1/billing/stripe/webhook": { post: { summary: "Receive Stripe billing events", security: [], responses: { "200": ok({ type: "object", properties: { received: { type: "boolean" } } }), "400": errorResponse } } },
      "/v1/public/carrier-samples": { post: { summary: "Submit a real carrier sample for validation", security: [], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CarrierSampleRequest" } } } }, responses: { "201": created({ $ref: "#/components/schemas/CarrierSampleResponse" }), "400": errorResponse } } },
      "/v1/carriers/status": { get: { summary: "Carrier validation summary", responses: { "200": ok({ $ref: "#/components/schemas/CarrierStatusSummary" }) } } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      parameters: {},
      schemas: {
        SignupRequest: { type: "object", required: ["company", "email", "password"], properties: { company: { type: "string" }, name: { type: "string" }, email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } },
        LoginRequest: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string" } } },
        CarrierSampleRequest: {
          type: "object",
          required: ["tracking_number"],
          properties: {
            carrier_id: { type: "string" },
            carrier_name: { type: "string" },
            tracking_number: { type: "string" },
            source_url: { type: "string" },
            notes: { type: "string" },
            pow_nonce: { type: "string" },
            turnstile_token: { type: "string" },
          },
        },
        CarrierSampleResponse: {
          type: "object",
          properties: {
            accepted: { type: "boolean" },
            carrier_id: { type: ["string", "null"] },
            detected_candidates: { type: "array", items: { type: "object" } },
            validation: { type: "object" },
            discord_notified: { type: "boolean" },
            turnstile_verified: { type: ["boolean", "null"] },
            sample_id: { type: "string" },
          },
        },
        CarrierStatusSummary: {
          type: "object",
          properties: {
            counts: {
              type: "object",
              properties: {
                verified: { type: "number" },
                needs_retest: { type: "number" },
                needs_real_sample: { type: "number" },
                unvalidated: { type: "number" },
              },
            },
            values: { type: "array", items: { type: "object" } },
          },
        },
        DashboardUser: { type: "object", properties: { id: { type: "string" }, account_id: { type: "string" }, account_name: { type: ["string", "null"] }, email: { type: "string", format: "email" }, name: { type: ["string", "null"] } } },
        AuthResponse: { type: "object", properties: { user: { $ref: "#/components/schemas/DashboardUser" } } },
        MeResponse: { type: "object", properties: { authenticated: { type: "boolean" }, user: { anyOf: [{ $ref: "#/components/schemas/DashboardUser" }, { type: "null" }] }, account_id: { type: "string" } } },
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, request_id: { type: "string" } } } } },
      },
    },
  };
}
