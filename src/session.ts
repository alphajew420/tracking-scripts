import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";
import type { ScrapeResult } from "./types.ts";

chromium.use(StealthPlugin());

const BLOCKED_TYPES = new Set(["image", "font", "media", "stylesheet"]);
const BLOCKED_DOMAINS = [
  "googletagmanager.com",
  "google-analytics.com",
  "googleadservices.com",
  "doubleclick.net",
  "facebook.com",
  "facebook.net",
  "fast.fonts.net",
  "adobedtm.com",
  "demdex.net",
];

interface CarrierBase {
  /** Stable identifier, e.g. "usps". */
  readonly name: string;
  /**
   * Optional. Inspect a failed result and decide whether the session has
   * expired (Akamai cookie aged out, OAuth token rejected, etc.).
   */
  isExpired?(result: ScrapeResult): boolean;
}

export interface ScraperCarrier extends CarrierBase {
  readonly mode: "scraper";
  /** Initial URL to load to mint anti-bot cookies + any auth tokens. */
  warmUrl(num: string): string;
  /**
   * Optional. Called once per warm, AFTER the new Page is created but BEFORE
   * the warm navigation runs. Use this to attach response listeners (e.g. to
   * capture an OAuth bearer token).
   */
  setupPage?(page: Page): void | Promise<void>;
  /**
   * Optional. Called AFTER the warm navigation lands. Use to wait for a
   * carrier-specific "session is now valid" signal.
   */
  awaitReady?(page: Page): Promise<void>;
  /**
   * Execute one tracking lookup against the warm Page. Implementations should
   * use `page.evaluate(fetch ...)` — never `page.goto()` — so we reuse cookies
   * and don't pay the asset-loading cost again.
   */
  runQuery(page: Page, num: string): Promise<ScrapeResult>;
}

export interface ApiCarrier extends CarrierBase {
  readonly mode: "api";
  /** Direct API call — no browser needed. Manages its own auth/tokens. */
  runQuery(num: string): Promise<ScrapeResult>;
}

export type Carrier = ScraperCarrier | ApiCarrier;

export interface SessionOptions {
  /** Default true. Set false to see the browser window (helpful when debugging). */
  headless?: boolean;
  /**
   * Which browser channel to use. Defaults to Playwright's bundled Chromium.
   * Set "chrome" or "msedge" to use the system browser — required for some
   * carriers (notably UPS, which uses reCAPTCHA that detects bundled Chromium
   * but not system Chrome).
   */
  channel?: "chrome" | "msedge";
  /** Fired each time we (re)warm the session. Useful for telemetry / logging. */
  onWarm?: () => void;
  /** Forwarded to the carrier in case it wants verbose logging. */
  debug?: boolean;
}

const DEFAULT_EXPIRED_MARKERS =
  /access denied|edgesuite|akamai bot|forbidden|403|_abck|session expired/i;

export class TrackingSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private _warm = false;

  constructor(
    private readonly carrier: Carrier,
    private readonly opts: SessionOptions = {},
  ) {}

  get warm(): boolean {
    return this._warm;
  }

  async track(num: string): Promise<ScrapeResult> {
    // API mode: no browser, no warm — carrier handles everything.
    if (this.carrier.mode === "api") {
      return this.carrier.runQuery(num);
    }

    // Scraper mode: warm + retry-on-expiry.
    await this.ensureWarm(num);
    let result = await this.carrier.runQuery(this.page!, num);

    if (!result.ok && this.detectExpired(result)) {
      if (this.opts.debug)
        console.error(`[session:${this.carrier.name}] expiry detected, re-warming`);
      this._warm = false;
      await this.ensureWarm(num);
      result = await this.carrier.runQuery(this.page!, num);
    }
    return result;
  }

  async close(): Promise<void> {
    // Tear down in reverse order; ignore stealth-plugin races during shutdown.
    const safe = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch { /* */ }
    };
    if (this.page) await safe(() => this.page!.close());
    if (this.context) await safe(() => this.context!.close());
    if (this.browser) await safe(() => this.browser!.close());
    this.page = null;
    this.context = null;
    this.browser = null;
    this._warm = false;
  }

  private async ensureWarm(num: string): Promise<void> {
    // API-mode carriers don't need a warm.
    if (this.carrier.mode === "api") {
      this._warm = true;
      return;
    }
    if (this._warm && this.page) return;

    // Close stale page/context if a prior warm partially failed.
    if (this.page) {
      try { await this.page.close(); } catch { /* */ }
      this.page = null;
    }
    if (this.context) {
      try { await this.context.close(); } catch { /* */ }
      this.context = null;
    }

    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.opts.headless ?? true,
        args: ["--disable-blink-features=AutomationControlled"],
        ...(this.opts.channel ? { channel: this.opts.channel } : {}),
      });
    }

    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });

    if (!process.env.NO_BLOCKING) {
      await this.context.route("**/*", (route, req) => {
        const url = req.url();
        if (BLOCKED_TYPES.has(req.resourceType())) return route.abort();
        if (BLOCKED_DOMAINS.some((d) => url.includes(d))) return route.abort();
        return route.continue();
      });
    }

    this.page = await this.context.newPage();

    const scraperForSetup = this.carrier as ScraperCarrier;
    if (scraperForSetup.setupPage) {
      await scraperForSetup.setupPage(this.page);
    }

    // Narrow: we've already returned for api mode above.
    const scraper = this.carrier as ScraperCarrier;
    await this.page.goto(scraper.warmUrl(num), {
      waitUntil: "load",
      timeout: 60000,
    });

    // Anti-bot scripts (Akamai sensor, etc.) often finish minting cookies AFTER
    // page load. The carrier can override with a precise readiness selector;
    // otherwise we fall back to a short fixed wait.
    if (scraper.awaitReady) {
      await scraper.awaitReady(this.page);
    } else {
      await this.page.waitForTimeout(3000);
    }

    this._warm = true;
    this.opts.onWarm?.();
  }

  private detectExpired(result: ScrapeResult): boolean {
    if (this.carrier.isExpired) return this.carrier.isExpired(result);
    return DEFAULT_EXPIRED_MARKERS.test(result.error || "");
  }
}

/** One-shot convenience: warm, run one query, close. */
export async function trackOnce(
  carrier: Carrier,
  num: string,
  opts?: SessionOptions,
): Promise<ScrapeResult> {
  const s = new TrackingSession(carrier, opts);
  try {
    return await s.track(num);
  } finally {
    await s.close();
  }
}
