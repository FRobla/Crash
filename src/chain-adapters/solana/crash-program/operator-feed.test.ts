import { describe, expect, it, vi } from "vitest";
import { connectOperatorFeed, parseFeedMessage, parseLiveFeedUrl } from "./operator-feed";

describe("parseFeedMessage", () => {
  it("accepts well-formed phase hints and crashes", () => {
    expect(parseFeedMessage('{"type":"phase","roundId":"42","phase":"started"}')).toEqual({
      type: "phase",
      roundId: 42n,
      phase: "started",
    });
    expect(parseFeedMessage(JSON.stringify({ type: "crashed", roundId: "42", seedHex: "ab".repeat(32) }))).toEqual({
      type: "crashed",
      roundId: 42n,
      seedHex: "ab".repeat(32),
    });
  });

  it("rejects anything else: bad JSON, wrong seed length or case, huge ids, unknown types, oversized data", () => {
    for (const data of [
      "not json",
      JSON.stringify({ type: "crashed", roundId: "42", seedHex: "ab".repeat(31) }),
      JSON.stringify({ type: "crashed", roundId: "42", seedHex: "AB".repeat(32) }),
      JSON.stringify({ type: "crashed", roundId: "-1", seedHex: "ab".repeat(32) }),
      JSON.stringify({ type: "phase", roundId: "18446744073709551616", phase: "started" }),
      JSON.stringify({ type: "phase", roundId: "1", phase: "paid-you" }),
      JSON.stringify({ type: "balance", roundId: "1" }),
      `{"type":"phase","roundId":"1","phase":"started","pad":"${"x".repeat(600)}"}`,
    ]) {
      expect(parseFeedMessage(data), data.slice(0, 60)).toBeNull();
    }
    expect(parseFeedMessage(42)).toBeNull();
  });
});

describe("parseLiveFeedUrl", () => {
  it("is optional and allows https or http to this machine only", () => {
    expect(parseLiveFeedUrl(undefined)).toBeNull();
    expect(parseLiveFeedUrl("  ")).toBeNull();
    expect(parseLiveFeedUrl("http://127.0.0.1:8787/events")).toBe("http://127.0.0.1:8787/events");
    expect(parseLiveFeedUrl("http://localhost:8787/events")).toBe("http://localhost:8787/events");
    expect(parseLiveFeedUrl("https://feed.example/events")).toBe("https://feed.example/events");
  });

  it("rejects remote http, other schemes and credentials without echoing the value", () => {
    for (const value of ["http://feed.example/events", "ws://127.0.0.1:8787", "https://user:secret@feed.example/"]) {
      let message = "";
      try {
        parseLiveFeedUrl(value);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/NEXT_PUBLIC_CRASH_LIVE_FEED_URL/);
      expect(message).not.toContain("secret");
    }
  });
});

describe("connectOperatorFeed", () => {
  function fakeSource() {
    return {
      readyState: 0,
      close: vi.fn(),
      onopen: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: Event) => void) | null,
    };
  }

  it("reports status, forwards only valid messages and reconnects with backoff after a hard failure", () => {
    const sources: ReturnType<typeof fakeSource>[] = [];
    const retries: { run: () => void; ms: number }[] = [];
    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const stop = connectOperatorFeed(
      "http://127.0.0.1:8787/events",
      { onMessage, onStatus },
      () => {
        const source = fakeSource();
        sources.push(source);
        return source;
      },
      (run, ms) => {
        retries.push({ run, ms });
        return () => undefined;
      },
    );
    sources[0].onopen?.(new Event("open"));
    sources[0].onmessage?.(new MessageEvent("message", { data: '{"type":"phase","roundId":"1","phase":"opened"}' }));
    sources[0].onmessage?.(new MessageEvent("message", { data: '{"type":"crashed","roundId":"1","seedHex":"zz"}' }));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls.map(([status]) => status)).toEqual(["connecting", "live"]);

    // A transient error: the browser retries by itself.
    sources[0].onerror?.(new Event("error"));
    expect(retries).toHaveLength(0);
    // A hard failure (CLOSED): we retry, doubling the delay.
    sources[0].readyState = 2;
    sources[0].onerror?.(new Event("error"));
    expect(retries.map((retry) => retry.ms)).toEqual([1_000]);
    retries[0].run();
    sources[1].readyState = 2;
    sources[1].onerror?.(new Event("error"));
    expect(retries.map((retry) => retry.ms)).toEqual([1_000, 2_000]);

    stop();
    expect(sources[1].close).toHaveBeenCalled();
    retries[1].run();
    expect(sources).toHaveLength(2);
  });
});
