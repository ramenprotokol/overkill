/**
 * Hand-drawn linework for the blueprint. Every wobble comes from a generator seeded by the part's id, so a machine
 * looks the same on every visit and every device. Coordinates are SVG units (1 unit = 1 cell, y down).
 */

export type Rand = () => number;

export function seeded(seed: string): Rand {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** One stroke from a to b with a slight bow and a little overshoot at each end, like a pen pulled along a rule. */
function stroke(r: Rand, x1: number, y1: number, x2: number, y2: number, wobble: number): string {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const over = () => (r() - 0.3) * wobble * 1.5;
  const sx = x1 - ux * over() + (r() - 0.5) * wobble;
  const sy = y1 - uy * over() + (r() - 0.5) * wobble;
  const ex = x2 + ux * over() + (r() - 0.5) * wobble;
  const ey = y2 + uy * over() + (r() - 0.5) * wobble;
  const bow = (r() - 0.5) * wobble * 2;
  const mx = (sx + ex) / 2 - uy * bow;
  const my = (sy + ey) / 2 + ux * bow;
  return `M${f(sx)} ${f(sy)}Q${f(mx)} ${f(my)} ${f(ex)} ${f(ey)}`;
}

/** A line drawn twice, slightly differently each time. */
export function line(r: Rand, x1: number, y1: number, x2: number, y2: number, wobble = 0.02): string {
  return stroke(r, x1, y1, x2, y2, wobble) + stroke(r, x1, y1, x2, y2, wobble);
}

export function rect(r: Rand, x: number, y: number, w: number, h: number, wobble = 0.02): string {
  return [
    line(r, x, y, x + w, y, wobble),
    line(r, x + w, y, x + w, y + h, wobble),
    line(r, x + w, y + h, x, y + h, wobble),
    line(r, x, y + h, x, y, wobble),
  ].join("");
}

/** A circle drawn in one loose pass that overlaps where it closes. */
export function circle(r: Rand, cx: number, cy: number, radius: number, wobble = 0.02): string {
  const n = 14;
  const start = r() * Math.PI * 2;
  const sweep = Math.PI * 2 * (1.06 + r() * 0.06);
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const a = start + (sweep * i) / n;
    const rr = radius + (r() - 0.5) * wobble;
    pts.push(`${f(cx + Math.cos(a) * rr)} ${f(cy + Math.sin(a) * rr)}`);
  }
  // Catmull-Rom through the points, as cubic Béziers.
  const xy = pts.map((p) => p.split(" ").map(Number) as [number, number]);
  let d = `M${pts[0]}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[Math.max(0, i - 1)]!;
    const p1 = xy[i]!;
    const p2 = xy[i + 1]!;
    const p3 = xy[Math.min(xy.length - 1, i + 2)]!;
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/** Evenly spaced 45° section lines clipped to a w × h box at (x, y): the drafting mark for "fixed, solid". */
export function hatch(x: number, y: number, w: number, h: number, gap = 0.16): string {
  let d = "";
  for (let t = gap / 2; t < w + h; t += gap) {
    // Line x + y = x0 + y0 + t, clipped to the box.
    const x1 = Math.max(0, t - h);
    const y1 = t - x1;
    const x2 = Math.min(w, t);
    const y2 = t - x2;
    if (x2 - x1 < 1e-3) continue;
    d += `M${f(x + x1)} ${f(y + y1)}L${f(x + x2)} ${f(y + y2)}`;
  }
  return d;
}
