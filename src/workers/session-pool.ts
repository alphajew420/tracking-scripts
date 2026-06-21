import { TrackingSession, type Carrier } from "../session.ts";
import { getCarrierFactory } from "../carriers/registry.ts";
import { proxyForCarrier } from "../proxy.ts";
import type { ScrapeResult } from "../types.ts";
import { buildCarrierSessionOptions } from "../carrier-runtime.ts";
import { getBrowserSidecarEndpoint, invalidateBrowserSidecar } from "../browser-sidecar.ts";
import type { BrowserProxy } from "../proxy.ts";

interface PooledSession {
  session: TrackingSession;
  createdAt: number;
  uses: number;
  proxy?: BrowserProxy;
}

const maxAgeMs = Number(process.env.SESSION_MAX_AGE_MS ?? 60 * 60_000);
const maxUses = Number(process.env.SESSION_MAX_USES ?? 250);

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function maxUsesForCarrier(carrierId: string): number {
  const envName = `SESSION_MAX_USES_${carrierId.toUpperCase().replaceAll("-", "_")}`;
  const override = process.env[envName];
  if (override != null && override !== "") return Number(override);

  return maxUses;
}

function proxySessionForCarrier(carrierId: string): string {
  const carrierKey = carrierId.toUpperCase().replaceAll("-", "_");
  const fixed = process.env[`PROXY_SESSION_${carrierKey}`] ?? process.env.PROXY_SESSION;
  if (fixed) return fixed;
  if (carrierId === "fedex") return `${carrierId}-${process.pid}-${Date.now().toString(36)}`;
  return carrierId;
}

export class SessionPool {
  private sessions = new Map<string, PooledSession>();
  private locks = new Map<string, Promise<unknown>>();

  async get(carrierId: string): Promise<TrackingSession> {
    const existing = this.sessions.get(carrierId);
    const carrierMaxUses = maxUsesForCarrier(carrierId);
    if (existing && Date.now() - existing.createdAt < maxAgeMs && existing.uses < carrierMaxUses) {
      existing.uses += 1;
      return existing.session;
    }
    if (existing) {
      this.sessions.delete(carrierId);
      await existing.session.close();
      await invalidateBrowserSidecar(carrierId, existing.proxy);
    }

    const factory = getCarrierFactory(carrierId);
    if (!factory) throw new Error(`unsupported carrier: ${carrierId}`);
    const useProxy = carrierId !== "fedex" || booleanEnv("FEDEX_USE_PROXY", false);
    const proxy = useProxy ? proxyForCarrier(carrierId, { session: proxySessionForCarrier(carrierId) }) : undefined;
    const browserCdpEndpoint =
      carrierId === "fedex" ? await getBrowserSidecarEndpoint(carrierId, proxy) : undefined;
    const session = new TrackingSession(
      factory(),
      buildCarrierSessionOptions(carrierId, {
        headless:
          carrierId === "purolator"
            ? booleanEnv("PUROLATOR_HEADLESS", false)
            : process.env.HEADLESS !== "false",
        debug: process.env.DEBUG_SCRAPES === "1",
        proxy,
        cdpEndpoint: browserCdpEndpoint,
        persistentProfileDir:
          carrierId === "fedex"
            ? process.env.FEDEX_PROFILE_DIR ?? "/tmp/trackified-fedex-profile"
            : carrierId === "royal-mail"
              ? process.env.ROYAL_MAIL_PROFILE_DIR ?? "/tmp/trackified-royal-mail-profile"
              : carrierId === "postnord-se" || carrierId === "postnord-dk"
                ? process.env.POSTNORD_PROFILE_DIR ?? "/tmp/trackified-postnord-profile"
                : undefined,
      }),
    );
    this.sessions.set(carrierId, { session, createdAt: Date.now(), uses: 1, proxy });
    return session;
  }

  async track(carrierId: string, trackingNumber: string): Promise<ScrapeResult> {
    return this.withCarrierLock(carrierId, async () => {
      const session = await this.get(carrierId);
      const result = await session.track(trackingNumber);
      if (!result.ok && /Target page|context or browser|Browser has been closed/i.test(result.error ?? "")) {
        await this.invalidate(carrierId);
      }
      if (!result.ok && shouldRetryFedExWithCleanPage(carrierId, result)) {
        await this.invalidate(carrierId);
        const cleanPageSession = await this.get(carrierId);
        const cleanPageResult = await cleanPageSession.track(trackingNumber);
        if (cleanPageResult.ok || !shouldRetryFedExWithCleanPage(carrierId, cleanPageResult)) {
          return cleanPageResult;
        }

        await this.invalidate(carrierId);
        await this.invalidateSidecar(carrierId);
        const freshSidecarSession = await this.get(carrierId);
        return await freshSidecarSession.track(trackingNumber);
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
    await invalidateBrowserSidecar(carrierId, existing.proxy);
  }

  private async invalidateSidecar(carrierId: string): Promise<void> {
    const existing = this.sessions.get(carrierId);
    await invalidateBrowserSidecar(carrierId, existing?.proxy);
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.sessions.values()).map((entry) => entry.session.close()));
    this.sessions.clear();
  }
}

function shouldRetryFedExWithCleanPage(carrierId: string, result: ScrapeResult): boolean {
  if (carrierId !== "fedex") return false;
  return /tracking number not found|no results found|rendered tracking data not available|system-error/i.test(
    result.error ?? "",
  );
}
