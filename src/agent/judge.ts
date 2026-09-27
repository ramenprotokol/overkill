import { parseBlueprint, type Blueprint } from "../core/blueprint.js";
import { blueprintBodies } from "../core/geometry.js";
import { findOverlaps } from "../core/preview.js";
import { runSim } from "../core/sim.js";
import { analyze, finaleTriggeredWithoutPush, type AttemptReport } from "../core/trace.js";
import { formatInvalid, formatReport } from "./format.js";

export interface AttemptRecord {
  attempt: number;
  blueprint: Blueprint | null;
  report: AttemptReport | null;
  errors: string[];
  note: string;
  traceHash: string | null;
}

export interface Judgement {
  record: AttemptRecord;
  /** The tool result for this attempt. The loop sends it for every attempt except a success, where it stops. */
  feedback: string;
  /** The blueprint was invalid and never simulated; the tool result is sent as an error. */
  isError: boolean;
  success: boolean;
}

/**
 * Judges one `simulate` call exactly as the agent loop does: schema, then starting overlaps, then the physics run,
 * the trace analysis and the no-push rule. Shared by the loop and the offline design harness, so both apply the same checks.
 */
export function judgeAttempt(input: unknown, attempt: number, maxAttempts: number): Judgement {
  const parsed = parseBlueprint(input);
  if (!parsed.ok) {
    return {
      record: { attempt, blueprint: null, report: null, errors: parsed.errors, note: "", traceHash: null },
      feedback: formatInvalid(attempt, maxAttempts, parsed.errors),
      isError: true,
      success: false,
    };
  }
  const bp = parsed.blueprint;
  // Parts that start overlapping get flung apart by the engine, so an overlapping blueprint is invalid, not simulated.
  const overlaps = findOverlaps(blueprintBodies(bp));
  if (overlaps.length > 0) {
    return {
      record: { attempt, blueprint: bp, report: null, errors: overlaps, note: bp.note, traceHash: null },
      feedback: formatInvalid(attempt, maxAttempts, overlaps),
      isError: true,
      success: false,
    };
  }
  const sim = runSim(bp);
  let report = analyze(bp, sim);
  // A machine that hits the finale even when nobody pushes it does the chore on its own, not through the chain.
  if (report.success && finaleTriggeredWithoutPush(bp)) {
    report = {
      ...report,
      outcome: "not_overkill",
      success: false,
      overkillScore: 0,
      summary: "Not overkill enough: the finale gets hit even without the first push.",
    };
  }
  return {
    record: { attempt, blueprint: bp, report, errors: [], note: bp.note, traceHash: sim.hash },
    feedback: formatReport(attempt, maxAttempts, report),
    isError: false,
    success: report.success,
  };
}
