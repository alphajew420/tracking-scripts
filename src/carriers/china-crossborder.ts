import type { Page } from "patchright";
import type { QueryCtx, ScraperCarrier } from "../session.ts";
import type { Event, ScrapeResult, Status, Track } from "../types.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface FetchResult {
  status: number;
  body: string;
  bytes: number;
  url: string;
}

const STATUS_RULES: Array<[Status, RegExp]> = [
  ["delivered", /delivered|signed|delivery successful|已签收|妥投/i],
  ["exception", /exception|failed|failure|returned|returning|delay|abnormal|alert|退回|异常/i],
  ["pickup", /pickup|picked up|collected|accepted|received|posting|揽收|收寄/i],
  ["in_transit", /transit|arrived|departed|customs|handover|processing|运输|到达|离开|清关/i],
];

function classify(description: string): Status {
  for (const [status, pattern] of STATUS_RULES) {
    if (pattern.test(description)) return status;
  }
  return "unknown";
}

function clean(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") return value > 100000000000 ? new Date(value).toISOString() : String(value);
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (typeof value === "boolean") return String(value);
  return "";
}

async function fetchFromWarmPage(
  page: Page,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<FetchResult> {
  return page.evaluate(
    async ({ url, init }) => {
      const response = await fetch(url, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        body: init?.body,
        credentials: "include",
        redirect: "follow",
      });
      const body = await response.text();
      return {
        status: response.status,
        body,
        bytes: new TextEncoder().encode(body).byteLength,
        url: response.url,
      };
    },
    { url, init },
  );
}

function json(raw: FetchResult, carrier: string): JsonValue | null {
  try {
    return JSON.parse(raw.body) as JsonValue;
  } catch {
    throw new Error(`${carrier}: invalid JSON response (${raw.status})`);
  }
}

function objectAt(value: unknown, path: string[]): Record<string, unknown> | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : null;
}

function arrayAt(value: unknown, path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return [];
    current = (current as Record<string, unknown>)[key];
  }
  return Array.isArray(current) ? current : [];
}

function makeTrack(carrier: string, num: string, events: Event[], raw: Record<string, unknown>): Track {
  return {
    carrier,
    trackingNumber: num,
    delivered: events.some((event) => event.status === "delivered"),
    events,
    raw,
  };
}

function ok(carrier: string, num: string, events: Event[], raw: Record<string, unknown>): ScrapeResult {
  if (events.length === 0) {
    return { ok: false, error: `${carrier}: no tracking events returned` };
  }
  return { ok: true, track: makeTrack(carrier, num, events, raw) };
}

function failHttp(carrier: string, raw: FetchResult): ScrapeResult {
  return { ok: false, error: `${carrier}: HTTP ${raw.status}` };
}

function fourPxStatus(status: unknown, description: string): Status {
  if (status === 3 || status === "DELIVERED") return "delivered";
  if (status === 5 || status === 6 || status === 7) return "exception";
  if (status === 1) return "pickup";
  if (status === 2 || status === 4) return "in_transit";
  return classify(description);
}

function fourPxEvents(item: Record<string, unknown> | null): Event[] {
  const tracks = Array.isArray(item?.tracks) ? item.tracks : [];
  return tracks
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as Record<string, unknown>;
      const description = clean(e.tkDesc ?? e.content ?? e.description ?? e.trackContent);
      if (!description) return null;
      return {
        date: clean(e.tkDate ?? e.time ?? e.trackTime ?? e.createTime) || null,
        location: clean(e.location ?? e.tkLocation ?? e.city),
        description,
        status: fourPxStatus(e.status ?? item?.status, description),
      };
    })
    .filter((event): event is Event => event != null);
}

