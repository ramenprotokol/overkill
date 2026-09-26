import { GRID_COLS, GRID_ROWS } from "./constants.js";
import type { Blueprint, Part } from "./blueprint.js";

/** A collision shape, offset from its body's origin (before rotation). */
export type Shape =
  | { type: "circle"; x: number; y: number; r: number }
  | { type: "box"; x: number; y: number; hx: number; hy: number };

/** A shape placed in the world (metres, y up). */
export type WorldShape =
  | { type: "circle"; x: number; y: number; r: number }
  | { type: "box"; x: number; y: number; hx: number; hy: number; angle: number };

export interface Body {
  id: string;
  kind: Part["kind"] | "finale" | "floor";
  x: number;
  y: number;
  /** Radians, counter-clockwise. */
  angle: number;
  dynamic: boolean;
  shapes: Shape[];
  /** Seesaws rotate around this world point. */
  pivot?: { x: number; y: number };
}

export const BALL_RADIUS = { s: 0.2, m: 0.3, l: 0.4 } as const;
const DOMINO = { hx: 0.1, hy: 0.8 };
const PLANK_HY = 0.1;
const FINALE = { hx: 0.2, hy: 0.4 };

export const FLOOR: Body = {
  id: "floor", kind: "floor", x: GRID_COLS / 2, y: -0.5, angle: 0, dynamic: false,
  shapes: [{ type: "box", x: 0, y: 0, hx: GRID_COLS / 2, hy: 0.5 }],
};

export function cellCenter(col: number, row: number): { x: number; y: number } {
  return { x: col + 0.5, y: GRID_ROWS - row - 0.5 };
}

export function cellBottom(col: number, row: number): { x: number; y: number } {
  return { x: col + 0.5, y: GRID_ROWS - row - 1 };
}

export function partBody(p: Part): Body {
  switch (p.kind) {
    case "ball": {
      const c = cellCenter(p.col, p.row);
      return { id: p.id, kind: p.kind, x: c.x, y: c.y, angle: 0, dynamic: true, shapes: [{ type: "circle", x: 0, y: 0, r: BALL_RADIUS[p.size] }] };
    }
    case "domino": {
      const b = cellBottom(p.col, p.row);
      return { id: p.id, kind: p.kind, x: b.x, y: b.y + DOMINO.hy, angle: 0, dynamic: true, shapes: [{ type: "box", x: 0, y: 0, ...DOMINO }] };
    }
    case "plank": {
      const c = cellCenter(p.col, p.row);
      return {
        id: p.id, kind: p.kind, x: c.x, y: c.y, angle: (p.angle * Math.PI) / 180, dynamic: !p.fixed,
        shapes: [{ type: "box", x: 0, y: 0, hx: p.length / 2, hy: PLANK_HY }],
      };
    }
    case "seesaw": {
      const c = cellCenter(p.col, p.row);
      return {
        id: p.id, kind: p.kind, x: c.x, y: c.y, angle: 0, dynamic: true,
        shapes: [{ type: "box", x: 0, y: 0, hx: p.length / 2, hy: PLANK_HY }],
        pivot: { x: c.x, y: c.y },
      };
    }
    case "bucket": {
      const b = cellBottom(p.col, p.row);
      return {
        id: p.id, kind: p.kind, x: b.x, y: b.y, angle: 0, dynamic: !p.fixed,
        shapes: [
          { type: "box", x: 0, y: 0.05, hx: 0.5, hy: 0.05 },
          { type: "box", x: -0.45, y: 0.4, hx: 0.05, hy: 0.3 },
          { type: "box", x: 0.45, y: 0.4, hx: 0.05, hy: 0.3 },
        ],
      };
    }
  }
}

export function finaleBody(bp: Blueprint): Body {
  const b = cellBottom(bp.finale.col, bp.finale.row);
  return { id: "finale", kind: "finale", x: b.x, y: b.y + FINALE.hy, angle: 0, dynamic: false, shapes: [{ type: "box", x: 0, y: 0, ...FINALE }] };
}

/** Canonical order (floor, finale, parts by id) so every run inserts bodies identically. */
export function blueprintBodies(bp: Blueprint): Body[] {
  const parts = [...bp.parts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(partBody);
  return [FLOOR, finaleBody(bp), ...parts];
}

/** Distance from the body's origin to its farthest point, so |v| + |ω|·radius bounds how fast any point of it moves. */
export function bodyRadius(b: Body): number {
  return Math.max(...b.shapes.map((s) => Math.hypot(s.x, s.y) + (s.type === "circle" ? s.r : Math.hypot(s.hx, s.hy))));
}

export function worldShapes(b: Body): WorldShape[] {
  const cos = Math.cos(b.angle);
  const sin = Math.sin(b.angle);
  return b.shapes.map((s): WorldShape => {
    const x = b.x + s.x * cos - s.y * sin;
    const y = b.y + s.x * sin + s.y * cos;
    return s.type === "circle" ? { type: "circle", x, y, r: s.r } : { type: "box", x, y, hx: s.hx, hy: s.hy, angle: b.angle };
  });
}

type Circle = Extract<WorldShape, { type: "circle" }>;
type Box = Extract<WorldShape, { type: "box" }>;

/** How deeply two shapes overlap: positive = overlapping, 0 = touching, negative = gap. */
export function penetration(a: WorldShape, b: WorldShape): number {
  if (a.type === "circle" && b.type === "circle") return a.r + b.r - Math.hypot(a.x - b.x, a.y - b.y);
  if (a.type === "circle" && b.type === "box") return circleBox(a, b);
  if (a.type === "box" && b.type === "circle") return circleBox(b, a);
  return boxBox(a as Box, b as Box);
}

function toLocal(b: Box, px: number, py: number): { x: number; y: number } {
  const cos = Math.cos(-b.angle);
  const sin = Math.sin(-b.angle);
  const dx = px - b.x;
  const dy = py - b.y;
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

function circleBox(c: Circle, b: Box): number {
  const l = toLocal(b, c.x, c.y);
  const qx = Math.max(-b.hx, Math.min(b.hx, l.x));
  const qy = Math.max(-b.hy, Math.min(b.hy, l.y));
  if (qx === l.x && qy === l.y) return c.r + Math.min(b.hx - Math.abs(l.x), b.hy - Math.abs(l.y));
  return c.r - Math.hypot(l.x - qx, l.y - qy);
}

/** Separating-axis test for two rotated boxes; returns the smallest overlap across the four axes. */
function boxBox(a: Box, b: Box): number {
  let min = Infinity;
  for (const theta of [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2]) {
    const ax = Math.cos(theta);
    const ay = Math.sin(theta);
    const pa = project(a, ax, ay);
    const pb = project(b, ax, ay);
    min = Math.min(min, Math.min(pa.max, pb.max) - Math.max(pa.min, pb.min));
  }
  return min;
}

function project(b: Box, ax: number, ay: number): { min: number; max: number } {
  const c = b.x * ax + b.y * ay;
  const r = b.hx * Math.abs(Math.cos(b.angle) * ax + Math.sin(b.angle) * ay)
    + b.hy * Math.abs(-Math.sin(b.angle) * ax + Math.cos(b.angle) * ay);
  return { min: c - r, max: c + r };
}

export function containsPoint(s: WorldShape, px: number, py: number): boolean {
  if (s.type === "circle") return Math.hypot(px - s.x, py - s.y) <= s.r;
  const l = toLocal(s, px, py);
  return Math.abs(l.x) <= s.hx && Math.abs(l.y) <= s.hy;
}
