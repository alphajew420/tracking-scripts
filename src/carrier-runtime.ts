import type { BrowserProxy } from "./proxy.ts";
import type { SessionOptions } from "./session.ts";

interface CarrierSessionOverrides {
  headless?: boolean;
  debug?: boolean;
  proxy?: BrowserProxy;
  proxyMode?: "native" | "extension" | "forwarder";
  cdpEndpoint?: string;
  launchArgs?: string[];
  persistentProfileDir?: string;
  userAgent?: string | null;
  disableBlocking?: boolean;
  warmTimeoutMs?: number;
  warmWaitUntil?: SessionOptions["warmWaitUntil"];
  channel?: SessionOptions["channel"];
  fingerprintProfile?: SessionOptions["fingerprintProfile"];
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function carrierEnvName(prefix: string, carrier: string): string {
  return `${prefix}_${carrier.toUpperCase().replaceAll("-", "_")}`;
}

function browserChannel(carrierId: string): SessionOptions["channel"] {
  const key = carrierEnvName("BROWSER_CHANNEL", carrierId);
  const value = process.env[key] ?? process.env.BROWSER_CHANNEL;
  if (value === "chrome" || value === "msedge") return value;
  if (value === "bundled" || value === "chromium" || value === "") return undefined;
  return carrierId === "ups" ||
    carrierId === "fedex" ||
    carrierId === "purolator" ||
    carrierId === "royal-mail" ||
    carrierId === "postnord-se" ||
    carrierId === "postnord-dk"
    ? "chrome"
    : undefined;
}

function prefersExtensionProxy(carrierId: string): boolean {
  return (
    carrierId === "royal-mail" ||
    carrierId === "postnord-se" ||
    carrierId === "postnord-dk"
  );
}

function cdpEndpointForCarrier(carrierId: string): string | undefined {
  return process.env[carrierEnvName("BROWSER_CDP_ENDPOINT", carrierId)] ?? process.env.BROWSER_CDP_ENDPOINT;
}

function launchArgsForCarrier(carrierId: string): string[] {
  const raw = process.env[carrierEnvName("BROWSER_EXTRA_ARGS", carrierId)] ?? process.env.BROWSER_EXTRA_ARGS;
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function defaultDisableBlocking(carrierId: string): boolean {
  if (carrierId === "fedex") return booleanEnv("FEDEX_DISABLE_BLOCKING", false);
  if (carrierId === "purolator" || carrierId === "royal-mail") return true;
  if (carrierId === "postnord-se" || carrierId === "postnord-dk") return true;
  return booleanEnv(`DISABLE_BLOCKING_${carrierId.toUpperCase().replaceAll("-", "_")}`, false);
}

function defaultWarmTimeoutMs(carrierId: string): number | undefined {
  if (carrierId === "fedex") return Number(process.env.FEDEX_WARM_TIMEOUT_MS ?? 180000);
  if (carrierId === "purolator") return Number(process.env.PUROLATOR_WARM_TIMEOUT_MS ?? 120000);
  if (carrierId === "royal-mail") return Number(process.env.ROYAL_MAIL_WARM_TIMEOUT_MS ?? 90000);
  if (carrierId === "postnord-se" || carrierId === "postnord-dk") {
    return Number(process.env.POSTNORD_WARM_TIMEOUT_MS ?? 90000);
  }
  return undefined;
}

function defaultPersistentProfileDir(carrierId: string): string | undefined {
  if (carrierId === "fedex") return process.env.FEDEX_PROFILE_DIR ?? ".browser-profiles/fedex";
  if (carrierId === "royal-mail") return process.env.ROYAL_MAIL_PROFILE_DIR ?? ".browser-profiles/royal-mail";
  if (carrierId === "postnord-se" || carrierId === "postnord-dk") {
    return process.env.POSTNORD_PROFILE_DIR ?? ".browser-profiles/postnord";
  }
  return undefined;
}

export function buildCarrierSessionOptions(carrierId: string, overrides: CarrierSessionOverrides = {}): SessionOptions {
  const proxy = overrides.proxy;
  const proxyMode =
    overrides.proxyMode ??
    (process.env[`PROXY_${carrierId.toUpperCase().replaceAll("-", "_")}_MODE`] === "forwarder" ||
    process.env.PROXY_MODE === "forwarder"
      ? "forwarder"
      : process.env[`PROXY_${carrierId.toUpperCase().replaceAll("-", "_")}_MODE`] === "extension" ||
    process.env.PROXY_MODE === "extension" ||
    (proxy && prefersExtensionProxy(carrierId))
      ? "extension"
      : "native");

  return {
    headless: overrides.headless,
    debug: overrides.debug,
    proxy,
    proxyMode,
    channel: overrides.channel ?? browserChannel(carrierId),
    cdpEndpoint: overrides.cdpEndpoint ?? cdpEndpointForCarrier(carrierId),
    launchArgs: overrides.launchArgs ?? launchArgsForCarrier(carrierId),
    userAgent:
      overrides.userAgent !== undefined
        ? overrides.userAgent
        : carrierId === "fedex"
          ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
          : carrierId === "dhl" || carrierId === "purolator"
            ? null
          : undefined,
    fingerprintProfile:
      overrides.fingerprintProfile ??
      (carrierId === "fedex" && process.env.FEDEX_FINGERPRINT_PROFILE !== "none"
        ? "mac-chrome"
        : undefined),
    disableBlocking: overrides.disableBlocking ?? defaultDisableBlocking(carrierId),
    warmTimeoutMs: overrides.warmTimeoutMs ?? defaultWarmTimeoutMs(carrierId),
    warmWaitUntil:
      overrides.warmWaitUntil ??
      (carrierId === "fedex" ||
      carrierId === "purolator" ||
      carrierId === "royal-mail" ||
      carrierId === "postnord-se" ||
      carrierId === "postnord-dk"
        ? "domcontentloaded"
        : undefined),
    persistentProfileDir: overrides.persistentProfileDir ?? defaultPersistentProfileDir(carrierId),
  };
}
