import { Queue } from "bullmq";
import Redis from "ioredis";

export const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export function redisConnection() {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

export interface ScrapeJob {
  tracking_id: string;
  carrier: string | null;
  tracking_number: string;
  reason: "created" | "scheduled" | "retrack" | "bulk_lookup";
}

export interface WebhookJob {
  delivery_id: string;
}

export const scrapeQueue = new Queue<ScrapeJob>("scrapes", {
  connection: redisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export const webhookQueue = new Queue<WebhookJob>("webhooks", {
  connection: redisConnection(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 5000,
    removeOnFail: 10000,
  },
});

const enqueueLockRedis = new Redis(redisConnection());

function carrierEnvName(prefix: string, carrier: string | null): string | null {
  if (!carrier) return null;
  return `${prefix}_${carrier.toUpperCase().replaceAll("-", "_")}`;
}

function scrapeLockTtlSeconds(job: ScrapeJob): number {
  const reason = job.reason;
  if (reason === "bulk_lookup" || reason === "retrack") return 30;
  const carrierKey = carrierEnvName("SCRAPE_ENQUEUE_LOCK_SECONDS", job.carrier);
  const carrierValue = carrierKey ? process.env[carrierKey] : undefined;
  if (carrierValue != null && carrierValue !== "") return Number(carrierValue);
  return Number(process.env.SCRAPE_ENQUEUE_LOCK_SECONDS ?? 600);
}

export async function enqueueScrape(job: ScrapeJob, delay = 0): Promise<void> {
  const lockKey = `scrape:enqueue:${job.tracking_id}`;
  const lockTtl = scrapeLockTtlSeconds(job);
  const locked = await enqueueLockRedis.set(lockKey, "1", "EX", lockTtl, "NX");
  if (!locked && job.reason !== "retrack") return;

  let added = false;
  try {
    await scrapeQueue.add(
      "scrape",
      job,
      {
        delay,
        jobId: `${job.reason}-${job.tracking_id}-${Date.now()}`,
      },
    );
    added = true;
  } finally {
    if (!added) await enqueueLockRedis.del(lockKey).catch(() => {});
  }
}

export async function releaseScrapeEnqueueLock(trackingId: string): Promise<void> {
  await enqueueLockRedis.del(`scrape:enqueue:${trackingId}`).catch(() => {});
}

export async function enqueueScrapeUnlocked(job: ScrapeJob, delay = 0): Promise<void> {
  await scrapeQueue.add(
    "scrape",
    job,
    {
      delay,
      jobId: `${job.reason}-${job.tracking_id}-${Date.now()}`,
    },
  );
}

export async function enqueueWebhook(job: WebhookJob, delay = 0): Promise<void> {
  await webhookQueue.add("webhook", job, {
    delay,
    jobId: `webhook-${job.delivery_id}`,
  });
}
