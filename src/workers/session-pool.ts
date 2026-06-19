import { TrackingSession, type Carrier } from "../session.ts";
import { createConfigCarrier, listCarrierConfigIds } from "../config/adapter.ts";
import { dhlCarrier } from "../carriers/dhl.ts";
import { dhlExpressCarrier } from "../carriers/dhl-express.ts";
import { fedexCarrier } from "../carriers/fedex.ts";
import { upsCarrier } from "../carriers/ups.ts";
import { uspsCarrier } from "../carriers/usps.ts";
import { proxyForCarrier } from "../proxy.ts";
import type { ScrapeResult } from "../types.ts";

const handCoded: Record<string, () => Carrier> = {
  dhl: () => dhlCarrier,
  "dhl-express": () => dhlExpressCarrier,
  fedex: () => fedexCarrier,
  ups: () => upsCarrier,
  usps: () => uspsCarrier,
};

for (const id of listCarrierConfigIds()) {
  handCoded[id] ??= () => createConfigCarrier(id);
}

interface PooledSession {
  session: TrackingSession;
  createdAt: number;
  uses: number;
}

const maxAgeMs = Number(process.env.SESSION_MAX_AGE_MS ?? 60 * 60_000);
const maxUses = Number(process.env.SESSION_MAX_USES ?? 250);

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function browserChannel(carrierId: string): "chrome" | "msedge" | undefined {
  const key = `BROWSER_CHANNEL_${carrierId.toUpperCase().replaceAll("-", "_")}`;
  const value = process.env[key] ?? process.env.BROWSER_CHANNEL;
  if (value === "chrome" || value === "msedge") return value;
  if (value === "bundled" || value === "chromium" || value === "") return undefined;
  return carrierId === "ups" || carrierId === "fedex" ? "chrome" : undefined;
}

export class SessionPool {
  private sessions = new Map<string, PooledSession>();
  private locks = new Map<string, Promise<unknown>>();

  async get(carrierId: string): Promise<TrackingSession> {
    const existing = this.sessions.get(carrierId);
    if (existing && Date.now() - existing.createdAt < maxAgeMs && existing.uses < maxUses) {
      existing.uses += 1;
      return existing.session;
    }
    if (existing) await existing.session.close();

    const factory = handCoded[carrierId];
    if (!factory) throw new Error(`unsupported carrier: ${carrierId}`);
    const session = new TrackingSession(factory(), {
      channel: browserChannel(carrierId),
      headless: process.env.HEADLESS !== "false",
      debug: process.env.DEBUG_SCRAPES === "1",
      proxy: proxyForCarrier(carrierId),
      proxyMode:
        process.env[`PROXY_${carrierId.toUpperCase().replaceAll("-", "_")}_MODE`] === "extension" ||
        process.env.PROXY_MODE === "extension"
          ? "extension"
          : "native",
      userAgent: carrierId === "fedex" || carrierId === "dhl" ? null : undefined,
      disableBlocking:
        carrierId === "fedex"
          ? booleanEnv("FEDEX_DISABLE_BLOCKING", false)
          : booleanEnv(`DISABLE_BLOCKING_${carrierId.toUpperCase().replaceAll("-", "_")}`, false),
      warmTimeoutMs:
        carrierId === "fedex"
          ? Number(process.env.FEDEX_WARM_TIMEOUT_MS ?? 180000)
          : undefined,
      warmWaitUntil: carrierId === "fedex" ? "domcontentloaded" : undefined,
      persistentProfileDir:
        carrierId === "fedex"
          ? process.env.FEDEX_PROFILE_DIR ?? "/tmp/trackified-fedex-profile"
          : undefined,
    });
    this.sessions.set(carrierId, { session, createdAt: Date.now(), uses: 1 });
    return session;
  }

  async track(carrierId: string, trackingNumber: string): Promise<ScrapeResult> {
    return this.withCarrierLock(carrierId, async () => {
      const session = await this.get(carrierId);
      const result = await session.track(trackingNumber);
      if (!result.ok && /Target page|context or browser|Browser has been closed/i.test(result.error ?? "")) {
        await this.invalidate(carrierId);
      }
      return result;
    });
  }

  private async withCarrierLock<T>(carrierId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(carrierId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.locks.set(carrierId, chain);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(carrierId) === chain) this.locks.delete(carrierId);
    }
  }

  async invalidate(carrierId: string): Promise<void> {
    const existing = this.sessions.get(carrierId);
    if (!existing) return;
    this.sessions.delete(carrierId);
    await existing.session.close();
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.sessions.values()).map((entry) => entry.session.close()));
    this.sessions.clear();
  }
}
