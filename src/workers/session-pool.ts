import { TrackingSession, type Carrier } from "../session.ts";
import { getCarrierFactory } from "../carriers/registry.ts";
import { proxyForCarrier } from "../proxy.ts";
import type { ScrapeResult } from "../types.ts";
import { buildCarrierSessionOptions } from "../carrier-runtime.ts";
import { getBrowserSidecarEndpoint, invalidateBrowserSidecar } from "../browser-sidecar.ts";
import type { BrowserProxy } from "../proxy.ts";
import { proxyIsQuarantined, quarantineProxy, recordProxyHealth } from "../proxy-health.ts";

interface PooledSession {
  session: TrackingSession;
  createdAt: number;
  uses: number;
  proxy?: BrowserProxy;
}

const maxAgeMs = Number(process.env.SESSION_MAX_AGE_MS ?? 60 * 60_000);
const maxUses = Number(process.env.SESSION_MAX_USES ?? 250);
let generatedProxySessionCounter = 0;

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

function numericCarrierEnv(prefix: string, carrierId: string, fallback: number): number {
  const carrierKey = carrierId.toUpperCase().replaceAll("-", "_");
  const carrierValue = process.env[`${prefix}_${carrierKey}`];
  if (carrierValue != null && carrierValue !== "") return Number(carrierValue);
  const genericValue = process.env[prefix];
  if (genericValue != null && genericValue !== "") return Number(genericValue);
  return fallback;
}

function proxySessionForCarrier(carrierId: string): string {
  const carrierKey = carrierId.toUpperCase().replaceAll("-", "_");
  const fixed = process.env[`PROXY_SESSION_${carrierKey}`] ?? process.env.PROXY_SESSION;
  if (fixed) return fixed;
  if (carrierId === "fedex") {
    generatedProxySessionCounter += 1;
    return `${carrierId}-${process.pid}-${Date.now().toString(36)}-${generatedProxySessionCounter}`;
  }
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
    let proxy: BrowserProxy | undefined;
    if (useProxy) {
      const maxProxyPickAttempts = numericCarrierEnv("PROXY_PICK_ATTEMPTS", carrierId, 5);
      for (let attempt = 0; attempt < maxProxyPickAttempts; attempt += 1) {
        const candidate = proxyForCarrier(carrierId, { session: proxySessionForCarrier(carrierId) });
        if (!candidate || !(await proxyIsQuarantined(carrierId, candidate))) {
          proxy = candidate;
          break;
        }
      }
      proxy ??= proxyForCarrier(carrierId, { session: proxySessionForCarrier(carrierId) });
    }
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
      const startedAt = Date.now();
      const result = await session.track(trackingNumber);
      const pooled = this.sessions.get(carrierId);
      await recordProxyHealth({
        carrier: carrierId,
        proxy: pooled?.proxy,
        ok: result.ok,
        elapsedMs: Date.now() - startedAt,
        error: result.ok ? undefined : result.error,
      });
      if (!result.ok && /Target page|context or browser|Browser has been closed/i.test(result.error ?? "")) {
        await quarantineProxy({ carrier: carrierId, proxy: pooled?.proxy, reason: result.error ?? "browser failure" });
        await this.invalidate(carrierId);
      }
      if (!result.ok && shouldRetryFedExWithCleanPage(carrierId, result)) {
        await quarantineProxy({ carrier: carrierId, proxy: pooled?.proxy, reason: result.error ?? "fedex retryable failure" });
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
