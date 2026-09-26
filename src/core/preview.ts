import { GRID_COLS, GRID_ROWS, OVERLAP_TOLERANCE } from "./constants.js";
import { parseBlueprint, type Blueprint } from "./blueprint.js";
import { blueprintBodies, penetration, worldShapes, type Body, type WorldShape } from "./geometry.js";

export interface PreviewResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  board: string;
}

/** Checks a blueprint without running physics. Never uses an attempt. */
export function preview(input: unknown): PreviewResult {
  const parsed = parseBlueprint(input);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [], board: "" };
  const bodies = blueprintBodies(parsed.blueprint);
  const errors = findOverlaps(bodies);
  const warnings = [...findFloating(bodies), ...findUnreachable(bodies)];
  return { ok: errors.length === 0, errors, warnings, board: renderBoard(parsed.blueprint) };
}

export function findOverlaps(bodies: Body[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i]!;
      const b = bodies[j]!;
      if (!a.dynamic && !b.dynamic) continue; // fixed things can't knock each other about
      let worst = -Infinity;
      for (const sa of worldShapes(a)) for (const sb of worldShapes(b)) worst = Math.max(worst, penetration(sa, sb));
      if (worst > OVERLAP_TOLERANCE) out.push(`${a.id} overlaps ${b.id} by ${worst.toFixed(2)} cells`);
    }
  }
  return out;
}

/** How far a part is nudged down to test whether anything holds it up. */
const SUPPORT_PROBE = 0.05;
/** A 1.6-tall domino falling sideways covers about this far either side of its centre. */
const DOMINO_REACH = 1.7;

/** Dominoes, buckets and loose planks with nothing under them. Balls may be dropped on purpose; seesaws hang on a pivot. */
export function findFloating(bodies: Body[]): string[] {
  const out: string[] = [];
  for (const b of bodies) {
    if (!b.dynamic || b.kind === "ball" || b.kind === "seesaw") continue;
    // Nudge the part down: if it now presses into anything, something is holding it up.
    const lowered = worldShapes({ ...b, y: b.y - SUPPORT_PROBE });
    const supported = bodies.some((o) => o.id !== b.id && worldShapes(o).some((s) => lowered.some((l) => penetration(l, s) > 0)));
    if (!supported) out.push(`${b.id} starts floating — it will fall as soon as the machine starts`);
  }
  return out;
}

/** Dominoes with nothing close enough to knock over when they fall. */
export function findUnreachable(bodies: Body[]): string[] {
  const out: string[] = [];
  for (const d of bodies) {
    if (d.kind !== "domino") continue;
    const [shape] = worldShapes(d);
    if (!shape || shape.type !== "box") continue;
    // The domino's own box, widened to everything it can sweep when it topples either way.
    const reach: WorldShape = { ...shape, hx: DOMINO_REACH };
    const near = bodies.some((o) => o.id !== d.id && o.kind !== "floor" && worldShapes(o).some((s) => penetration(reach, s) > 0));
    if (!near) out.push(`${d.id} has nothing within reach — when it falls it can't hit anything`);
  }
  return out;
}

const GLYPH = { ball: "o", domino: "|", plank: "=", seesaw: "^", bucket: "U" } as const;

export function renderBoard(bp: Blueprint): string {
  const grid = Array.from({ length: GRID_ROWS }, () => Array.from({ length: GRID_COLS }, () => "."));
  const mark = (col: number, row: number, glyph: string) => {
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return;
    grid[row]![col] = grid[row]![col] === "." ? glyph : "*";
  };
  for (const p of bp.parts) {
    if (p.kind === "plank" || p.kind === "seesaw") {
      const rad = p.kind === "plank" ? (p.angle * Math.PI) / 180 : 0;
      const cells = new Set<string>();
      for (let t = -p.length / 2; t <= p.length / 2 + 1e-9; t += 0.5) {
        // rows grow downward on the board, so a rising right end means a smaller row
        cells.add(`${Math.floor(p.col + 0.5 + t * Math.cos(rad))},${Math.floor(p.row + 0.5 - t * Math.sin(rad))}`);
      }
      for (const cell of cells) {
        const [c, r] = cell.split(",").map(Number);
        mark(c!, r!, GLYPH[p.kind]);
      }
    } else {
      mark(p.col, p.row, GLYPH[p.kind]);
    }
  }
  mark(bp.finale.col, bp.finale.row, "F");
  const header = "    " + Array.from({ length: GRID_COLS }, (_, i) => String(i % 10)).join("");
  const rows = grid.map((r, i) => `${String(i).padStart(2, " ")}  ${r.join("")}`);
  return [header, ...rows, "", "o ball  | domino  = plank  ^ seesaw  U bucket  F finale  * two things in one cell"].join("\n");
}
