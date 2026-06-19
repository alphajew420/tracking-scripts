import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "patchright";
import type { ScraperCarrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

export type QueryStrategy = "in_page_fetch" | "parse_warm_dom";

export interface SelectorMap {
  events: string;
  date?: string;
  location?: string;
  description: string;
}

export interface StatusRule {
  status: Status;
  pattern: string;
  flags?: string;
}

export interface CarrierAdapterConfig {
  id: string;
  displayName: string;
  mode: "scraper";
  warmUrl: string;
  awaitReady?: string;
  queryStrategy: QueryStrategy;
  fetchUrl?: string;
  parseHtml: SelectorMap;
  statusMap: StatusRule[];
  trackingNumberPattern?: string;
  regions?: string[];
  tier?: 1 | 2 | 3 | 4;
}

export interface CarrierCatalogEntry {
  id: string;
  displayName: string;
  mode: CarrierAdapterConfig["mode"];
  regions: string[];
  tier: CarrierAdapterConfig["tier"] | null;
  trackingNumberPattern: string | null;
}

const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../carriers/configs");

function renderTemplate(template: string, trackingNumber: string): string {
  return template.replaceAll("{n}", encodeURIComponent(trackingNumber));
}

function validateConfig(config: CarrierAdapterConfig): CarrierAdapterConfig {
  if (!config.id || !config.displayName) {
    throw new Error("carrier config requires id and displayName");
  }
  if (config.mode !== "scraper") {
    throw new Error(`${config.id}: only scraper configs are supported`);
  }
  if (!config.warmUrl.includes("{n}")) {
    throw new Error(`${config.id}: warmUrl must include {n}`);
  }
  if (config.queryStrategy === "in_page_fetch" && !config.fetchUrl) {
    throw new Error(`${config.id}: in_page_fetch requires fetchUrl`);
  }
  if (!config.parseHtml?.events || !config.parseHtml.description) {
    throw new Error(`${config.id}: parseHtml.events and parseHtml.description are required`);
  }
  return config;
}

export function listCarrierConfigIds(): string[] {
  if (!existsSync(CONFIG_DIR)) return [];
  return readdirSync(CONFIG_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

export function loadCarrierConfig(id: string): CarrierAdapterConfig {
  const path = join(CONFIG_DIR, `${id}.json`);
  const raw = readFileSync(path, "utf8");
  return validateConfig(JSON.parse(raw) as CarrierAdapterConfig);
}

export function listCarrierCatalog(): CarrierCatalogEntry[] {
  return listCarrierConfigIds().map((id) => {
    const config = loadCarrierConfig(id);
    return {
      id: config.id,
      displayName: config.displayName,
      mode: config.mode,
      regions: config.regions ?? [],
      tier: config.tier ?? null,
      trackingNumberPattern: config.trackingNumberPattern ?? null,
    };
  });
}

function classify(description: string, rules: StatusRule[]): Status {
  for (const rule of rules) {
    if (new RegExp(rule.pattern, rule.flags ?? "i").test(description)) return rule.status;
  }
  return "unknown";
}

async function parseHtml(page: Page, html: string, selectors: SelectorMap) {
  return page.evaluate(
    ({ body, selectors }) => {
      const doc = new DOMParser().parseFromString(body, "text/html");
      return Array.from(doc.querySelectorAll(selectors.events))
        .map((node) => {
          const root = node as HTMLElement;
          const textFor = (selector?: string) =>
            selector
              ? (root.querySelector(selector) as HTMLElement | null)?.textContent?.trim() ?? ""
              : "";
          const fallback = root.textContent?.trim().replace(/\s+/g, " ") ?? "";
          return {
            date: textFor(selectors.date) || null,
            location: textFor(selectors.location),
            description: textFor(selectors.description) || fallback.slice(0, 240),
          };
        })
        .filter((event) => event.description);
    },
    { body: html, selectors },
  );
}

export function createConfigScraperCarrier(config: CarrierAdapterConfig): ScraperCarrier {
  validateConfig(config);

  return {
    name: config.id,
    mode: "scraper",
    warmUrl: (num) => renderTemplate(config.warmUrl, num),
    async awaitReady(page) {
      if (!config.awaitReady) {
        await page.waitForTimeout(2500);
        return;
      }
      await page.waitForSelector(config.awaitReady, { timeout: 20000 });
    },
    async runQuery(ctx: QueryCtx, num: string): Promise<ScrapeResult> {
      let html: string;
      if (config.queryStrategy === "parse_warm_dom") {
        html = await ctx.page.content();
      } else {
        const url = renderTemplate(config.fetchUrl ?? config.warmUrl, num);
        const raw = await ctx.page.evaluate(async (u: string) => {
          const response = await fetch(u, {
            credentials: "include",
            redirect: "follow",
          });
          return { status: response.status, body: await response.text() };
        }, url);
        if (raw.status < 200 || raw.status >= 300) {
          return { ok: false, error: `${config.displayName} HTTP ${raw.status}` };
        }
        html = raw.body;
      }

      const rawEvents = await parseHtml(ctx.page, html, config.parseHtml);
      const events: Event[] = rawEvents.map((event) => ({
        date: event.date,
        location: event.location,
        description: event.description,
        status: classify(event.description, config.statusMap),
      }));

      return {
        ok: true,
        track: {
          carrier: config.id,
          trackingNumber: num,
          delivered: events.some((event) => event.status === "delivered"),
          events,
        },
      };
    },
  };
}

export function createConfigCarrier(id: string): ScraperCarrier {
  return createConfigScraperCarrier(loadCarrierConfig(id));
}
