import { type IncomingMessage, type Server } from "node:http";
import Redis from "ioredis";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { query } from "./db.ts";
import { redisUrl } from "./queue.ts";
import type { AuthContext } from "./server.ts";
import type { WebhookEventType } from "./webhooks.ts";

const realtimeChannel = "trackified:realtime:v1";

export interface RealtimeEvent {
  id: string;
  account_id: string;
  type: WebhookEventType;
  created_at: string;
  tracking_id: string | null;
  data: unknown;
}

interface StreamClient {
  ws: WebSocket;
  accountId: string;
  trackingIds: Set<string>;
  accountWide: boolean;
  alive: boolean;
}

export function publishRealtimeEvent(event: RealtimeEvent): Promise<number> {
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  return redis
    .connect()
    .then(() => redis.publish(realtimeChannel, JSON.stringify(event)))
    .finally(() => redis.quit().catch(() => undefined));
}

export function inferTrackingId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.startsWith("trk_")) return record.id;
  if (typeof record.tracking_id === "string") return record.tracking_id;
  const nested = record.tracking;
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).id === "string") {
    return (nested as Record<string, string>).id;
  }
  return null;
}

export function attachRealtimeServer(params: {
  server: Server;
  authenticate: (req: IncomingMessage, token?: string) => Promise<AuthContext | null>;
}) {
  const wss = new WebSocketServer({ noServer: true });
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
  const clients = new Set<StreamClient>();

  function send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  async function subscribeTracking(client: StreamClient, trackingId: string): Promise<void> {
    const result = await query<{ id: string }>(
      `select id from trackings where id = $1 and account_id = $2 and stopped_at is null`,
      [trackingId, client.accountId],
    );
    if (!result.rows[0]) {
      send(client.ws, { type: "error", code: "not_found", message: "tracking not found" });
      return;
    }
    client.trackingIds.add(trackingId);
    send(client.ws, { type: "subscribed", tracking_id: trackingId });
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage, ctx: AuthContext) => {
    const client: StreamClient = {
      ws,
      accountId: ctx.accountId,
      trackingIds: new Set(),
      accountWide: false,
      alive: true,
    };
    clients.add(client);
    send(ws, { type: "connected", account_id: ctx.accountId });

    ws.on("pong", () => {
      client.alive = true;
    });

    ws.on("message", (raw: RawData) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        send(ws, { type: "error", code: "bad_json", message: "message must be JSON" });
        return;
      }

      if (message.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }

      if (message.type === "subscribe") {
        if (message.scope === "account" || message.account_wide === true) {
          client.accountWide = true;
          send(ws, { type: "subscribed", scope: "account" });
          return;
        }
        if (typeof message.tracking_id === "string") {
          subscribeTracking(client, message.tracking_id).catch((error) => {
            send(ws, { type: "error", code: "internal_error", message: String(error?.message ?? error) });
          });
          return;
        }
        send(ws, { type: "error", code: "bad_request", message: "subscribe requires tracking_id or scope=account" });
        return;
      }

      if (message.type === "unsubscribe") {
        if (message.scope === "account") client.accountWide = false;
        if (typeof message.tracking_id === "string") client.trackingIds.delete(message.tracking_id);
        send(ws, { type: "unsubscribed", tracking_id: message.tracking_id ?? null, scope: message.scope ?? null });
        return;
      }

      send(ws, { type: "error", code: "bad_request", message: "unsupported message type" });
    });

    ws.on("close", () => {
      clients.delete(client);
    });

    const initialTrackingId = new URL(req.url ?? "/", "http://localhost").searchParams.get("tracking_id");
    if (initialTrackingId) {
      subscribeTracking(client, initialTrackingId).catch((error) => {
        send(ws, { type: "error", code: "internal_error", message: String(error?.message ?? error) });
      });
    }
  });

  params.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/v1/stream") return;

    const token = url.searchParams.get("api_key") ?? undefined;
    params.authenticate(req, token)
      .then((ctx) => {
        if (!ctx) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req, ctx);
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
        socket.destroy();
      });
  });

  redis.subscribe(realtimeChannel).catch((error) => {
    console.error("[realtime] redis subscribe failed", error);
  });

  redis.on("message", (_channel, payload) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(payload) as RealtimeEvent;
    } catch {
      return;
    }
    for (const client of clients) {
      if (client.accountId !== event.account_id) continue;
      if (!client.accountWide && (!event.tracking_id || !client.trackingIds.has(event.tracking_id))) continue;
      send(client.ws, { type: "event", tracking_id: event.tracking_id, event });
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, 30_000);

  return {
    async close() {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.close(1001, "server shutting down");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await redis.quit().catch(() => undefined);
    },
  };
}
