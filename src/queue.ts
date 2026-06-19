import { Queue } from "bullmq";

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

export async function enqueueScrape(job: ScrapeJob, delay = 0): Promise<void> {
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
