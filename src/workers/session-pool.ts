import { TrackingSession, type Carrier } from "../session.ts";
import { createConfigCarrier, listCarrierConfigIds } from "../config/adapter.ts";
import { dhlCarrier } from "../carriers/dhl.ts";
import { dhlExpressCarrier } from "../carriers/dhl-express.ts";
import { fedexCarrier } from "../carriers/fedex.ts";
import { upsCarrier } from "../carriers/ups.ts";
import { uspsCarrier } from "../carriers/usps.ts";
import { proxyForCarrier } from "../proxy.ts";

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

export class SessionPool {
  private sessions = new Map<string, PooledSession>();

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
      channel: carrierId === "ups" || carrierId === "fedex" ? "chrome" : undefined,
      headless: process.env.HEADLESS !== "false",
      debug: process.env.DEBUG_SCRAPES === "1",
      proxy: proxyForCarrier(carrierId),
      proxyMode:
        process.env[`PROXY_${carrierId.toUpperCase().replaceAll("-", "_")}_MODE`] === "extension" ||
        process.env.PROXY_MODE === "extension"
          ? "extension"
          : "native",
      userAgent: carrierId === "fedex" ? null : undefined,
      disableBlocking: carrierId === "fedex",
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
