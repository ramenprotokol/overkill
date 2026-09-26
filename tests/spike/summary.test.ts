import { describe, expect, it } from "vitest";
import type { RunOutcome, RunRecord } from "../../src/agent/loop.js";
import type { AttemptReport } from "../../src/core/trace.js";
import { median, percentile, renderMarkdown, summarize } from "../../src/spike/summary.js";

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

describe("median", () => {
  it("takes the upper middle for an even count", () => {
    expect(median([7, 2, 6, 4])).toBe(6);
    expect(median([3, 5, 7, 8])).toBe(7);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBe(0);
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

  it("uses the upper middle for an even number of successes", () => {
    const s = summarize([run("success", 3), run("success", 5), run("success", 7), run("success", 8)]);
    expect(s.medianAttempts).toBe(7);
    expect(s.verdict).toBe("SHIP_AS_STRUGGLE");
    expect(s.reasons).toEqual(["median attempts 7 is above 6"]);
  });

  it("uses the upper middle for an even number of run times", () => {
    const s = summarize([run("success", 2, 60_000), run("success", 2, 60_000), run("success", 2, 130_000), run("success", 2, 130_000)]);
    expect(s.p50WallMs).toBe(130_000);
    expect(s.verdict).not.toBe("GO");
  });

  it("does not say GO when fewer chores ran than planned", () => {
    const runs = [run("success", 3), run("success", 3), run("success", 3)];
    expect(summarize(runs).verdict).toBe("GO");
    const s = summarize(runs, 5);
    expect(s.verdict).toBe("SHIP_AS_STRUGGLE");
    expect(s.reasons).toEqual(["only 3 of 5 chores ran"]);
  });

  it("leaves api_error runs out of the run times but counts them as failures", () => {
    const err = { ...run("api_error", 0, 1_000), error: "overloaded" };
    const s = summarize([run("success", 2, 60_000), run("success", 2, 60_000), err, err, err]);
    expect(s.p50WallMs).toBe(60_000);
    expect(s.p95WallMs).toBe(60_000);
    expect(s.successRate).toBeCloseTo(0.4);
    expect(s.outcomes).toEqual({ success: 2, api_error: 3 });
  });

  it("keeps a slow api_error out of p95", () => {
    const s = summarize([run("success", 2, 60_000), run("success", 2, 60_000), { ...run("api_error", 0, 500_000), error: "timeout" }]);
    expect(s.p95WallMs).toBe(60_000);
  });
});

const META = {
  model: "claude-opus-5-5", effort: "high", maxAttempts: 12,
  planned: 2, maxCost: 30, spentUsd: 0.28, cutOff: null, stoppedByCap: false,
};

describe("renderMarkdown", () => {
  it("leads with the verdict and lists every run", () => {
    const runs = [run("success", 3), run("gave_up", 4)];
    const md = renderMarkdown(summarize(runs), runs, META);
    expect(md).toContain("- Verdict: **SHIP_AS_STRUGGLE**");
    expect(md).toContain("- Coverage: 2 of 2 chores\n");
    expect(md).toContain("| Truncated replies | 0 |");
    expect(md).toContain("| Total cost | $0.28 |");
    expect(md).toContain("| Spent (all calls, including any cut-off run) | $0.28 |");
    expect(md).toContain("| turn off the light | success | 3 | 6 | 60 s | $0.140 |");
  });

  it("shows no overkill score for a run that did not succeed", () => {
    const runs = [run("gave_up", 4)];
    const md = renderMarkdown(summarize(runs), runs, { ...META, planned: 1 });
    expect(md).toContain("| turn off the light | gave_up | 4 | – | 60 s | $0.140 |");
  });

  it("marks the verdict provisional when the cost cap stopped the spike", () => {
    const runs = [run("success", 3), run("success", 3)];
    const md = renderMarkdown(summarize(runs, 5), runs, { ...META, planned: 5, spentUsd: 29.1, cutOff: "mist the fern", stoppedByCap: true });
    expect(md).toContain('- Coverage: 2 of 5 chores — stopped by the $30 cost cap, cut off during "mist the fern"; this verdict is provisional');
    expect(md).toContain("| Spent (all calls, including any cut-off run) | $29.10 |");
    expect(md).toContain("only 2 of 5 chores ran");
  });

  it("marks the cap without a cut-off chore when the cap was hit between chores", () => {
    const runs = [run("success", 3)];
    const md = renderMarkdown(summarize(runs, 5), runs, { ...META, planned: 5, stoppedByCap: true });
    expect(md).toContain("- Coverage: 1 of 5 chores — stopped by the $30 cost cap; this verdict is provisional");
  });

  it("lists run errors", () => {
    const runs = [run("success", 3), { ...run("api_error", 0, 1_000), chore: "mist the fern", error: "401 invalid x-api-key" }];
    const md = renderMarkdown(summarize(runs), runs, META);
    expect(md).toContain("## Errors\n\n- mist the fern: 401 invalid x-api-key\n");
  });

  it("has no Errors section when nothing failed with an error", () => {
    const runs = [run("success", 3)];
    expect(renderMarkdown(summarize(runs), runs, { ...META, planned: 1 })).not.toContain("## Errors");
  });
});
