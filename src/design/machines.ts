import type { Outcome } from "../core/trace.js";

/**
 * A chore's design history, as stored in machines/<id>.json. Every `simulate` call the designer made is an attempt,
 * failures included, in order; nothing is ever rewritten. Browser-safe: the web app imports these files.
 */
export interface MachineFile {
  chore: string;
  id: string;
  designer: string;
  engine: string;
  maxAttempts: number;
  maxPreviewsPerAttempt: number;
  status: MachineStatus;
  /** Previews used since the last attempt. */
  pendingPreviews: number;
  attempts: StoredAttempt[];
  /** The designer's one-sentence reason, when it gave up. */
  gaveUp?: string;
}

export type MachineStatus = "designing" | "success" | "out_of_attempts" | "gave_up";
export type AttemptOutcome = Outcome | "invalid";

export interface StoredAttempt {
  attempt: number;
  /** Previews used before this attempt (none of them use an attempt). */
  previews: number;
  /** Exactly what was sent to simulate. */
  input: unknown;
  outcome: AttemptOutcome;
  /** The tool result the model would get for this attempt, word for word. */
  feedback: string;
  chain: string[];
  overkillScore: number;
  /** Trace hash of the physics run; null when the blueprint was invalid and never ran. */
  hash: string | null;
}

export const DESIGNER = "Claude Opus 5.5 (claude-opus-5-5), offline, through npm run design";

/** "fill the dog's bowl" → "fill-the-dogs-bowl". */
export function choreId(chore: string): string {
  return chore.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
