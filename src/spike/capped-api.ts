import type Anthropic from "@anthropic-ai/sdk";
import { addUsage, costUsd, emptyUsage, type ApiUsage } from "../agent/cost.js";
import type { MessagesApi } from "../agent/loop.js";

/** One maximum-length reply (64k output tokens ≈ $1.28) plus a long, uncached prompt. */
export const WORST_CALL_USD = 2;

export interface CappedApi {
  api: MessagesApi;
  /** USD billed so far, including the partial usage of streams that died midway. */
  spent(): number;
  /** True once a call has been refused because it could have passed the cap. */
  capHit(): boolean;
}

/** The streaming call the adapter makes; injectable so tests use a fake. */
export type StreamCall = (body: Anthropic.MessageCreateParamsNonStreaming, signal: AbortSignal) => Promise<Anthropic.Message>;

/**
 * Thrown by a StreamCall whose stream died after usage started arriving: `usage` is what may already be billed,
 * `cause` is the original error, which the adapter rethrows once the usage is counted.
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

/**
 * Wraps a streaming call with a hard cost cap: a call is only made when even a worst-case call would keep spending
 * within `maxCost`, each call is abandoned after `callTimeoutMs`, and every billed token (whole or partial) is counted.
 */
export function createCappedApi(stream: StreamCall, maxCost: number, callTimeoutMs = 10 * 60 * 1000): CappedApi {
  let spent = 0;
  let capHit = false;
  const addSpend = (usage: ApiUsage) => {
    spent += costUsd(addUsage(emptyUsage(), usage));
  };
  const api: MessagesApi = {
    messages: {
      create: async (body) => {
        if (spent + WORST_CALL_USD > maxCost) {
          capHit = true;
          throw new Error(`cost cap reached: $${spent.toFixed(2)} spent of $${maxCost}`);
        }
        try {
          const msg = await stream(body, AbortSignal.timeout(callTimeoutMs));
          addSpend(msg.usage);
          return msg;
        } catch (e) {
          // A stream that dies midway may still be billed for what it produced, so count the usage that arrived.
          if (e instanceof PartialUsageError) {
            addSpend(e.usage);
            throw e.cause;
          }
          throw e;
        }
      },
    },
  };
  return { api, spent: () => spent, capHit: () => capHit };
}
