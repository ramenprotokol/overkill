/**
 * USD per million tokens for claude-opus-5-5: $4 input, $20 output, $0.20 cache read;
 * cache writes at 1.25× input. Cache writes are priced for the default 5-minute cache; a 1-hour cache
 * would cost more. Re-check Anthropic's current pricing page before publishing numbers.
 */
export const OPUS_5_5_PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } as const;

export interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** The subset of the API's usage object we count. */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export function addUsage(total: Usage, u: ApiUsage): Usage {
  return {
    input: total.input + u.input_tokens,
    output: total.output + u.output_tokens,
    cacheWrite: total.cacheWrite + (u.cache_creation_input_tokens ?? 0),
    cacheRead: total.cacheRead + (u.cache_read_input_tokens ?? 0),
  };
}

export function costUsd(u: Usage, price: Record<keyof Usage, number> = OPUS_5_5_PRICE): number {
  return (u.input * price.input + u.output * price.output + u.cacheWrite * price.cacheWrite + u.cacheRead * price.cacheRead) / 1_000_000;
}