export const fourPxCarrier: ScraperCarrier = {
  name: "4px",
  mode: "scraper",
  warmUrl: (num) => `https://track.4px.com/#/details/${encodeURIComponent(num)}`,
  async awaitReady(page) {
    await page.waitForSelector("body", { timeout: 20000 });
  },
  async runQuery(ctx: QueryCtx, num: string): Promise<ScrapeResult> {
    const raw = await fetchFromWarmPage(ctx.page, "https://track.4px.com/track/v2/front/listTrackV3", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/plain, */*" },
      body: JSON.stringify({ queryCodes: [num], language: "en-us", translateLanguage: "" }),
    });
    if (raw.status < 200 || raw.status >= 300) return failHttp("4px", raw);
    const data = json(raw, "4px");
    const item = arrayAt(data, ["data"])[0] as Record<string, unknown> | undefined;
    return ok("4px", num, fourPxEvents(item ?? null), {
      queryUrl: raw.url,
      queryBytes: raw.bytes,
      source: "https://track.4px.com/",
    });
  },
};

function cainiaoEvents(item: Record<string, unknown> | null): Event[] {
  const processInfo = objectAt(item, ["processInfo"]);
  const progress = Array.isArray(processInfo?.progressPointList)
    ? processInfo.progressPointList
    : Array.isArray(item?.detailList)
      ? item.detailList
      : [];
  return progress
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as Record<string, unknown>;
      const description = clean(e.desc ?? e.statusDesc ?? e.action ?? e.detail);
      if (!description) return null;
      return {
        date: clean(e.timeStr ?? e.eventTime ?? e.time) || null,
        location: clean(e.pointName ?? e.location),
        description,
        status: classify(description),
      };
    })
    .filter((event): event is Event => event != null);
}

export const cainiaoCarrier: ScraperCarrier = {
  name: "cainiao",
  mode: "scraper",
  warmUrl: (num) => `https://global.cainiao.com/detail.htm?mailNoList=${encodeURIComponent(num)}`,
  async awaitReady(page) {
    await page.waitForSelector("body", { timeout: 20000 });
  },
  async runQuery(ctx: QueryCtx, num: string): Promise<ScrapeResult> {
    const raw = await fetchFromWarmPage(
      ctx.page,
      `https://global.cainiao.com/global/detail.json?mailNos=${encodeURIComponent(num)}`,
    );
    if (raw.status < 200 || raw.status >= 300) return failHttp("cainiao", raw);
    const data = json(raw, "cainiao");
    const item = arrayAt(data, ["module"])[0] as Record<string, unknown> | undefined;
    return ok("cainiao", num, cainiaoEvents(item ?? null), {
      queryUrl: raw.url,
      queryBytes: raw.bytes,
      source: "https://global.cainiao.com/",
    });
  },
};

function simpleHtmlEvents(html: string): Event[] {
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const events: Event[] = [];
  for (const row of rowMatches) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => match[1]?.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim().replace(/\s+/g, " ") ?? "")
      .filter(Boolean);
    if (cells.length < 2) continue;
    const description = cells.slice(1).join(" ");
    events.push({
      date: cells[0] || null,
      location: cells.length > 2 ? cells[cells.length - 1] ?? "" : "",
      description,
      status: classify(description),
    });
  }
  return events;
}

export const chinaPostCarrier: ScraperCarrier = {
  name: "china-post",
  mode: "scraper",
  warmUrl: (num) => `https://www.ems.com.cn/english/queryList?mailNum=${encodeURIComponent(num)}`,
  async awaitReady(page) {
    await page.waitForSelector("body", { timeout: 20000 });
  },
  async runQuery(ctx: QueryCtx, num: string): Promise<ScrapeResult> {
    const url = `https://www.ems.com.cn/english/queryList?mailNum=${encodeURIComponent(num)}`;
    const raw = await fetchFromWarmPage(ctx.page, url);
    if (raw.status < 200 || raw.status >= 300) return failHttp("china-post", raw);
    return ok("china-post", num, simpleHtmlEvents(raw.body), {
      queryUrl: raw.url,
      queryBytes: raw.bytes,
      source: "https://www.ems.com.cn/english/queryList",
    });
  },
};

export const sfExpressCarrier: ScraperCarrier = {
  name: "sf-express",
  mode: "scraper",
  warmUrl: (num) => `https://www.sf-express.com/chn/en/waybill/waybill-detail/${encodeURIComponent(num)}`,
  async awaitReady(page) {
    await page.waitForSelector("body", { timeout: 20000 });
  },
  async runQuery(ctx: QueryCtx, num: string): Promise<ScrapeResult> {
    const raw = await fetchFromWarmPage(
      ctx.page,
      `https://www.sf-express.com/chn/en/waybill/waybill-detail/${encodeURIComponent(num)}`,
    );
    if (raw.status < 200 || raw.status >= 300) return failHttp("sf-express", raw);
    return ok("sf-express", num, simpleHtmlEvents(raw.body), {
      queryUrl: raw.url,
      queryBytes: raw.bytes,
      source: "https://www.sf-express.com/chn/en/waybill/waybill-detail",
    });
  },
};

export const yanwenCarrier: ScraperCarrier = {
  name: "yanwen",
  mode: "scraper",
  warmUrl: (num) => `https://track.yw56.com.cn/en/querydel?nums=${encodeURIComponent(num)}`,
  async awaitReady(page) {
    await page.waitForSelector("body", { timeout: 20000 });
  },
  async runQuery(ctx: QueryCtx, num: string): Promise<ScrapeResult> {
    const raw = await fetchFromWarmPage(
      ctx.page,
      `https://track.yw56.com.cn/en/querydel?nums=${encodeURIComponent(num)}`,
    );
    if (raw.status < 200 || raw.status >= 300) return failHttp("yanwen", raw);
    return ok("yanwen", num, simpleHtmlEvents(raw.body), {
      queryUrl: raw.url,
      queryBytes: raw.bytes,
      source: "https://track.yw56.com.cn/",
    });
  },
};
