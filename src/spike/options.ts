import type { Effort } from "../agent/loop.js";
import { CHORES } from "./chores.js";

export interface SpikeOptions {
  limit: number;
  effort: Effort;
  maxAttempts: number;
  maxCost: number;
  out: string;
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const MAX_ATTEMPTS = 30;

/** Number() reads "" and "  " as 0, so blank input is checked separately. */
const toNumber = (value: string): number => (value.trim() === "" ? NaN : Number(value));

function integerIn(flag: string, value: string, min: number, max: number): number {
  const n = toNumber(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${flag} must be a whole number between ${min} and ${max} (got "${value}")`);
  }
  return n;
}

/** Parses CLI flags; throws with a plain message on anything that could silently change cost or results. */
export function parseSpikeOptions(raw: { limit: string; effort: string; attempts: string; "max-cost": string; out: string }): SpikeOptions {
  const limit = integerIn("limit", raw.limit, 1, CHORES.length);
  const maxAttempts = integerIn("attempts", raw.attempts, 1, MAX_ATTEMPTS);

  const maxCost = toNumber(raw["max-cost"]);
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    throw new Error(`--max-cost must be a positive number of US dollars, like 30 (got "${raw["max-cost"]}")`);
  }

  const effort = EFFORTS.find((e) => e === raw.effort);
  if (effort === undefined) {
    throw new Error(`--effort must be one of ${EFFORTS.join(", ")} (got "${raw.effort}")`);
  }

  if (raw.out.trim() === "") throw new Error(`--out must name a directory for the results (got "${raw.out}")`);

  return { limit, effort, maxAttempts, maxCost, out: raw.out };
}
