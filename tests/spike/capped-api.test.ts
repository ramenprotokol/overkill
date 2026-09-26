import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { CallTimeoutError, createCappedApi, PartialUsageError, WORST_CALL_USD, type StreamCall } from "../../src/spike/capped-api.js";

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

  it("aborts a stream that never finishes after the call timeout and says it timed out", async () => {
    const { stream, signals } = fakeStream(
      (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const capped = createCappedApi(stream, 30, 20);
    const err = await capped.api.messages.create(body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("call timed out after 20 ms");
    // runAgent records String(e) for non-API errors, so the run's error must start with "call timed out".
    expect(String(err)).toBe("call timed out after 20 ms");
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(true);
    expect(capped.spent()).toBe(0);
    expect(capped.capHit()).toBe(false);
  });

  it("charges a timed-out stream's partial usage and still says it timed out", async () => {
    const { stream } = fakeStream(
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new PartialUsageError(new Error("Request was aborted."), usage(10_000, 1)))),
        ),
    );
    const capped = createCappedApi(stream, 30, 20);
    await expect(capped.api.messages.create(body)).rejects.toThrow("call timed out after 20 ms");
    // 10k input × $4 + a full 64k max_tokens of output × $20, per million
    expect(capped.spent()).toBeCloseTo(1.32, 10);
  });

  it("names a whole number of minutes in minutes", () => {
    expect(String(new CallTimeoutError(10 * 60 * 1000))).toBe("call timed out after 10 min");
  });

  it("charges a broken stream its reported input plus a full max_tokens of output, and rethrows the original error", async () => {
    // A realistic partial: the SDK's snapshot comes from message_start, so output_tokens is ~1 whatever was generated.
    const original = new Error("socket hang up");
    const { stream } = fakeStream(async () => {
      throw new PartialUsageError(original, usage(10_000, 1));
    });
    const capped = createCappedApi(stream, 30);
    await expect(capped.api.messages.create(body)).rejects.toBe(original);
    // 10k input × $4 + 64k output × $20, per million = $0.04 + $1.28
    expect(capped.spent()).toBeCloseTo(1.32, 10);
  });

  it("charges a broken stream the request's own max_tokens of output", async () => {
    const { stream } = fakeStream(async () => {
      throw new PartialUsageError(new Error("socket hang up"), usage(10_000, 1));
    });
    const capped = createCappedApi(stream, 30);
    await expect(capped.api.messages.create({ ...body, max_tokens: 1_000 })).rejects.toThrow("socket hang up");
    // 10k input × $4 + 1k output × $20, per million
    expect(capped.spent()).toBeCloseTo(0.06, 10);
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

  it("counts a broken stream's charge toward the cap for the next call", async () => {
    const { stream, signals } = fakeStream(async () => {
      throw new PartialUsageError(new Error("stream reset"), usage(10_000, 1)); // charged $1.32
    });
    const capped = createCappedApi(stream, 3.3);
    await expect(capped.api.messages.create(body)).rejects.toThrow("stream reset");
    await expect(capped.api.messages.create(body)).rejects.toThrow("cost cap reached: $1.32 spent of $3.3");
    expect(signals).toHaveLength(1);
    expect(capped.capHit()).toBe(true);
  });

  // 10k input + 5k cache write + 280k cache read + 5k output = 300k tokens, billed $0.221.
  const longReply = { input_tokens: 10_000, output_tokens: 5_000, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 280_000 };

  it("raises the next call's worst case as the conversation grows", async () => {
    const { stream, signals } = fakeStream(async () => reply(longReply));
    const capped = createCappedApi(stream, 3);
    await capped.api.messages.create(body);
    expect(capped.spent()).toBeCloseTo(0.221, 10);
    // Next worst case: (300k + 20k) × $5 + 64k × $20, per million = $2.88. $0.22 + $2 fits in $3, but $0.22 + $2.88 does not.
    await expect(capped.api.messages.create(body)).rejects.toThrow("cost cap reached: $0.22 spent of $3; the next call could cost up to $2.88");
    expect(signals).toHaveLength(1);
    expect(capped.capHit()).toBe(true);
  });

  it("allows that next call when the cap covers the larger worst case", async () => {
    const { stream, signals } = fakeStream(async () => reply(longReply));
    const capped = createCappedApi(stream, 3.2);
    await capped.api.messages.create(body);
    await capped.api.messages.create(body);
    expect(signals).toHaveLength(2);
    expect(capped.capHit()).toBe(false);
  });
});
