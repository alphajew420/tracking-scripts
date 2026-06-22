import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fedexCarrier } from "../carriers/fedex.ts";
import { buildCarrierSessionOptions } from "../carrier-runtime.ts";
import { defaultHeadlessForCarrier } from "../carrier-runtime.ts";
import { proxyForCarrier } from "../proxy.ts";
import { TrackingSession } from "../session.ts";

const port = Number(process.env.FEDEX_BROWSER_WORKER_PORT ?? 8791);
const token = process.env.FEDEX_BROWSER_WORKER_TOKEN;

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/track") {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (token && !validToken(req.headers.authorization, token)) {
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const body = await readJson(req);
    const trackingNumber = String(body?.tracking_number ?? body?.trackingNumber ?? "");
    if (!/^[A-Z0-9-]{6,40}$/i.test(trackingNumber)) {
      send(res, 400, { ok: false, error: "invalid tracking_number" });
      return;
    }

    const sessionId = `fedex-worker-${randomUUID()}`;
    const proxy = process.env.FEDEX_USE_PROXY === "false"
      ? undefined
      : proxyForCarrier("fedex", { country: process.env.PROXY_COUNTRY ?? "us", session: sessionId });
    const session = new TrackingSession(
      fedexCarrier,
      buildCarrierSessionOptions("fedex", {
        headless: defaultHeadlessForCarrier("fedex"),
        debug: process.env.DEBUG_SCRAPES === "1",
        proxy,
        proxyMode: (process.env.PROXY_FEDEX_MODE as "native" | "extension" | "forwarder" | undefined) ?? "extension",
        persistentProfileDir: `${process.env.FEDEX_BROWSER_WORKER_PROFILE_DIR ?? ".browser-profiles/fedex-worker"}/${sessionId}`,
      }),
    );
    try {
      send(res, 200, await session.track(trackingNumber));
    } finally {
      await session.close();
    }
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  console.log(`FedEx browser worker listening on ${port}`);
});

function validToken(header: string | undefined, expected: string): boolean {
  const actual = header?.replace(/^Bearer\s+/i, "") ?? "";
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
