import { createHash } from "node:crypto";
import Redis from "ioredis";
import { redisConnection } from "./queue.ts";
import type { BrowserProxy } from "./proxy.ts";

const redis = new Redis(redisConnection());

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

export function proxyFingerprint(proxy: BrowserProxy | undefined): string | null {
  if (!proxy) return null;
  return createHash("sha256")
    .update(`${proxy.server}|${proxy.username ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

export async function recordProxyHealth(input: {
  carrier: string;
  proxy?: BrowserProxy;
  ok: boolean;
  elapsedMs: number;
  error?: string;
}): Promise<void> {
  const fingerprint = proxyFingerprint(input.proxy);
  if (!fingerprint) return;
  const key = `proxy:health:${input.carrier}:${fingerprint}`;
  const now = new Date().toISOString();
  await redis
    .multi()
    .hset(key, {
      carrier: input.carrier,
      fingerprint,
      ok: input.ok ? "1" : "0",
      elapsed_ms: String(input.elapsedMs),
      error: input.error ?? "",
      updated_at: now,
    })
    .expire(key, numericCarrierEnv("PROXY_HEALTH_TTL_SECONDS", input.carrier, 86_400))
    .exec();
}

export async function quarantineProxy(input: {
  carrier: string;
  proxy?: BrowserProxy;
  reason: string;
}): Promise<void> {
  const fingerprint = proxyFingerprint(input.proxy);
  if (!fingerprint) return;
  await redis.set(
    `proxy:quarantine:${input.carrier}:${fingerprint}`,
    input.reason,
    "EX",
    numericCarrierEnv("PROXY_QUARANTINE_SECONDS", input.carrier, 1800),
  );
}

export async function proxyIsQuarantined(carrier: string, proxy?: BrowserProxy): Promise<boolean> {
  const fingerprint = proxyFingerprint(proxy);
  if (!fingerprint) return false;
  return Boolean(await redis.exists(`proxy:quarantine:${carrier}:${fingerprint}`));
}
