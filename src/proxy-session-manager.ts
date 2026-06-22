import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { redisConnection } from "./queue.ts";

const redis = new Redis(redisConnection());

function carrierKey(carrier: string): string {
  return carrier.toLowerCase().replaceAll("-", "_");
}

function carrierEnvName(prefix: string, carrier: string): string {
  return `${prefix}_${carrier.toUpperCase().replaceAll("-", "_")}`;
}

function numericCarrierEnv(prefix: string, carrier: string, fallback: number): number {
  const carrierValue = process.env[carrierEnvName(prefix, carrier)];
  if (carrierValue != null && carrierValue !== "") return Number(carrierValue);
  const genericValue = process.env[prefix];
  if (genericValue != null && genericValue !== "") return Number(genericValue);
  return fallback;
}

function listEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function activeKey(carrier: string): string {
  return `proxy:session:${carrierKey(carrier)}:active`;
}

function badKey(carrier: string, session: string): string {
  return `proxy:session:${carrierKey(carrier)}:bad:${session}`;
}

function historyKey(carrier: string): string {
  return `proxy:session:${carrierKey(carrier)}:history`;
}

function generatedSession(carrier: string): string {
  const prefix =
    process.env[carrierEnvName("PROXY_SESSION_PREFIX", carrier)] ??
    process.env.PROXY_SESSION_PREFIX ??
    `${carrierKey(carrier)}prod`;
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function configuredProxySessions(carrier: string): string[] {
  const key = carrierEnvName("PROXY_SESSION", carrier);
  const fallbackKey = carrierEnvName("PROXY_SESSION_FALLBACKS", carrier);
  return [
    process.env[key],
    process.env.PROXY_SESSION,
    ...listEnv(fallbackKey),
    ...listEnv("PROXY_SESSION_FALLBACKS"),
  ].filter((value): value is string => Boolean(value));
}

export async function activeProxySession(carrier: string): Promise<string | null> {
  return await redis.get(activeKey(carrier));
}

export async function ensureActiveProxySession(carrier: string): Promise<string> {
  const existing = await activeProxySession(carrier);
  if (existing) return existing;
  const initial = configuredProxySessions(carrier)[0] ?? generatedSession(carrier);
  await redis.set(activeKey(carrier), initial);
  await redis.lpush(historyKey(carrier), JSON.stringify({
    session: initial,
    reason: "initial",
    at: new Date().toISOString(),
  }));
  await redis.ltrim(historyKey(carrier), 0, 49);
  return initial;
}

export async function proxySessionCandidates(carrier: string, attempts: number): Promise<string[]> {
  const active = await ensureActiveProxySession(carrier);
  const configured = configuredProxySessions(carrier);
  const candidates = [...new Set([active, ...configured])];

  while (candidates.length < attempts) {
    candidates.push(generatedSession(carrier));
  }

  const available: string[] = [];
  for (const session of candidates) {
    if (!(await redis.exists(badKey(carrier, session)))) {
      available.push(session);
    }
  }

  if (available.length > 0) return available;
  const rotated = await rotateProxySession(carrier, "all candidates marked bad");
  return [rotated];
}

export async function markProxySessionBad(input: {
  carrier: string;
  session?: string | null;
  reason: string;
}): Promise<string | null> {
  if (!input.session) return null;
  const ttl = numericCarrierEnv("PROXY_SESSION_BAD_TTL_SECONDS", input.carrier, 1800);
  await redis.set(badKey(input.carrier, input.session), input.reason, "EX", ttl);

  const active = await activeProxySession(input.carrier);
  if (active === input.session) {
    return await rotateProxySession(input.carrier, input.reason);
  }
  return active;
}

export async function rotateProxySession(carrier: string, reason: string): Promise<string> {
  const next = generatedSession(carrier);
  await redis.set(activeKey(carrier), next);
  await redis.lpush(historyKey(carrier), JSON.stringify({
    session: next,
    reason,
    at: new Date().toISOString(),
  }));
  await redis.ltrim(historyKey(carrier), 0, 49);
  return next;
}

export async function proxySessionHealth(carrier: string): Promise<{
  active_session: string | null;
  bad_sessions: string[];
  history: Array<{ session?: string; reason?: string; at?: string }>;
}> {
  const active = await activeProxySession(carrier);
  const badKeys = await redis.keys(`proxy:session:${carrierKey(carrier)}:bad:*`);
  const badSessions = badKeys.map((key) => key.split(":").pop() ?? "").filter(Boolean);
  const rawHistory = await redis.lrange(historyKey(carrier), 0, 9);
  return {
    active_session: active,
    bad_sessions: badSessions,
    history: rawHistory.map((row) => {
      try {
        return JSON.parse(row) as { session?: string; reason?: string; at?: string };
      } catch {
        return {};
      }
    }),
  };
}
