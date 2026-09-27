import { formatPreview } from "../agent/format.js";
import { judgeAttempt } from "../agent/judge.js";
import { ENGINE } from "../core/constants.js";
import { preview } from "../core/preview.js";
import { DESIGNER, choreId, type MachineFile } from "./machines.js";

/** The agent loop's defaults, so an offline design gets the same budget as a live run. */
export const MAX_ATTEMPTS = 12;
export const MAX_PREVIEWS_PER_ATTEMPT = 3;

/** A call the loop would never make: the run is already over. Nothing is recorded. */
export class RunOver extends Error {}

export interface Step {
  machine: MachineFile;
  /** Word for word what the model gets back from the tool. */
  text: string;
  isError: boolean;
}

export function newMachine(chore: string): MachineFile {
  return {
    chore,
    id: choreId(chore),
    designer: DESIGNER,
    engine: ENGINE,
    maxAttempts: MAX_ATTEMPTS,
    maxPreviewsPerAttempt: MAX_PREVIEWS_PER_ATTEMPT,
    status: "designing",
    pendingPreviews: 0,
    attempts: [],
  };
}

function assertOpen(m: MachineFile): void {
  if (m.status === "success") throw new RunOver(`"${m.chore}" already worked on attempt ${m.attempts.length}; the loop stops at a success.`);
  if (m.status === "out_of_attempts") throw new RunOver(`"${m.chore}" used all ${m.maxAttempts} attempts.`);
  if (m.status === "gave_up") throw new RunOver(`The designer gave up on "${m.chore}".`);
}

/** The loop's `preview` tool: never uses an attempt, and a few are allowed before each one. */
export function previewStep(m: MachineFile, input: unknown): Step {
  assertOpen(m);
  if (m.pendingPreviews >= m.maxPreviewsPerAttempt) {
    return { machine: m, text: `Preview limit reached (${m.maxPreviewsPerAttempt} per attempt). Call simulate.`, isError: true };
  }
  return { machine: { ...m, pendingPreviews: m.pendingPreviews + 1 }, text: formatPreview(preview(input)), isError: false };
}

/** The loop's `simulate` tool: always uses an attempt, and the attempt is always recorded. */
export function simulateStep(m: MachineFile, input: unknown): Step & { success: boolean } {
  assertOpen(m);
  const n = m.attempts.length + 1;
  const judged = judgeAttempt(input, n, m.maxAttempts);
  const report = judged.record.report;
  const attempts = [...m.attempts, {
    attempt: n,
    previews: m.pendingPreviews,
    input,
    outcome: report?.outcome ?? "invalid",
    feedback: judged.feedback,
    chain: report?.chain ?? [],
    overkillScore: report?.overkillScore ?? 0,
    hash: judged.record.traceHash,
  } as const];
  const status = judged.success ? "success" : n >= m.maxAttempts ? "out_of_attempts" : "designing";
  return { machine: { ...m, status, pendingPreviews: 0, attempts }, text: judged.feedback, isError: judged.isError, success: judged.success };
}

/** The loop ends a run as "gave up" when the model answers without a tool call after at least one attempt. */
export function giveUpStep(m: MachineFile, reason: string): MachineFile {
  assertOpen(m);
  if (m.attempts.length === 0) throw new RunOver("Make at least one attempt before giving up; the loop nudges once instead.");
  const sentence = reason.trim();
  if (!sentence) throw new RunOver("Say in one sentence why no further attempt can work.");
  return { ...m, status: "gave_up", gaveUp: sentence };
}
