import { describe, expect, it, vi } from "vitest";
import { rateLimitRetryingFetch } from "./rate-limit-fetch";

const reply = (status: number) => new Response("{}", { status });

describe("rateLimitRetryingFetch", () => {
  it("retries a 429 with doubling delays, without logging, until an answer arrives", async () => {
    const inner = vi.fn().mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(200));
    const sleep = vi.fn(async () => undefined);
    const error = vi.spyOn(console, "error");
    const response = await rateLimitRetryingFetch(inner, sleep)("https://rpc.test", { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1_000]]);
    expect(error).not.toHaveBeenCalled();
  });

  it("gives up after 4 retries and returns the last 429", async () => {
    const inner = vi.fn(async () => reply(429));
    const sleep = vi.fn(async () => undefined);
    const response = await rateLimitRetryingFetch(inner, sleep)("https://rpc.test");
    expect(response.status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls).toEqual([[500], [1_000], [2_000], [4_000]]);
  });

  it("passes any other answer through untouched", async () => {
    const inner = vi.fn(async () => reply(500));
    const sleep = vi.fn(async () => undefined);
    expect((await rateLimitRetryingFetch(inner, sleep)("https://rpc.test")).status).toBe(500);
    expect(sleep).not.toHaveBeenCalled();
  });
});
