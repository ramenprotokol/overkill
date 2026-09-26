import { costUsd } from "../agent/cost.js";
import type { RunRecord } from "../agent/loop.js";

export interface SpikeSummary {
  runs: number;
  successes: number;
  successRate: number;
  medianAttempts: number | null;
  p50WallMs: number;
  p95WallMs: number;
  meanCostUsd: number;
  totalCostUsd: number;
  attemptHistogram: Record<number, number>;
  outcomes: Record<string, number>;
  meanOverkill: number | null;
  /** Replies cut off by max_tokens, summed over all runs. */
  truncations: number;
  verdict: "GO" | "SHIP_AS_STRUGGLE" | "CHANGE_INTERFACE";
  reasons: string[];
}

export interface ReportMeta {
  model: string;
  effort: string;
  maxAttempts: number;
  /** Chores the spike set out to run. */
  planned: number;
  maxCost: number;
  /** Everything billed, including a run cut off by the cap (which is not in the summarized runs). */
  spentUsd: number;
  /** The chore that was running when the cap hit, if any. */
  cutOff: string | null;
  stoppedByCap: boolean;
  /** The API rejected a request (400/401/403), so the spike stopped early. */
  stoppedByApiError: boolean;
}

/** Why the verdict can't be trusted yet; empty when it can. */
export function provisionalCauses(runs: RunRecord[], meta: Pick<ReportMeta, "stoppedByCap" | "stoppedByApiError">): string[] {
  const apiErrors = runs.filter((r) => r.outcome === "api_error").length;
  return [
    ...(meta.stoppedByCap ? ["the cost cap stopped the spike"] : []),
    ...(meta.stoppedByApiError ? ["an API rejection stopped the spike"] : []),
    ...(apiErrors > 0 ? [`${apiErrors} run${apiErrors === 1 ? "" : "s"} ended in an API error`] : []),
  ];
}

/** A run abandoned by the per-call timeout: the slowest kind of run, so it must count toward run time. */
const timedOut = (r: RunRecord) => r.error?.startsWith("call timed out") === true;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sec = (ms: number) => `${(ms / 1000).toFixed(0)} s`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Median that takes the upper middle for an even count, so a gate is never passed on the kinder half; 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function summarize(runs: RunRecord[], planned = runs.length): SpikeSummary {
  const ok = runs.filter((r) => r.outcome === "success");
  const attemptsToSuccess = ok.map((r) => r.attempts.length);
  // An api_error run stopped on the network, not on the model, so its time says nothing about run time. A timed-out
  // run is the exception: it was the slowest, and leaving it out would flatter the run-time gate.
  const walls = runs.filter((r) => r.outcome !== "api_error" || timedOut(r)).map((r) => r.wallMs);
  const costs = runs.map((r) => costUsd(r.usage));
  const scores = ok.map((r) => r.attempts.at(-1)?.report?.overkillScore ?? 0);

  const attemptHistogram: Record<number, number> = {};
  for (const n of attemptsToSuccess) attemptHistogram[n] = (attemptHistogram[n] ?? 0) + 1;
  const outcomes: Record<string, number> = {};
  for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;

  const successRate = runs.length > 0 ? ok.length / runs.length : 0;
  const medianAttempts = ok.length > 0 ? median(attemptsToSuccess) : null;
  const p50WallMs = median(walls);
  const p95WallMs = percentile(walls, 95);

  const reasons: string[] = [];
  if (runs.length < planned) reasons.push(`only ${runs.length} of ${planned} chores ran`);
  if (successRate < 0.6) reasons.push(`success rate ${pct(successRate)} is below 60%`);
  if (medianAttempts === null || medianAttempts > 6) reasons.push(`median attempts ${medianAttempts ?? "n/a"} is above 6`);
  if (p50WallMs >= 120_000) reasons.push(`p50 run time ${sec(p50WallMs)} is not under 2 minutes`);
  const verdict = reasons.length === 0 ? "GO" : successRate >= 0.4 ? "SHIP_AS_STRUGGLE" : "CHANGE_INTERFACE";

  const totalCostUsd = costs.reduce((a, b) => a + b, 0);
  return {
    runs: runs.length,
    successes: ok.length,
    successRate,
    medianAttempts,
    p50WallMs,
    p95WallMs,
    meanCostUsd: runs.length > 0 ? totalCostUsd / runs.length : 0,
    totalCostUsd,
    attemptHistogram,
    outcomes,
    meanOverkill: scores.length > 0 ? mean(scores) : null,
    truncations: runs.reduce((a, r) => a + r.truncations, 0),
    verdict,
    reasons,
  };
}

export function renderMarkdown(s: SpikeSummary, runs: RunRecord[], meta: ReportMeta): string {
  const stopNote = meta.stoppedByCap
    ? ` — stopped by the $${meta.maxCost} cost cap${meta.cutOff !== null ? `, cut off during "${meta.cutOff}"` : ""}; this verdict is provisional`
    : meta.stoppedByApiError
      ? " — stopped by an API rejection; this verdict is provisional"
      : "";
  const causes = provisionalCauses(runs, meta);
  const verdict =
    s.runs === 0
      ? "**NO VERDICT** — no runs completed"
      : `**${s.verdict}**${causes.length > 0 ? ` (provisional: ${causes.join("; ")})` : ""}${s.reasons.length > 0 ? ` — ${s.reasons.join("; ")}` : ""}`;
  const errors = runs.filter((r) => r.error !== undefined);
  const lines = [
    "# OVERKILL spike results",
    "",
    `- Model: \`${meta.model}\` (effort \`${meta.effort}\`), attempt cap ${meta.maxAttempts}`,
    `- Coverage: ${s.runs} of ${meta.planned} chores${stopNote}`,
    `- Verdict: ${verdict}`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Runs | ${s.runs} |`,
    `| Success rate | ${pct(s.successRate)} (${s.successes}/${s.runs}) |`,
    `| Median attempts to success | ${s.medianAttempts ?? "n/a"} |`,
    `| Mean overkill score | ${s.meanOverkill?.toFixed(1) ?? "n/a"} |`,
    `| Run time p50 / p95 | ${sec(s.p50WallMs)} / ${sec(s.p95WallMs)} |`,
    `| Cost per run (mean) | $${s.meanCostUsd.toFixed(3)} |`,
    `| Total cost | $${s.totalCostUsd.toFixed(2)} |`,
    `| Spent (all calls, including any cut-off run) | $${meta.spentUsd.toFixed(2)} |`,
    `| Truncated replies | ${s.truncations} |`,
    "",
    "## Attempts to success",
    "",
    ...Object.entries(s.attemptHistogram)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([n, c]) => `- ${n}: ${"█".repeat(c)} ${c}`),
    "",
    "## Outcomes",
    "",
    ...Object.entries(s.outcomes).map(([o, c]) => `- ${o}: ${c}`),
    "",
    "## Runs",
    "",
    "| Chore | Outcome | Attempts | Overkill | Time | Cost |",
    "|---|---|---|---|---|---|",
    ...runs.map((r) => {
      const overkill = r.outcome === "success" ? (r.attempts.at(-1)?.report?.overkillScore ?? 0) : "–";
      return `| ${r.chore} | ${r.outcome} | ${r.attempts.length} | ${overkill} | ${sec(r.wallMs)} | $${costUsd(r.usage).toFixed(3)} |`;
    }),
    ...(errors.length > 0 ? ["", "## Errors", "", ...errors.map((r) => `- ${r.chore}: ${r.error}`)] : []),
  ];
  return lines.join("\n") + "\n";
}
