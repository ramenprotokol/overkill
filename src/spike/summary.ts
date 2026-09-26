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

export function summarize(runs: RunRecord[]): SpikeSummary {
  const ok = runs.filter((r) => r.outcome === "success");
  const attemptsToSuccess = ok.map((r) => r.attempts.length);
  const walls = runs.map((r) => r.wallMs);
  const costs = runs.map((r) => costUsd(r.usage));
  const scores = ok.map((r) => r.attempts.at(-1)?.report?.overkillScore ?? 0);

  const attemptHistogram: Record<number, number> = {};
  for (const n of attemptsToSuccess) attemptHistogram[n] = (attemptHistogram[n] ?? 0) + 1;
  const outcomes: Record<string, number> = {};
  for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;

  const successRate = runs.length > 0 ? ok.length / runs.length : 0;
  const medianAttempts = ok.length > 0 ? percentile(attemptsToSuccess, 50) : null;
  const p50WallMs = percentile(walls, 50);
  const p95WallMs = percentile(walls, 95);

  const reasons: string[] = [];
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

export function renderMarkdown(s: SpikeSummary, runs: RunRecord[], meta: { model: string; effort: string; maxAttempts: number }): string {
  const lines = [
    "# OVERKILL spike results",
    "",
    `- Model: \`${meta.model}\` (effort \`${meta.effort}\`), attempt cap ${meta.maxAttempts}`,
    `- Verdict: **${s.verdict}**${s.reasons.length > 0 ? ` — ${s.reasons.join("; ")}` : ""}`,
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
    ...runs.map((r) =>
      `| ${r.chore} | ${r.outcome} | ${r.attempts.length} | ${r.attempts.at(-1)?.report?.overkillScore ?? 0} | ${sec(r.wallMs)} | $${costUsd(r.usage).toFixed(3)} |`),
  ];
  return lines.join("\n") + "\n";
}
