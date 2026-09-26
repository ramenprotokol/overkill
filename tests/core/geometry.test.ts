import { describe, expect, it } from "vitest";
import {
  FLOOR, blueprintBodies, bodyRadius, cellBottom, cellCenter, containsPoint, partBody, penetration, worldShapes,
} from "../../src/core/geometry.js";
import { goldenDominoes } from "../fixtures/golden.js";

describe("cells", () => {
  it("maps cells to metres with row 0 at the top", () => {
    expect(cellCenter(0, 9)).toEqual({ x: 0.5, y: 0.5 });
    expect(cellCenter(15, 0)).toEqual({ x: 15.5, y: 9.5 });
    expect(cellBottom(3, 9)).toEqual({ x: 3.5, y: 0 });
  });
});

describe("parts", () => {
  it("stands a domino on the bottom of its cell", () => {
    const b = partBody({ id: "d1", kind: "domino", col: 3, row: 9 });
    expect(b.x).toBeCloseTo(3.5);
    expect(b.y).toBeCloseTo(0.8);
    expect(b.dynamic).toBe(true);
  });

  it("turns plank angles into radians and fixed planks into static bodies", () => {
    const b = partBody({ id: "p1", kind: "plank", col: 2, row: 5, length: 4, angle: 30, fixed: true });
    expect(b.angle).toBeCloseTo(Math.PI / 6);
    expect(b.dynamic).toBe(false);
    expect(b.shapes).toEqual([{ type: "box", x: 0, y: 0, hx: 2, hy: 0.1 }]);
  });

  it("gives a seesaw a pivot at its centre", () => {
    const b = partBody({ id: "s1", kind: "seesaw", col: 5, row: 7, length: 4 });
    expect(b.pivot).toEqual({ x: 5.5, y: 2.5 });
  });

  it("builds a bucket from a base and two walls", () => {
    expect(partBody({ id: "u1", kind: "bucket", col: 1, row: 9, fixed: true }).shapes).toHaveLength(3);
  });

  it("orders bodies floor, finale, then parts by id", () => {
    expect(blueprintBodies(goldenDominoes).map((b) => b.id)).toEqual(["floor", "finale", "b1", "d1", "d2", "d3", "d4", "d5"]);
  });
});

describe("penetration", () => {
  it("measures circle–circle overlap", () => {
    expect(penetration({ type: "circle", x: 0, y: 0, r: 1 }, { type: "circle", x: 1.5, y: 0, r: 1 })).toBeCloseTo(0.5);
  });

  it("reports separated boxes as negative", () => {
    const a = { type: "box", x: 0, y: 0, hx: 1, hy: 1, angle: 0 } as const;
    const b = { type: "box", x: 3, y: 0, hx: 1, hy: 1, angle: 0 } as const;
    expect(penetration(a, b)).toBeCloseTo(-1);
  });

  it("sees the gap between a rotated box and a box whose bounding boxes overlap", () => {
    const a = { type: "box", x: 0, y: 0, hx: 1, hy: 1, angle: Math.PI / 4 } as const;
    const b = { type: "box", x: 2.2, y: 2.2, hx: 1, hy: 1, angle: 0 } as const;
    expect(penetration(a, b)).toBeLessThan(0);
  });

  it("treats a ball resting on the floor as touching, not overlapping", () => {
    const ball = { type: "circle", x: 0.5, y: 0.3, r: 0.3 } as const;
    expect(penetration(ball, worldShapes(FLOOR)[0]!)).toBeCloseTo(0);
  });
});

describe("bodyRadius", () => {
  it("reaches the farthest point of each part", () => {
    expect(bodyRadius(partBody({ id: "b1", kind: "ball", col: 0, row: 0, size: "m" }))).toBeCloseTo(0.3);
    expect(bodyRadius(partBody({ id: "d1", kind: "domino", col: 0, row: 9 }))).toBeCloseTo(Math.hypot(0.1, 0.8));
    expect(bodyRadius(partBody({ id: "s1", kind: "seesaw", col: 5, row: 7, length: 4 }))).toBeCloseTo(Math.hypot(2, 0.1));
    expect(bodyRadius(partBody({ id: "u1", kind: "bucket", col: 1, row: 9, fixed: false }))).toBeCloseTo(Math.hypot(0.45, 0.4) + Math.hypot(0.05, 0.3));
  });
});

describe("containsPoint", () => {
  it("respects box rotation", () => {
    const s = { type: "box", x: 0, y: 0, hx: 2, hy: 0.1, angle: Math.PI / 2 } as const;
    expect(containsPoint(s, 0, 1.5)).toBe(true);
    expect(containsPoint(s, 1.5, 0)).toBe(false);
  });
});
