import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local Server-Sent Events channel of the crank (ADR 0004; spec crash-client-v1 §4.7). Presentation
 * only: phase hints and a round's seed once its reveal passed preflight, which the web verifies
 * against the on-chain commit before showing anything. Listens on 127.0.0.1 only, for one exact
 * browser origin, with a connection cap and no request body.
 */

export type PhaseHint = "opened" | "betting-closed" | "started" | "revealed" | "voided" | "forfeited";

export type FeedEvent =
  | { type: "phase"; roundId: string; phase: PhaseHint }
  | { type: "crashed"; roundId: string; seedHex: string };

export interface LiveFeed {
  phase(roundId: bigint, phase: PhaseHint): void;
  /** Publishes a round's seed. Call only after its `reveal` passed preflight. */
  crashed(roundId: bigint, seed: Uint8Array): void;
  close(): Promise<void>;
}

export const DISABLED_FEED: LiveFeed = {
  phase: () => undefined,
  crashed: () => undefined,
  close: async () => undefined,
};

export interface LiveFeedOptions {
  port: number;
  allowedOrigin: string;
  maxConnections?: number;
  heartbeatMs?: number;
}

export const FEED_PATH = "/events";
const DEFAULT_MAX_CONNECTIONS = 16;
const DEFAULT_HEARTBEAT_MS = 15_000;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class SseLiveFeed implements LiveFeed {
  private readonly clients = new Set<ServerResponse>();
  private readonly server: Server;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly maxConnections: number;
  private lastPhase: FeedEvent | null = null;
  private lastCrashed: FeedEvent | null = null;

  constructor(private readonly options: LiveFeedOptions) {
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.server = createServer((request, response) => this.handle(request, response));
    // Idle keep-alive sockets beyond the cap are refused by Node itself.
    this.server.maxConnections = this.maxConnections + 4;
    this.heartbeat = setInterval(() => this.write(": ping\n\n"), options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Starts listening on 127.0.0.1; resolves with the bound address (port 0 picks one). */
  listen(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, "127.0.0.1", () => resolve(this.server.address() as AddressInfo));
    });
  }

  get connections(): number {
    return this.clients.size;
  }

  phase(roundId: bigint, phase: PhaseHint): void {
    this.lastPhase = { type: "phase", roundId: roundId.toString(), phase };
    this.broadcast(this.lastPhase);
  }

  crashed(roundId: bigint, seed: Uint8Array): void {
    if (seed.length !== 32) return;
    this.lastCrashed = { type: "crashed", roundId: roundId.toString(), seedHex: toHex(seed) };
    this.broadcast(this.lastCrashed);
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    // Browsers always send Origin cross-origin; a foreign page is refused outright.
    if (origin !== undefined && origin !== this.options.allowedOrigin) return this.reject(response, 403);
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== FEED_PATH) return this.reject(response, 404);
    if (request.method !== "GET") return this.reject(response, 405);
    if (this.clients.size >= this.maxConnections) return this.reject(response, 503);

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": this.options.allowedOrigin,
      Vary: "Origin",
    });
    response.write("retry: 2000\n\n");
    for (const event of [this.lastPhase, this.lastCrashed]) if (event) response.write(frame(event));
    this.clients.add(response);
    const drop = () => this.clients.delete(response);
    request.on("close", drop);
    response.on("error", drop);
  }

  private reject(response: ServerResponse, status: number): void {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", Vary: "Origin" });
    response.end();
  }

  private broadcast(event: FeedEvent): void {
    this.write(frame(event));
  }

  private write(chunk: string): void {
    for (const client of this.clients) client.write(chunk);
  }
}

function frame(event: FeedEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
