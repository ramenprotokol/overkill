import { describe, expect, it } from "vitest";
import { preview } from "../../src/core/preview.js";
import { goldenDominoes } from "../fixtures/golden.js";

const boardRow = (board: string, row: number) => board.split("\n")[1 + row]!;

describe("preview", () => {
  it("passes the golden machine and draws it", () => {
    const p = preview(goldenDominoes);
    expect(p.ok).toBe(true);
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.board.split("\n")[0]).toBe("    0123456789012345");
    expect(boardRow(p.board, 9)).toBe(" 9  o..|||||F.......");
  });

  it("reports overlapping parts as errors and marks the shared cell", () => {
    const bp = structuredClone(goldenDominoes);
    bp.parts.push({ id: "d6", kind: "domino", col: 3, row: 9 });
    const p = preview(bp);
    expect(p.ok).toBe(false);
    expect(p.errors).toContain("d1 overlaps d6 by 0.20 cells");
    expect(boardRow(p.board, 9)).toBe(" 9  o..*||||F.......");
  });

  it("warns about a domino floating in mid-air with nothing in reach", () => {
    const bp = structuredClone(goldenDominoes);
    bp.parts.push({ id: "d6", kind: "domino", col: 12, row: 3 });
    const warnings = preview(bp).warnings;
    expect(warnings).toContain("d6 starts floating — it will fall as soon as the machine starts");
    expect(warnings).toContain("d6 has nothing within reach — when it falls it can't hit anything");
  });

  it("does not warn about balls in the air — dropping them can be the plan", () => {
    const bp = structuredClone(goldenDominoes);
    bp.parts.push({ id: "b2", kind: "ball", col: 12, row: 2, size: "s" });
    expect(preview(bp).warnings).toEqual([]);
  });

  it("draws a tilted plank across the cells it crosses", () => {
    const bp = structuredClone(goldenDominoes);
    bp.parts.push({ id: "p1", kind: "plank", col: 12, row: 4, length: 3, angle: 45, fixed: true });
    const board = preview(bp).board;
    expect(boardRow(board, 4)[4 + 12]).toBe("=");
    expect(boardRow(board, 3)[4 + 13]).toBe("=");
    expect(boardRow(board, 5)[4 + 11]).toBe("=");
  });

  it("returns validation errors and no board for invalid input", () => {
    const p = preview({ nonsense: true });
    expect(p.ok).toBe(false);
    expect(p.errors.length).toBeGreaterThan(0);
    expect(p.board).toBe("");
  });
});
