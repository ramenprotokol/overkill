import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createCappedApi, PartialUsageError, WORST_CALL_USD, type StreamCall } from "../../src/spike/capped-api.js";

const body = { model: "claude-opus-5-5", max_tokens: 64_000, messages: [{ role: "user", content: "hi" }] } as Anthropic.MessageCreateParamsNonStreaming;

const usage = (input_tokens: number, output_tokens: number) => ({
  input_tokens,
  output_tokens,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

const reply = (u = usage(10_000, 5_000)) =>
  ({
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "end_turn", stop_sequence: null,
    usage: u,
  }) as unknown as Anthropic.Message;

/** A fake stream call that records every call and answers with the scripted behaviour. */
function fakeStream(answer: (signal: AbortSignal) => Promise<Anthropic.Message> = async () => reply()) {
  const signals: AbortSignal[] = [];
  const stream: StreamCall = (_body, signal) => {
    signals.push(signal);
    return answer(signal);
  };
  return { stream, signals };
}

describe("createCappedApi", () => {
  it("allows one maximum-length reply plus a long uncached prompt per call", () => {
    expect(WORST_CALL_USD).toBe(2);
  });

  it("passes calls through and adds each reply's usage to spent", async () => {
    const { stream, signals } = fakeStream();
    const capped = createCappedApi(stream, 30);
    const msg = await capped.api.messages.create(body);
    await capped.api.messages.create(body);
    expect(msg.id).toBe("msg_test");
    expect(signals).toHaveLength(2);
    // 2 × (10k input × $4 + 5k output × $20) / 1M
    expect(capped.spent()).toBeCloseTo(0.28, 10);
    expect(capped.capHit()).toBe(false);
  });

  it("refuses a call when a worst-case call could pass the cap, without calling the stream", async () => {
    const { stream, signals } = fakeStream();
    const capped = createCappedApi(stream, 2.1);
    await capped.api.messages.create(body);
    expect(capped.spent()).toBeCloseTo(0.14, 10);
    await expect(capped.api.messages.create(body)).rejects.toThrow("cost cap reached: $0.14 spent of $2.1");
    expect(signals).toHaveLength(1);
    expect(capped.capHit()).toBe(true);
    expect(capped.spent()).toBeCloseTo(0.14, 10);
  });

  it("refuses the very first call when the cap is below one worst-case call", async () => {
    const { stream, signals } = fakeStream();
    const capped = createCappedApi(stream, 1.99);
    await expect(capped.api.messages.create(body)).rejects.toThrow("cost cap reached: $0.00 spent of $1.99");
    expect(signals).toHaveLength(0);
    expect(capped.capHit()).toBe(true);
    expect(capped.spent()).toBe(0);
  });

  it("allows the first call when the cap equals one worst-case call", async () => {
    const { stream, signals } = fakeStream();
    const capped = createCappedApi(stream, 2);
    await capped.api.messages.create(body);
    expect(signals).toHaveLength(1);
    expect(capped.capHit()).toBe(false);
  });

  it("aborts a stream that never finishes after the call timeout and rethrows", async () => {
    const { stream, signals } = fakeStream(
      (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const capped = createCappedApi(stream, 30, 20);
    await expect(capped.api.messages.create(body)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(true);
    expect(capped.spent()).toBe(0);
    expect(capped.capHit()).toBe(false);
  });

  it("counts the partial usage of a stream that dies midway and rethrows the original error", async () => {
    const original = new Error("socket hang up");
    const { stream } = fakeStream(async () => {
      throw new PartialUsageError(original, usage(10_000, 5_000));
    });
    const capped = createCappedApi(stream, 30);
    await expect(capped.api.messages.create(body)).rejects.toBe(original);
    expect(capped.spent()).toBeCloseTo(0.14, 10);
  });

  it("rethrows a failure that carries no usage and counts nothing", async () => {
    const original = new Error("connection refused");
    const { stream } = fakeStream(async () => {
      throw original;
    });
    const capped = createCappedApi(stream, 30);
    await expect(capped.api.messages.create(body)).rejects.toBe(original);
    expect(capped.spent()).toBe(0);
  });

  it("counts partial usage toward the cap for the next call", async () => {
    const { stream, signals } = fakeStream(async () => {
      throw new PartialUsageError(new Error("stream reset"), usage(0, 10_000)); // $0.20 of output before it died
    });
    const capped = createCappedApi(stream, 2.1);
    await expect(capped.api.messages.create(body)).rejects.toThrow("stream reset");
    await expect(capped.api.messages.create(body)).rejects.toThrow("cost cap reached: $0.20 spent of $2.1");
    expect(signals).toHaveLength(1);
    expect(capped.capHit()).toBe(true);
  });
});
