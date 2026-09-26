import { describe, expect, it } from "vitest";
import { blueprintJsonSchema, parseBlueprint } from "../../src/core/blueprint.js";
import { goldenDominoes } from "../fixtures/golden.js";

const errorsOf = (input: unknown): string => {
  const r = parseBlueprint(input);
  if (r.ok) throw new Error("expected the blueprint to be rejected");
  return r.errors.join("\n");
};

describe("parseBlueprint", () => {
  it("accepts the golden domino machine", () => {
    const r = parseBlueprint(goldenDominoes);
    expect(r.ok).toBe(true);
  });

  it("rejects parts outside the grid", () => {
    const bad = structuredClone(goldenDominoes);
    bad.parts[0]!.col = 16;
    expect(errorsOf(bad)).toMatch(/parts\.0\.col/);
  });

  it("rejects plank angles that are not multiples of 15", () => {
    const bad = structuredClone(goldenDominoes) as { parts: unknown[] };
    bad.parts.push({ id: "p1", kind: "plank", col: 10, row: 5, length: 2, angle: 20, fixed: true });
    expect(errorsOf(bad)).toMatch(/angle/);
  });

  it("rejects duplicate ids", () => {
    const bad = structuredClone(goldenDominoes);
    bad.parts[1]!.id = "b1";
    expect(errorsOf(bad)).toContain('parts: duplicate id "b1"');
  });

  it("rejects a first push aimed at something that is not a ball", () => {
    const bad = structuredClone(goldenDominoes);
    bad.firstPush.ball = "d1";
    expect(errorsOf(bad)).toContain('firstPush.ball: "d1" is a domino; the first push must hit a ball');
  });

  it("rejects a first push aimed at a missing part", () => {
    const bad = structuredClone(goldenDominoes);
    bad.firstPush.ball = "b9";
    expect(errorsOf(bad)).toContain('firstPush.ball: no part with id "b9"');
  });

  it("rejects unknown fields", () => {
    const bad = structuredClone(goldenDominoes);
    (bad.parts[0] as Record<string, unknown>).color = "red";
    expect(errorsOf(bad)).toMatch(/parts\.0/);
  });

  it("rejects more than 25 parts", () => {
    const bad = structuredClone(goldenDominoes);
    for (let i = 0; i < 25; i++) bad.parts.push({ id: `x${i}`, kind: "domino", col: i % 16, row: 0 });
    expect(errorsOf(bad)).toMatch(/parts/);
  });

  it("rejects the ids the simulator reserves", () => {
    const bad = structuredClone(goldenDominoes);
    bad.parts[1]!.id = "finale";
    expect(errorsOf(bad)).toContain('parts: "finale" is a reserved id');
  });
});

describe("blueprintJsonSchema", () => {
  it("is a plain object schema without $schema, for the tool definition", () => {
    const s = blueprintJsonSchema();
    expect(s.$schema).toBeUndefined();
    expect(s.type).toBe("object");
    expect(Object.keys(s.properties as object)).toEqual(["note", "finale", "firstPush", "parts"]);
  });
});
