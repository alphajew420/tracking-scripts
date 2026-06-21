import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "patchright";
import type { ScraperCarrier, QueryCtx } from "../session.ts";
import type { Event, ScrapeResult, Status } from "../types.ts";

export type QueryStrategy = "in_page_fetch" | "parse_warm_dom" | "json_endpoint";

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

export interface JsonEventMap {
  eventsPath: string;
  datePath?: string;
  locationPath?: string;
  descriptionPath: string;
  statusPath?: string;
}

interface ParsedCarrierEvent {
  date: string | null;
  location: string;
  description: string;
}

export interface CarrierAdapterRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  bodyTemplate?: string;
  credentials?: "include" | "same-origin" | "omit";
}

export interface CarrierAdapterConfig {
  id: string;
  displayName: string;
  mode: "scraper";
  warmUrl: string;
  awaitReady?: string;
  queryStrategy: QueryStrategy;
  fetchUrl?: string;
  request?: CarrierAdapterRequest;
  parseHtml?: SelectorMap;
  parseJson?: JsonEventMap;
  failurePatterns?: string[];
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
  if ((config.queryStrategy === "in_page_fetch" || config.queryStrategy === "json_endpoint") && !config.fetchUrl) {
    throw new Error(`${config.id}: ${config.queryStrategy} requires fetchUrl`);
  }
  if (config.queryStrategy === "json_endpoint" && (!config.parseJson?.eventsPath || !config.parseJson.descriptionPath)) {
    throw new Error(`${config.id}: json_endpoint requires parseJson.eventsPath and parseJson.descriptionPath`);
  }
  if (config.queryStrategy !== "json_endpoint" && (!config.parseHtml?.events || !config.parseHtml.description)) {
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

function failureMessage(body: string, patterns: string[] | undefined): string | null {
  for (const pattern of patterns ?? []) {
    if (new RegExp(pattern, "i").test(body)) return pattern;
  }
  return null;
}

function noEventsResult(config: CarrierAdapterConfig): ScrapeResult {
  return { ok: false, error: `${config.displayName}: no tracking events returned` };
}

async function parseHtml(page: Page, html: string, selectors: SelectorMap): Promise<ParsedCarrierEvent[]> {
  const parseHtmlInPage = new Function(
    "arg",
    `
      const { body, selectors } = arg;
      const doc = new DOMParser().parseFromString(body, "text/html");
      return Array.from(doc.querySelectorAll(selectors.events))
        .map((node) => {
          const root = node;
          const textFor = (selector) =>
            selector
              ? root.querySelector(selector)?.textContent?.trim() ?? ""
              : "";
          const fallback = root.textContent?.trim().replace(/\\s+/g, " ") ?? "";
          return {
            date: textFor(selectors.date) || null,
            location: textFor(selectors.location),
            description: textFor(selectors.description) || fallback.slice(0, 240),
          };
        })
        .filter((event) => event.description);
    `,
  ) as (arg: { body: string; selectors: SelectorMap }) => ParsedCarrierEvent[];

  return page.evaluate(
    parseHtmlInPage,
    { body: html, selectors },
  ) as Promise<ParsedCarrierEvent[]>;
}

async function fetchFromPage(
  page: Page,
  url: string,
  request: CarrierAdapterRequest | undefined,
  trackingNumber: string,
): Promise<{ status: number; body: string }> {
  const fetchInPage = new Function(
    "arg",
    `
      const { url, request, trackingNumber } = arg;
      return (async () => {
        const response = await fetch(url, {
          method: request?.method ?? "GET",
          headers: request?.headers,
          body: request?.bodyTemplate?.replaceAll("{n}", trackingNumber),
          credentials: request?.credentials ?? "include",
          redirect: "follow",
        });
        return { status: response.status, body: await response.text() };
      })();
    `,
  ) as (
    arg: { url: string; request: CarrierAdapterRequest | undefined; trackingNumber: string },
  ) => Promise<{ status: number; body: string }>;

  return page.evaluate(
    fetchInPage,
    { url, request, trackingNumber },
  );
}

async function parseJson(page: Page, body: string, selectors: JsonEventMap): Promise<ParsedCarrierEvent[]> {
  const parseJsonInPage = new Function(
    "arg",
    `
      const { body, selectors } = arg;
      const data = JSON.parse(body);
      const readPath = (value, path) => {
        if (!path) return undefined;
        return path.split(".").reduce((current, segment) => {
          if (current == null) return undefined;
          if (Array.isArray(current) && /^\\d+$/.test(segment)) return current[Number(segment)];
          if (typeof current === "object") return current[segment];
          return undefined;
        }, value);
      };
      const eventsValue = readPath(data, selectors.eventsPath);
      const events = Array.isArray(eventsValue) ? eventsValue : [];
      return events
        .map((event) => {
          const item = event;
          const stringify = (value) => {
            if (value == null) return "";
            if (typeof value === "number" && value > 100000000000) return new Date(value).toISOString();
            if (typeof value === "string") return value.trim();
            if (typeof value === "number" || typeof value === "boolean") return String(value);
            return "";
          };
          return {
            date: stringify(readPath(item, selectors.datePath)) || null,
            location: stringify(readPath(item, selectors.locationPath)),
            description:
              stringify(readPath(item, selectors.descriptionPath)) ||
              stringify(readPath(item, selectors.statusPath)),
          };
        })
        .filter((event) => event.description);
    `,
  ) as (arg: { body: string; selectors: JsonEventMap }) => ParsedCarrierEvent[];

  return page.evaluate(
    parseJsonInPage,
    { body, selectors },
  ) as Promise<ParsedCarrierEvent[]>;
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
      if (config.queryStrategy === "parse_warm_dom") {
        const html = await ctx.page.content();
        const rawEvents = await parseHtml(ctx.page, html, config.parseHtml!);
        const events: Event[] = rawEvents.map((event) => ({
          date: event.date,
          location: event.location,
          description: event.description,
          status: classify(event.description, config.statusMap),
        }));
        if (events.length === 0) return noEventsResult(config);

        return {
          ok: true,
          track: {
            carrier: config.id,
            trackingNumber: num,
            delivered: events.some((event) => event.status === "delivered"),
            events,
          },
        };
      }

      if (config.queryStrategy === "json_endpoint") {
        const url = renderTemplate(config.fetchUrl ?? config.warmUrl, num);
        const raw = await fetchFromPage(ctx.page, url, config.request, num);
        if (raw.status < 200 || raw.status >= 300) {
          return { ok: false, error: `${config.displayName} HTTP ${raw.status}` };
        }
        const failedByPattern = failureMessage(raw.body, config.failurePatterns);
        if (failedByPattern) {
          return { ok: false, error: `${config.displayName}: no tracking data (${failedByPattern})` };
        }
        const rawEvents = await parseJson(ctx.page, raw.body, config.parseJson!);
        const events: Event[] = rawEvents.map((event) => ({
          date: event.date,
          location: event.location,
          description: event.description,
          status: classify(event.description, config.statusMap),
        }));
        if (events.length === 0) return noEventsResult(config);

        return {
          ok: true,
          track: {
            carrier: config.id,
            trackingNumber: num,
            delivered: events.some((event) => event.status === "delivered"),
            events,
          },
        };
      }

      const url = renderTemplate(config.fetchUrl ?? config.warmUrl, num);
      const raw = await fetchFromPage(ctx.page, url, config.request, num);
      if (raw.status < 200 || raw.status >= 300) {
        return { ok: false, error: `${config.displayName} HTTP ${raw.status}` };
      }
      const failedByPattern = failureMessage(raw.body, config.failurePatterns);
      if (failedByPattern) {
        return { ok: false, error: `${config.displayName}: no tracking data (${failedByPattern})` };
      }
      const html = raw.body;
      const rawEvents = await parseHtml(ctx.page, html, config.parseHtml!);
      const events: Event[] = rawEvents.map((event) => ({
        date: event.date,
        location: event.location,
        description: event.description,
        status: classify(event.description, config.statusMap),
      }));
      if (events.length === 0) return noEventsResult(config);

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
