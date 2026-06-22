import { createServer, connect, type Server, type Socket } from "node:net";
import { Buffer } from "node:buffer";
import type { BrowserProxy } from "./proxy.ts";

interface ForwarderState {
  server: Server;
  port: number;
}

const forwarders = new Map<string, Promise<ForwarderState>>();

export async function localProxyForwarder(upstream: BrowserProxy): Promise<BrowserProxy> {
  const key = `${upstream.server}|${upstream.username ?? ""}`;
  const existing = forwarders.get(key);
  const state = await (existing ?? startForwarder(upstream));
  if (!existing) forwarders.set(key, Promise.resolve(state));
  return { server: `http://127.0.0.1:${state.port}` };
}

async function startForwarder(upstream: BrowserProxy): Promise<ForwarderState> {
  const upstreamUrl = new URL(normalizeProxyServer(upstream.server));
  const auth = upstream.username
    ? `Basic ${Buffer.from(`${upstream.username}:${upstream.password ?? ""}`).toString("base64")}`
    : null;

  const server = createServer((client) => {
    client.once("data", (firstChunk) => {
      const head = firstChunk.toString("latin1");
      const firstLine = head.slice(0, head.indexOf("\r\n"));
      if (/^CONNECT\s/i.test(firstLine)) {
        handleConnect({ client, firstChunk, firstLine, upstreamUrl, auth });
        return;
      }
      handleHttp({ client, firstChunk, upstreamUrl, auth });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address?.port) resolve(address.port);
      else reject(new Error("proxy forwarder failed to allocate a port"));
    });
  });

  return { server, port };
}

function handleConnect(input: {
  client: Socket;
  firstChunk: Buffer;
  firstLine: string;
  upstreamUrl: URL;
  auth: string | null;
}): void {
  const upstreamSocket = connect(Number(input.upstreamUrl.port || 8080), input.upstreamUrl.hostname);
  upstreamSocket.once("connect", () => {
    const target = input.firstLine.split(/\s+/)[1];
    upstreamSocket.write(
      [
        `CONNECT ${target} HTTP/1.1`,
        `Host: ${target}`,
        input.auth ? `Proxy-Authorization: ${input.auth}` : null,
        "Proxy-Connection: keep-alive",
        "",
        "",
      ].filter(Boolean).join("\r\n"),
    );
  });

  upstreamSocket.once("data", (responseHead) => {
    input.client.write(responseHead);
    input.client.pipe(upstreamSocket);
    upstreamSocket.pipe(input.client);
  });

  closeTogether(input.client, upstreamSocket);
}

function handleHttp(input: {
  client: Socket;
  firstChunk: Buffer;
  upstreamUrl: URL;
  auth: string | null;
}): void {
  const upstreamSocket = connect(Number(input.upstreamUrl.port || 8080), input.upstreamUrl.hostname);
  upstreamSocket.once("connect", () => {
    const withAuth = injectProxyAuthorization(input.firstChunk, input.auth);
    upstreamSocket.write(withAuth);
    input.client.pipe(upstreamSocket);
    upstreamSocket.pipe(input.client);
  });
  closeTogether(input.client, upstreamSocket);
}

function injectProxyAuthorization(chunk: Buffer, auth: string | null): Buffer {
  if (!auth) return chunk;
  const raw = chunk.toString("latin1");
  if (/\r\nProxy-Authorization:/i.test(raw)) return chunk;
  const headerEnd = raw.indexOf("\r\n");
  if (headerEnd < 0) return chunk;
  const next = raw.slice(0, headerEnd + 2) + `Proxy-Authorization: ${auth}\r\n` + raw.slice(headerEnd + 2);
  return Buffer.from(next, "latin1");
}

function closeTogether(a: Socket, b: Socket): void {
  const close = () => {
    a.destroy();
    b.destroy();
  };
  a.once("error", close);
  b.once("error", close);
  a.once("close", () => b.destroy());
  b.once("close", () => a.destroy());
}

function normalizeProxyServer(server: string): string {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(server) ? server : `http://${server}`;
}
