import type Anthropic from "@anthropic-ai/sdk";
import { addUsage, costUsd, emptyUsage, OPUS_5_5_PRICE, type ApiUsage } from "../agent/cost.js";
import type { MessagesApi } from "../agent/loop.js";

/**
 * The least a call's worst case is taken to be: one maximum-length reply (64k output tokens ≈ $1.28) plus a long,
 * uncached prompt. Later calls in a long conversation get a larger worst case (see `createCappedApi`).
 */
export const WORST_CALL_USD = 2;

/** Room for what a turn adds to the prompt beyond the previous reply (the tool result and the next user message). */
const TURN_GROWTH_TOKENS = 20_000;

export interface CappedApi {
  api: MessagesApi;
  /** USD billed so far, including what a broken or timed-out stream is charged. */
  spent(): number;
  /** True once a call has been refused because it could have passed the cap. */
  capHit(): boolean;
}

/** The streaming call the adapter makes; injectable so tests use a fake. */
export type StreamCall = (body: Anthropic.MessageCreateParamsNonStreaming, signal: AbortSignal) => Promise<Anthropic.Message>;

/**
 * Thrown by a StreamCall whose stream died after usage started arriving: `usage` is the SDK's snapshot of the reply,
 * `cause` is the original error, which the adapter rethrows once the call is charged. The snapshot comes from
 * `message_start`, so its input counts are real but its `output_tokens` is about 1: the true output count is only
 * reported at the end of the stream (`message_delta`).
 */
export class PartialUsageError extends Error {
  constructor(
    cause: unknown,
    readonly usage: ApiUsage,
  ) {
    super("stream failed midway", { cause });
    this.name = "PartialUsageError";
  }
}

/** A call the adapter abandoned after its timeout. Its string form is just the message, so a run records "call timed out after 10 min". */
export class CallTimeoutError extends Error {
  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`call timed out after ${timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} min` : `${timeoutMs} ms`}`, options);
    this.name = "CallTimeoutError";
  }

  override toString(): string {
    return this.message;
  }
}

const usd = (x: number) => `$${x.toFixed(2)}`;

/**
 * Wraps a streaming call with a hard cost cap. A call is only made when even its worst case would keep spending
 * within `maxCost`. The worst case is the larger of `WORST_CALL_USD` and: the previous reply's tokens (input, cache
 * reads, cache writes and output) plus 20k, all priced as cache writes (the dearest input), plus a full `max_tokens`
 * of output. Each call is abandoned after `callTimeoutMs` and then fails with `CallTimeoutError`.
 *
 * What is charged: a finished reply, its reported usage. A stream that breaks or times out midway, the input and cache
 * tokens it reported plus a full `max_tokens` of output, since its real output count never arrived. A call that fails
 * before any usage arrives, nothing.
 */
export function createCappedApi(stream: StreamCall, maxCost: number, callTimeoutMs = 10 * 60 * 1000): CappedApi {
  let spent = 0;
  let capHit = false;
  let previousReplyTokens = 0;
  const addSpend = (usage: ApiUsage) => {
    spent += costUsd(addUsage(emptyUsage(), usage));
  };
  const worstCaseUsd = (maxTokens: number) =>
    Math.max(
      WORST_CALL_USD,
      ((previousReplyTokens + TURN_GROWTH_TOKENS) * OPUS_5_5_PRICE.cacheWrite + maxTokens * OPUS_5_5_PRICE.output) / 1_000_000,
    );
  const api: MessagesApi = {
    messages: {
      create: async (body) => {
        const worstCase = worstCaseUsd(body.max_tokens);
        if (spent + worstCase > maxCost) {
          capHit = true;
          throw new Error(`cost cap reached: ${usd(spent)} spent of $${maxCost}; the next call could cost up to ${usd(worstCase)}`);
        }
        const signal = AbortSignal.timeout(callTimeoutMs);
        try {
          const msg = await stream(body, signal);
          addSpend(msg.usage);
          const u = msg.usage;
          previousReplyTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + u.output_tokens;
          return msg;
        } catch (e) {
          const cause = e instanceof PartialUsageError ? e.cause : e;
          // A broken stream may already have generated (and billed) output its usage snapshot doesn't show, so
          // charge the worst case: a full max_tokens of output.
          if (e instanceof PartialUsageError) addSpend({ ...e.usage, output_tokens: Math.max(e.usage.output_tokens, body.max_tokens) });
          if (signal.aborted) throw new CallTimeoutError(callTimeoutMs, { cause });
          throw cause;
        }
      },
    },
  };
  return { api, spent: () => spent, capHit: () => capHit };
}
