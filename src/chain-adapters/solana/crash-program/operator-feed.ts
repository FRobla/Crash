import { z } from "zod";

/**
 * Browser client of the crank's live channel (ADR 0004; spec crash-client-v1 §4.7). Presentation
 * only: every message is untrusted input, validated here and, for seeds, verified against the
 * on-chain commit before anything is shown. Without a feed the app runs on-chain only.
 */

export type FeedPhase = "opened" | "betting-closed" | "started" | "revealed" | "voided" | "forfeited";

export type FeedMessage =
  | { type: "phase"; roundId: bigint; phase: FeedPhase }
  | { type: "crashed"; roundId: bigint; seedHex: string };

export type FeedStatus = "off" | "connecting" | "live" | "down";

const MAX_MESSAGE_BYTES = 512;
const roundIdSchema = z.string().regex(/^\d{1,20}$/).transform(BigInt).refine((id) => id < 1n << 64n);
const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("phase"),
    roundId: roundIdSchema,
    phase: z.enum(["opened", "betting-closed", "started", "revealed", "voided", "forfeited"]),
  }),
  z.object({ type: z.literal("crashed"), roundId: roundIdSchema, seedHex: z.string().regex(/^[0-9a-f]{64}$/) }),
]);

export function parseFeedMessage(data: unknown): FeedMessage | null {
  if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const result = messageSchema.safeParse(json);
  return result.success ? result.data : null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `https`, or `http` only towards this machine; anything else is a configuration error. */
export function parseLiveFeedUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const result = z.url({ protocol: /^https?$/ }).safeParse(trimmed);
  const url = result.success ? new URL(result.data) : null;
  if (!url || (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) || url.username || url.password) {
    // The message never echoes the configured value.
    throw new Error("Invalid NEXT_PUBLIC_CRASH_LIVE_FEED_URL: use https, or http to localhost only");
  }
  return url.toString();
}

// NEXT_PUBLIC_* values are inlined at build time, so the variable is referenced literally.
export const LIVE_FEED_URL = parseLiveFeedUrl(process.env.NEXT_PUBLIC_CRASH_LIVE_FEED_URL);

export interface FeedHandlers {
  onMessage(message: FeedMessage): void;
  onStatus(status: FeedStatus): void;
}

type EventSourceLike = Pick<EventSource, "close" | "readyState"> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
};

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Connects with automatic reconnection (exponential backoff up to 30 s once the browser gives
 * up on its own retries). Returns a function that disconnects for good.
 */
export function connectOperatorFeed(
  url: string,
  handlers: FeedHandlers,
  createSource: (url: string) => EventSourceLike = (target) => new EventSource(target),
  schedule: (run: () => void, ms: number) => () => void = (run, ms) => {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
): () => void {
  let source: EventSourceLike | null = null;
  let cancelRetry: (() => void) | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    handlers.onStatus("connecting");
    const current = createSource(url);
    source = current;
    current.onopen = () => {
      backoff = INITIAL_BACKOFF_MS;
      handlers.onStatus("live");
    };
    current.onmessage = (event) => {
      const message = parseFeedMessage(event.data);
      if (message) handlers.onMessage(message);
    };
    current.onerror = () => {
      handlers.onStatus("down");
      // CLOSED means the browser will not retry (e.g. 403/503): back off and reconnect ourselves.
      if (current.readyState === 2 && !stopped) {
        current.close();
        cancelRetry = schedule(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    };
  };

  connect();
  return () => {
    stopped = true;
    cancelRetry?.();
    source?.close();
  };
}
