// @vitest-environment node
import { request, type IncomingMessage } from "node:http";
import { Keypair, SendTransactionError, SystemProgram, type Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorChain, SUBMIT_OPTIONS, assertPreflight } from "./chain";
import { FEED_PATH, SseLiveFeed } from "./live-feed";

const ORIGIN = "http://localhost:3000";
const feeds: SseLiveFeed[] = [];
const responses: IncomingMessage[] = [];

afterEach(async () => {
  for (const response of responses.splice(0)) response.destroy();
  for (const feed of feeds.splice(0)) await feed.close();
});

async function startFeed(maxConnections = 4) {
  const feed = new SseLiveFeed({ port: 0, allowedOrigin: ORIGIN, maxConnections });
  feeds.push(feed);
  const { port } = await feed.listen();
  return { feed, port };
}

function open(port: number, { path = FEED_PATH, origin = ORIGIN as string | undefined, method = "GET" } = {}) {
  return new Promise<{ response: IncomingMessage; body: () => string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: origin ? { Origin: origin } : {} },
      (response) => {
        responses.push(response);
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        resolve({ response, body: () => text });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 2_000, interval: 10 });

describe("live feed", () => {
  it("serves the allowed origin only, on its one path and method", async () => {
    const { port } = await startFeed();
    const ok = await open(port);
    expect(ok.response.statusCode).toBe(200);
    expect(ok.response.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(ok.response.headers["content-type"]).toMatch(/text\/event-stream/);
    expect((await open(port, { origin: "https://evil.example" })).response.statusCode).toBe(403);
    expect((await open(port, { path: "/other" })).response.statusCode).toBe(404);
    expect((await open(port, { method: "POST" })).response.statusCode).toBe(405);
  });

  it("caps concurrent connections", async () => {
    const { feed, port } = await startFeed(1);
    expect((await open(port)).response.statusCode).toBe(200);
    await until(() => feed.connections === 1);
    expect((await open(port)).response.statusCode).toBe(503);
  });

  it("broadcasts phase hints and crashes as JSON, and replays the latest ones to new clients", async () => {
    const { feed, port } = await startFeed();
    const first = await open(port);
    await until(() => feed.connections === 1);
    feed.phase(42n, "started");
    feed.crashed(42n, new Uint8Array(32).fill(0xab));
    await until(() => first.body().includes("crashed"));
    const events = first
      .body()
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(events).toEqual([
      { type: "phase", roundId: "42", phase: "started" },
      { type: "crashed", roundId: "42", seedHex: "ab".repeat(32) },
    ]);
    const late = await open(port);
    await until(() => late.body().includes("crashed"));
    expect(late.body()).toContain('"phase":"started"');
  });
});

describe("seed publication", () => {
  const operator = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const transfer = SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: operator.publicKey, lamports: 1 });

  function fakeConnection(sendRawTransaction: Connection["sendRawTransaction"]) {
    return {
      getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
      sendRawTransaction,
      getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null }] }),
      getBlockHeight: async () => 1,
    } as unknown as Connection;
  }

  it("never publishes before the transaction passed preflight", async () => {
    const onSubmitted = vi.fn();
    const failing = vi.fn(async () => {
      throw new SendTransactionError({
        action: "simulate",
        signature: "",
        transactionMessage: "Transaction simulation failed",
        logs: ["Program log: AnchorError occurred. Error Code: RevealTooEarly. Error Number: 6000. Error Message: x."],
      });
    });
    const chain = new OperatorChain(fakeConnection(failing), operator, operator.publicKey, 0);
    const result = await chain.send([transfer], { onSubmitted });
    expect(result.ok).toBe(false);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("publishes once the RPC accepted the simulated transaction, before confirmation", async () => {
    const order: string[] = [];
    const sending = vi.fn(async (_raw: unknown, options: unknown) => {
      order.push("sent");
      expect(options).toEqual(SUBMIT_OPTIONS);
      return "sig";
    });
    const connection = fakeConnection(sending as unknown as Connection["sendRawTransaction"]);
    const statuses = connection.getSignatureStatuses.bind(connection);
    connection.getSignatureStatuses = (async (...args: Parameters<typeof statuses>) => {
      order.push("confirming");
      return statuses(...args);
    }) as typeof connection.getSignatureStatuses;
    const chain = new OperatorChain(connection, operator, operator.publicKey, 0);
    const result = await chain.send([transfer], { onSubmitted: () => order.push("published") });
    expect(result).toEqual({ ok: true, signature: "sig" });
    expect(order).toEqual(["sent", "published", "confirming"]);
  });

  it("refuses to submit without preflight", () => {
    expect(() => assertPreflight(SUBMIT_OPTIONS)).not.toThrow();
    expect(() => assertPreflight({ ...SUBMIT_OPTIONS, skipPreflight: true })).toThrow(/preflight/);
    expect(() => assertPreflight({ ...SUBMIT_OPTIONS, preflightCommitment: "processed" })).toThrow(/preflight/);
    expect(Object.isFrozen(SUBMIT_OPTIONS)).toBe(true);
  });
});
