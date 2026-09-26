import { describe, expect, it } from "vitest";
import type { RunOutcome, RunRecord } from "../../src/agent/loop.js";
import type { AttemptReport } from "../../src/core/trace.js";
import { percentile, renderMarkdown, summarize } from "../../src/spike/summary.js";

const run = (outcome: RunOutcome, attempts: number, wallMs = 60_000, score = 6): RunRecord => ({
  chore: "turn off the light", outcome, previews: 0, turns: attempts, truncations: 0, wallMs,
  model: "claude-opus-5-5", effort: "high", engine: "test",
  usage: { input: 10_000, output: 5_000, cacheWrite: 0, cacheRead: 0 },
  attempts: Array.from({ length: attempts }, (_, i) => ({
    attempt: i + 1, blueprint: null, errors: [], note: "", traceHash: null,
    report: outcome === "success" && i === attempts - 1 ? ({ overkillScore: score } as AttemptReport) : null,
  })),
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe("summarize", () => {
  it("says GO when 60%+ succeed quickly in few attempts", () => {
    const s = summarize([run("success", 3), run("success", 5), run("success", 6), run("out_of_attempts", 12), run("gave_up", 4)]);
    expect(s.successRate).toBeCloseTo(0.6);
    expect(s.medianAttempts).toBe(5);
    expect(s.attemptHistogram).toEqual({ 3: 1, 5: 1, 6: 1 });
    expect(s.outcomes).toEqual({ success: 3, out_of_attempts: 1, gave_up: 1 });
    expect(s.meanCostUsd).toBeCloseTo(0.14);
    expect(s.meanOverkill).toBe(6);
    expect(s.verdict).toBe("GO");
    expect(s.reasons).toEqual([]);
  });

  it("says SHIP_AS_STRUGGLE between 40% and 60%", () => {
    const s = summarize([run("success", 4), run("success", 4), run("out_of_attempts", 12), run("out_of_attempts", 12), run("gave_up", 3)]);
    expect(s.verdict).toBe("SHIP_AS_STRUGGLE");
    expect(s.reasons).toContain("success rate 40% is below 60%");
  });

  it("says CHANGE_INTERFACE below 40%", () => {
    expect(summarize([run("success", 2), run("out_of_attempts", 12), run("out_of_attempts", 12), run("gave_up", 5)]).verdict).toBe("CHANGE_INTERFACE");
  });

  it("does not say GO when runs are too slow", () => {
    const s = summarize([run("success", 2, 150_000), run("success", 2, 150_000), run("success", 2, 150_000)]);
    expect(s.verdict).toBe("SHIP_AS_STRUGGLE");
    expect(s.reasons).toEqual(["p50 run time 150 s is not under 2 minutes"]);
  });
});

describe("renderMarkdown", () => {
  it("leads with the verdict and lists every run", () => {
    const runs = [run("success", 3), run("gave_up", 4)];
    const md = renderMarkdown(summarize(runs), runs, { model: "claude-opus-5-5", effort: "high", maxAttempts: 12 });
    expect(md).toContain("- Verdict: **SHIP_AS_STRUGGLE**");
    expect(md).toContain("| Truncated replies | 0 |");
    expect(md).toContain("| turn off the light | success | 3 | 6 | 60 s | $0.140 |");
  });
});
