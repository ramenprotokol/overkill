import { describe, expect, it } from "vitest";
import { addUsage, costUsd, emptyUsage } from "../../src/agent/cost.js";
import { formatInvalid, formatPreview, formatReport } from "../../src/agent/format.js";
import { SYSTEM_PROMPT, TOOLS, userPrompt } from "../../src/agent/prompt.js";
import { blueprintJsonSchema } from "../../src/core/blueprint.js";
import type { AttemptReport } from "../../src/core/trace.js";

const missed: AttemptReport = {
  outcome: "missed", success: false, chain: ["b1", "d1"], overkillScore: 0, finaleHitBy: null, stoppedAt: "d1",
  closest: { part: "d1", cells: 2.1 }, neverMoved: ["d2", "d3"], fellOff: ["b1"],
  summary: "Missed: the chain b1 → d1 stopped at d1. Closest to the finale: d1 at 2.1 cells.",
};

describe("formatReport", () => {
  it("gives the model the outcome, summary, loose ends and attempts left", () => {
    expect(formatReport(3, 12, missed)).toBe([
      "Attempt 3 of 12: MISSED",
      "Missed: the chain b1 → d1 stopped at d1. Closest to the finale: d1 at 2.1 cells.",
      "Never moved: d2, d3.",
      "Fell off the board: b1.",
      "Attempts left: 9.",
    ].join("\n"));
  });

  it("reports a success without loose ends or attempts left", () => {
    const won: AttemptReport = {
      outcome: "success", success: true, chain: ["b1", "d1", "d2", "d3", "d4", "d5"], overkillScore: 6, finaleHitBy: "d5", stoppedAt: null,
      closest: { part: "d5", cells: 0 }, neverMoved: [], fellOff: [],
      summary: "Success: 6-part chain b1 → d1 → d2 → d3 → d4 → d5 → finale.",
    };
    expect(formatReport(4, 12, won)).toBe("Attempt 4 of 12: SUCCESS\nSuccess: 6-part chain b1 → d1 → d2 → d3 → d4 → d5 → finale.");
  });

  it("writes not_overkill as two words", () => {
    expect(formatReport(1, 12, { ...missed, outcome: "not_overkill" }).split("\n")[0]).toBe("Attempt 1 of 12: NOT OVERKILL");
  });
});

describe("formatInvalid", () => {
  it("says the attempt was used and lists the errors", () => {
    expect(formatInvalid(2, 12, ["parts.0.col: Too big"])).toBe(
      "Attempt 2 of 12: INVALID blueprint (the attempt is used).\n- parts.0.col: Too big\nAttempts left: 10.",
    );
  });
});

describe("formatPreview", () => {
  it("shows errors, warnings and the board", () => {
    const text = formatPreview({ ok: false, errors: ["d1 overlaps d2 by 0.20 cells"], warnings: ["d3 starts floating"], board: "BOARD" });
    expect(text).toBe("Preview (no attempt used).\nErrors:\n- d1 overlaps d2 by 0.20 cells\nWarnings:\n- d3 starts floating\nBoard:\nBOARD");
  });

  it("says when there are no errors", () => {
    expect(formatPreview({ ok: true, errors: [], warnings: [], board: "B" })).toBe("Preview (no attempt used).\nErrors: none.\nBoard:\nB");
  });
});

describe("cost", () => {
  it("adds API usage, treating missing cache fields as zero", () => {
    const u = addUsage(emptyUsage(), { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: 7 });
    expect(u).toEqual({ input: 10, output: 5, cacheWrite: 0, cacheRead: 7 });
  });

  it("adds usage twice when the cache fields are absent", () => {
    const u = addUsage(addUsage(emptyUsage(), { input_tokens: 10, output_tokens: 5 }), { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 });
    expect(u).toEqual({ input: 11, output: 7, cacheWrite: 0, cacheRead: 3 });
  });

  it("prices Opus 5.5 tokens", () => {
    expect(costUsd({ input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 })).toBeCloseTo(4 + 20 + 5 + 0.2);
  });
});

describe("prompt", () => {
  it("defines preview and simulate with the blueprint schema", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["preview", "simulate"]);
    expect(TOOLS[0]!.input_schema.type).toBe("object");
  });

  it("gives both tools the same generated schema", () => {
    expect(TOOLS[0]!.input_schema).toEqual(blueprintJsonSchema());
    expect(TOOLS[1]!.input_schema).toEqual(blueprintJsonSchema());
  });

  it("states the overkill rule and the grid in the system prompt", () => {
    expect(SYSTEM_PROMPT).toContain("at least 5 parts");
    expect(SYSTEM_PROMPT).toContain("16 columns");
    expect(SYSTEM_PROMPT).toContain("settles for one second");
    expect(SYSTEM_PROMPT).toContain("Only the first moving thing to touch the finale counts");
    expect(SYSTEM_PROMPT).toContain("The machine must need the push");
    expect(SYSTEM_PROMPT).toContain('not an entry in "parts"');
    expect(SYSTEM_PROMPT).toContain("up to 140 characters");
    expect(SYSTEM_PROMPT).not.toContain("facing");
  });

  it("says fixed parts never join the chain and names the reserved ids", () => {
    expect(SYSTEM_PROMPT).toContain("starts moving. Fixed planks and fixed buckets never move, so they never join the chain or count toward it.");
    expect(SYSTEM_PROMPT).toContain('## Parts (entries in "parts", each with a unique short id such as b1, d3, p2) (ids "finale" and "floor" are reserved)');
  });

  it("wraps the chore as untrusted data and strips angle brackets", () => {
    expect(userPrompt("feed <the> cat", 12, 3)).toBe(
      "Chore (untrusted text from a visitor): <chore>feed the cat</chore>\n\nYou have 12 attempts, and up to 3 previews before each one. Design the most overkill machine that still works.",
    );
  });
});
