import { describe, expect, it } from "vitest";
import { parseSpikeOptions } from "../../src/spike/options.js";

const DEFAULTS = { limit: "20", effort: "high", attempts: "12", "max-cost": "30", out: "results" };
const withFlag = (flag: keyof typeof DEFAULTS, value: string) => ({ ...DEFAULTS, [flag]: value });

describe("parseSpikeOptions", () => {
  it("parses the defaults to numbers", () => {
    expect(parseSpikeOptions(DEFAULTS)).toEqual({ limit: 20, effort: "high", maxAttempts: 12, maxCost: 30, out: "results" });
  });

  it("accepts a decimal cost", () => {
    expect(parseSpikeOptions(withFlag("max-cost", "5.0")).maxCost).toBe(5);
    expect(parseSpikeOptions(withFlag("max-cost", "12.5")).maxCost).toBe(12.5);
  });

  it.each(["$5", "5usd", "5,00", "abc", "0", "-1", "", "Infinity"])("rejects --max-cost %j", (value) => {
    expect(() => parseSpikeOptions(withFlag("max-cost", value))).toThrow("--max-cost");
  });

  it("names the flag, the accepted range and the bad value", () => {
    expect(() => parseSpikeOptions(withFlag("max-cost", "$5"))).toThrow(
      '--max-cost must be a positive number of US dollars, like 30 (got "$5")',
    );
  });

  it.each(["0", "21", "abc", "2.5", ""])("rejects --limit %j", (value) => {
    expect(() => parseSpikeOptions(withFlag("limit", value))).toThrow(/--limit .*1 and 20/);
  });

  it.each(["0", "31", "abc", "3.5", ""])("rejects --attempts %j", (value) => {
    expect(() => parseSpikeOptions(withFlag("attempts", value))).toThrow(/--attempts .*1 and 30/);
  });

  it("rejects an unknown effort", () => {
    expect(() => parseSpikeOptions(withFlag("effort", "hgih"))).toThrow(/--effort .*low, medium, high, xhigh, max/);
  });

  it("rejects an empty --out", () => {
    expect(() => parseSpikeOptions(withFlag("out", ""))).toThrow("--out");
  });
});
