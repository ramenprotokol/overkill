import type { Blueprint, Part } from "../../src/core/blueprint.js";
import { GRID_COLS, GRID_ROWS, SETTLE_STEPS } from "../../src/core/constants.js";
import { finaleBody, partBody, type Body } from "../../src/core/geometry.js";
import type { Frames } from "../../src/core/sim.js";
import type { AttemptReport } from "../../src/core/trace.js";
import { circle, hatch, line, rect, seeded, type Rand } from "./sketch.js";

const NS = "http://www.w3.org/2000/svg";
const MARGIN = 0.9;
/** How far below the floor the drawing reaches before parts that roll off the edge disappear. */
const BELOW = 1.1;

type Attrs = Record<string, string | number>;
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}
const path = (d: string, cls: string, parent: Element, extra: Attrs = {}) => el("path", { d, class: cls, ...extra }, parent);

/** World (metres, y up) to drawing units (cells, y down). */
const sy = (y: number) => GRID_ROWS - y;
const deg = (rad: number) => (-rad * 180) / Math.PI;

export interface RunView {
  frames: Frames;
  report: AttemptReport;
  /** Last frame worth playing: a little after the machine's last event. */
  endFrame: number;
}

export const frameOfStep = (step: number) => step + SETTLE_STEPS + 1;
export const stepOfFrame = (frame: number) => frame - SETTLE_STEPS - 1;

interface Timed {
  node: SVGGElement;
  frame: number;
}

export class Board {
  readonly svg: SVGSVGElement;
  private readonly title: SVGTitleElement;
  private readonly desc: SVGDescElement;
  private layers!: { fixed: SVGGElement; finale: SVGGElement; parts: SVGGElement; red: SVGGElement };
  private moving = new Map<string, SVGGElement>();
  private timed: Timed[] = [];
  private finaleIcon: SVGGElement | null = null;
  private finaleFrame = Infinity;
  private run: RunView | null = null;
  private joinedFrame = new Map<string, number>();

  constructor(host: HTMLElement) {
    const w = GRID_COLS + MARGIN * 2;
    const h = GRID_ROWS + MARGIN + BELOW;
    this.svg = el("svg", { viewBox: `${-MARGIN} ${-MARGIN} ${w} ${h}`, class: "board", role: "img", "aria-labelledby": "board-title board-desc" });
    this.title = el("title", { id: "board-title" }, this.svg);
    this.desc = el("desc", { id: "board-desc" }, this.svg);
    host.appendChild(this.svg);
    this.drawPaper();
  }

  /** The grid, its zone numbers and the floor: everything that is the same on every sheet. */
  private drawPaper(): void {
    const g = el("g", { class: "paper" }, this.svg);
    let minor = "";
    for (let c = 1; c < GRID_COLS; c++) minor += `M${c} 0V${GRID_ROWS}`;
    for (let r = 1; r < GRID_ROWS; r++) minor += `M0 ${r}H${GRID_COLS}`;
    path(minor, "grid", g);
    path(`M0 0H${GRID_COLS}V${GRID_ROWS}H0Z`, "grid-edge", g);
    // Zone references along the border, in the same numbers the model uses for cells.
    for (let c = 0; c < GRID_COLS; c++) el("text", { x: c + 0.5, y: -0.32, class: "zone" }, g).textContent = String(c);
    for (let r = 0; r < GRID_ROWS; r++) el("text", { x: -0.45, y: r + 0.62, class: "zone" }, g).textContent = String(r);
    const rnd = seeded("floor");
    path(line(rnd, -0.2, GRID_ROWS, GRID_COLS + 0.2, GRID_ROWS, 0.015), "ink floor", g);
    path(hatch(0, GRID_ROWS, GRID_COLS, 0.32, 0.22), "floor-hatch", g);
    this.layers = {
      fixed: el("g", { class: "fixed" }, this.svg),
      finale: el("g", { class: "finale" }, this.svg),
      parts: el("g", { class: "parts" }, this.svg),
      red: el("g", { class: "redline" }, this.svg),
    };
  }

  /** Lays out a blueprint as drawn, before any physics. `run` adds the motion and the redline. */
  show(bp: Blueprint | null, run: RunView | null, label: { title: string; desc: string }): void {
    for (const layer of Object.values(this.layers)) layer.replaceChildren();
    this.moving.clear();
    this.timed = [];
    this.joinedFrame.clear();
    this.finaleIcon = null;
    this.finaleFrame = Infinity;
    this.run = run;
    this.title.textContent = label.title;
    this.desc.textContent = label.desc;
    if (!bp) return;

    for (const p of bp.parts) {
      const body = partBody(p);
      const group = el("g", { class: `part ${p.kind}${body.dynamic ? "" : " is-fixed"}`, "data-id": p.id }, body.dynamic ? this.layers.parts : this.layers.fixed);
      drawPart(group, p, body, seeded(p.id));
      place(group, body.x, body.y, body.angle);
      if (body.dynamic) this.moving.set(p.id, group);
      if (p.kind === "seesaw") drawFulcrum(this.layers.fixed, body, seeded(`${p.id}-pivot`));
    }
    const fb = finaleBody(bp);
    this.finaleIcon = el("g", { class: `finale-icon ${bp.finale.kind}` }, this.layers.finale);
    drawFinale(this.finaleIcon, bp.finale.kind, seeded("finale"));
    place(this.finaleIcon, fb.x, fb.y, 0);
    // Name the finale: under the floor when it stands on the floor (the chain arrives from above), otherwise above it.
    const onFloor = bp.finale.row === GRID_ROWS - 1;
    const labelY = onFloor ? GRID_ROWS + 0.62 : sy(fb.y) - 0.62 > 0.2 ? sy(fb.y) - 0.62 : sy(fb.y) + 0.8;
    el("text", { x: clamp(fb.x, 0.5, GRID_COLS - 0.5), y: labelY, class: "finale-kind" }, this.layers.finale).textContent = bp.finale.kind.toUpperCase();

    if (run) this.annotate(bp, run, fb);
  }

  /** The redline: the push, each chain link and its balloon, the finale, and where a failed chain stopped. */
  private annotate(bp: Blueprint, run: RunView, fb: Body): void {
    const { report, frames } = run;
    const at = (id: string, frame: number) => pose(frames, id, frame);
    const rnd = seeded(`red-${bp.note}`);

    // The first push.
    const pushFrame = frameOfStep(0);
    const ball = at(bp.firstPush.ball, pushFrame);
    if (ball) {
      const dir = bp.firstPush.direction === "right" ? 1 : -1;
      const len = { soft: 0.7, medium: 1.0, hard: 1.3 }[bp.firstPush.strength];
      const g = this.timedGroup(pushFrame, "push");
      // Drawn behind the ball, pointing at it; when the ball sits at the edge of the board, drawn ahead of it instead.
      const behind = ball.x - dir * (len + 0.45);
      const [x0, x1] = behind > 0.1 && behind < GRID_COLS - 0.1 ? [behind, ball.x - dir * 0.4] : [ball.x + dir * 0.45, ball.x + dir * (len + 0.45)];
      arrow(g, rnd, x0, sy(ball.y), x1, sy(ball.y));
      el("text", { x: clamp((x0 + x1) / 2, 0.9, GRID_COLS - 0.9), y: sy(ball.y) - 0.22, class: "red-label" }, g).textContent = `PUSH · ${bp.firstPush.strength.toUpperCase()}`;
    }

    // Each chain link, balloon-numbered in chain order, drawn at the step the part joined.
    const chainIds = report.chain;
    for (const [id, step] of Object.entries(report.joinedAt)) this.joinedFrame.set(id, frameOfStep(step));
    chainIds.forEach((id, i) => {
      const frame = this.joinedFrame.get(id);
      if (frame === undefined) return; // a part that hit the finale on its own is not a link
      const me = at(id, frame);
      if (!me) return;
      const g = this.timedGroup(frame, "link");
      const parent = report.parents[id];
      const from = parent ? at(parent, frame) : null;
      if (from && Math.hypot(from.x - me.x, from.y - me.y) > 0.35) arrow(g, rnd, from.x, sy(from.y), me.x, sy(me.y), true);
      const bx = clamp(me.x + 0.55, 0.3, GRID_COLS - 0.3);
      const by = clamp(sy(me.y) - 0.62, 0.3, GRID_ROWS - 0.3);
      path2(g, line(rnd, me.x, sy(me.y), bx - 0.2, by + 0.14, 0.01), "red-stroke thin");
      el("circle", { cx: bx, cy: by, r: 0.26, class: "balloon" }, g);
      el("text", { x: bx, y: by + 0.1, class: "balloon-num" }, g).textContent = String(i + 1);
    });

    // The finale.
    if (report.finaleStep !== null) {
      this.finaleFrame = frameOfStep(report.finaleStep);
      if (report.success) {
        const g = this.timedGroup(this.finaleFrame, "finale-mark");
        path2(g, circle(rnd, fb.x, sy(fb.y), 0.62, 0.05), "red-stroke");
      }
    }

    // Where a missed chain stopped, and how close it came.
    if (report.outcome === "missed" && report.stoppedAt) {
      const end = run.endFrame;
      const stop = at(report.stoppedAt, end);
      if (stop) {
        const g = this.timedGroup(end, "stop");
        const x = stop.x;
        const y = sy(stop.y);
        path2(g, line(rnd, x - 0.22, y - 0.22, x + 0.22, y + 0.22, 0.02) + line(rnd, x - 0.22, y + 0.22, x + 0.22, y - 0.22, 0.02), "red-stroke");
        el("text", { x: clamp(x, 0.9, GRID_COLS - 0.9), y: y + 0.58, class: "red-label" }, g).textContent = "CHAIN STOPS";
      }
      if (report.closest) {
        const near = closestFrame(frames, report.closest.part, fb, run.endFrame);
        const p = near ? at(report.closest.part, near) : null;
        if (near && p) {
          const g = this.timedGroup(Math.max(near, frameOfStep(0)), "dimension");
          dimension(g, rnd, p.x, sy(p.y), fb.x, sy(fb.y), `${report.closest.cells.toFixed(1)} m`);
        }
      }
    }
  }

  private timedGroup(frame: number, cls: string): SVGGElement {
    const node = el("g", { class: `timed ${cls}` }, this.layers.red);
    this.timed.push({ node, frame });
    return node;
  }

  /** Draws the run at a (possibly fractional) frame. */
  render(position: number, animate: boolean): void {
    const run = this.run;
    if (!run) return;
    const { frames } = run;
    const f0 = Math.max(0, Math.min(frames.count - 1, Math.floor(position)));
    const f1 = Math.min(frames.count - 1, f0 + 1);
    const t = Math.min(1, Math.max(0, position - f0));
    frames.ids.forEach((id, i) => {
      const g = this.moving.get(id);
      if (!g) return;
      const a = (f0 * frames.ids.length + i) * 3;
      const b = (f1 * frames.ids.length + i) * 3;
      const x = lerp(frames.data[a]!, frames.data[b]!, t);
      const y = lerp(frames.data[a + 1]!, frames.data[b + 1]!, t);
      const ang = lerpAngle(frames.data[a + 2]!, frames.data[b + 2]!, t);
      place(g, x, y, ang);
      g.classList.toggle("joined", (this.joinedFrame.get(id) ?? Infinity) <= position);
    });
    for (const { node, frame } of this.timed) {
      const on = frame <= position;
      if (on && !node.classList.contains("on")) node.classList.toggle("instant", !animate);
      node.classList.toggle("on", on);
    }
    this.finaleIcon?.classList.toggle("hit", this.finaleFrame <= position);
    this.finaleIcon?.classList.toggle("instant", !animate);
  }

  /** Number of chain parts (along the reported chain) that have joined by this frame. */
  chainSoFar(position: number): number {
    const run = this.run;
    if (!run) return 0;
    return run.report.chain.filter((id) => (this.joinedFrame.get(id) ?? Infinity) <= position).length;
  }
}

function path2(parent: Element, d: string, cls: string): SVGPathElement {
  return path(d, cls, parent, { pathLength: 1 });
}

function place(g: SVGGElement, x: number, y: number, angle: number): void {
  g.setAttribute("transform", `translate(${x.toFixed(4)} ${sy(y).toFixed(4)}) rotate(${deg(angle).toFixed(3)})`);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function pose(frames: Frames, id: string, frame: number): { x: number; y: number; angle: number } | null {
  const i = frames.ids.indexOf(id);
  if (i < 0) return null;
  const f = Math.max(0, Math.min(frames.count - 1, frame));
  const o = (f * frames.ids.length + i) * 3;
  return { x: frames.data[o]!, y: frames.data[o + 1]!, angle: frames.data[o + 2]! };
}

/** The frame (after the push) at which a part came closest to the finale's centre. */
function closestFrame(frames: Frames, id: string, fb: Body, last: number): number | null {
  const i = frames.ids.indexOf(id);
  if (i < 0) return null;
  let best: number | null = null;
  let bestD = Infinity;
  for (let f = frameOfStep(0); f <= Math.min(last, frames.count - 1); f++) {
    const o = (f * frames.ids.length + i) * 3;
    const d = Math.hypot(frames.data[o]! - fb.x, frames.data[o + 1]! - fb.y);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

function arrow(g: Element, r: Rand, x1: number, y1: number, x2: number, y2: number, bowed = false): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const bow = bowed ? Math.min(0.5, len * 0.18) : 0;
  const mx = (x1 + x2) / 2 + uy * bow;
  const my = (y1 + y2) / 2 - ux * bow;
  path2(g, `M${x1.toFixed(3)} ${y1.toFixed(3)}Q${mx.toFixed(3)} ${my.toFixed(3)} ${x2.toFixed(3)} ${y2.toFixed(3)}`, "red-stroke");
  // Arrowhead along the curve's end tangent.
  const tx = x2 - mx;
  const ty = y2 - my;
  const tl = Math.hypot(tx, ty) || 1;
  const ax = tx / tl;
  const ay = ty / tl;
  const s = 0.2;
  const head = line(r, x2, y2, x2 - ax * s - ay * s * 0.55, y2 - ay * s + ax * s * 0.55, 0.01) + line(r, x2, y2, x2 - ax * s + ay * s * 0.55, y2 - ay * s - ax * s * 0.55, 0.01);
  path2(g, head, "red-stroke");
}

/** A drafting dimension: extension ticks, a double-headed line and the measured value. */
function dimension(g: Element, r: Rand, x1: number, y1: number, x2: number, y2: number, text: string): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.2) return;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const s = 0.16;
  let d = line(r, x1, y1, x2, y2, 0.008);
  for (const [px, py, sign] of [[x1, y1, 1], [x2, y2, -1]] as const) {
    d += line(r, px, py, px + sign * (ux * s - uy * s * 0.5), py + sign * (uy * s + ux * s * 0.5), 0.005);
    d += line(r, px, py, px + sign * (ux * s + uy * s * 0.5), py + sign * (uy * s - ux * s * 0.5), 0.005);
    d += line(r, px - uy * 0.2, py + ux * 0.2, px + uy * 0.2, py - ux * 0.2, 0.005);
  }
  path2(g, d, "red-stroke thin");
  el("text", { x: (x1 + x2) / 2 - uy * 0.3, y: (y1 + y2) / 2 + ux * 0.3 + 0.08, class: "red-label dim" }, g).textContent = text;
}

/** Draws a part around its body origin (local units, y down). */
function drawPart(g: SVGGElement, p: Part, body: Body, r: Rand): void {
  const ink = (d: string, cls = "ink") => path(d, cls, g);
  switch (p.kind) {
    case "ball": {
      const [s] = body.shapes;
      const rad = s!.type === "circle" ? s!.r : 0.3;
      el("circle", { r: rad, class: "fill" }, g);
      ink(circle(r, 0, 0, rad, 0.03));
      // Centre marks, which turn with the ball.
      ink(line(r, -rad * 0.55, 0, rad * 0.55, 0, 0.01) + line(r, 0, -rad * 0.55, 0, rad * 0.55, 0.01), "ink thin");
      break;
    }
    case "domino":
      el("rect", { x: -0.1, y: -0.8, width: 0.2, height: 1.6, class: "fill" }, g);
      ink(rect(r, -0.1, -0.8, 0.2, 1.6, 0.012));
      ink(line(r, -0.08, 0, 0.08, 0, 0.005), "ink thin");
      for (const y of [-0.45, 0.45]) el("circle", { cy: y, r: 0.035, class: "pip" }, g);
      break;
    case "plank":
    case "seesaw": {
      const hx = p.length / 2;
      el("rect", { x: -hx, y: -0.1, width: hx * 2, height: 0.2, class: "fill" }, g);
      if (p.kind === "plank" && p.fixed) path(hatch(-hx, -0.1, hx * 2, 0.2, 0.12), "hatch", g);
      ink(rect(r, -hx, -0.1, hx * 2, 0.2, 0.018));
      if (p.kind === "plank" && p.fixed) for (const x of [-hx + 0.18, hx - 0.18]) el("circle", { cx: x, r: 0.045, class: "bolt" }, g);
      if (p.kind === "seesaw") {
        el("circle", { r: 0.07, class: "pin" }, g);
        ink(line(r, -hx + 0.1, 0, -0.15, 0, 0.004) + line(r, 0.15, 0, hx - 0.1, 0, 0.004), "ink faint");
      }
      break;
    }
    case "bucket": {
      const pts: [number, number][] = [[-0.5, 0], [-0.5, -0.7], [-0.4, -0.7], [-0.4, -0.1], [0.4, -0.1], [0.4, -0.7], [0.5, -0.7], [0.5, 0]];
      el("path", { d: `M${pts.map((q) => q.join(" ")).join("L")}Z`, class: "fill" }, g);
      if (p.fixed) path(hatch(-0.5, -0.1, 1, 0.1, 0.1) + hatch(-0.5, -0.7, 0.1, 0.6, 0.1) + hatch(0.4, -0.7, 0.1, 0.6, 0.1), "hatch", g);
      let d = "";
      pts.forEach((q, i) => {
        const n = pts[(i + 1) % pts.length]!;
        d += line(r, q[0], q[1], n[0], n[1], 0.012);
      });
      ink(d);
      break;
    }
  }
}

/** The seesaw's fulcrum: a fixed bracket under the pivot. It's a symbol, not something parts can hit. */
function drawFulcrum(layer: SVGGElement, body: Body, r: Rand): void {
  const g = el("g", { class: "part fulcrum" }, layer);
  const x = body.x;
  const y = sy(body.y);
  path(line(r, x, y, x - 0.2, y + 0.36, 0.01) + line(r, x, y, x + 0.2, y + 0.36, 0.01) + line(r, x - 0.28, y + 0.36, x + 0.28, y + 0.36, 0.01), "ink thin", g);
}

/** The finale: a 0.4 × 0.8 bolted target, drawn as the thing the chore is about. */
function drawFinale(g: SVGGElement, kind: Blueprint["finale"]["kind"], r: Rand): void {
  const ink = (d: string, cls = "ink") => path(d, cls, g);
  el("rect", { x: -0.2, y: -0.4, width: 0.4, height: 0.8, class: "envelope" }, g);
  switch (kind) {
    case "switch": {
      el("rect", { x: -0.2, y: -0.4, width: 0.4, height: 0.8, class: "fill" }, g);
      ink(rect(r, -0.2, -0.4, 0.4, 0.8, 0.01));
      ink(rect(r, -0.06, -0.2, 0.12, 0.4, 0.005), "ink thin");
      for (const y of [-0.32, 0.32]) el("circle", { cy: y, r: 0.025, class: "pip" }, g);
      const lever = el("g", { class: "lever" }, g);
      path(line(r, 0, 0, 0, -0.26, 0.004), "ink thick", lever);
      el("circle", { cy: -0.27, r: 0.045, class: "knob" }, lever);
      break;
    }
    case "bowl": {
      ink(line(r, 0, 0.05, 0, 0.36, 0.005) + line(r, -0.16, 0.4, 0.16, 0.4, 0.008));
      el("path", { d: "M-0.3 -0.12Q0 0.2 0.3 -0.12Z", class: "fill" }, g);
      ink(`M-0.3 -0.12Q0 0.22 0.3 -0.12` + line(r, -0.33, -0.12, 0.33, -0.12, 0.008));
      const food = el("g", { class: "reward" }, g);
      for (const [x, y] of [[-0.12, -0.17], [0, -0.21], [0.12, -0.17], [-0.05, -0.13], [0.07, -0.13]] as const) el("circle", { cx: x, cy: y, r: 0.045, class: "kibble" }, food);
      break;
    }
    case "bell": {
      ink(line(r, -0.14, -0.4, 0.14, -0.4, 0.005) + line(r, 0, -0.4, 0, -0.3, 0.004));
      const bell = el("g", { class: "swing" }, g);
      el("path", { d: "M-0.2 0.26C-0.2 -0.05 -0.14 -0.3 0 -0.3C0.14 -0.3 0.2 -0.05 0.2 0.26Z", class: "fill" }, bell);
      path("M-0.2 0.26C-0.2 -0.05 -0.14 -0.3 0 -0.3C0.14 -0.3 0.2 -0.05 0.2 0.26" + line(r, -0.24, 0.26, 0.24, 0.26, 0.006), "ink", bell);
      el("circle", { cy: 0.33, r: 0.05, class: "knob" }, bell);
      const rings = el("g", { class: "reward" }, g);
      path("M0.32 -0.12Q0.4 0 0.32 0.12M0.42 -0.2Q0.54 0 0.42 0.2M-0.32 -0.12Q-0.4 0 -0.32 0.12M-0.42 -0.2Q-0.54 0 -0.42 0.2", "red-stroke thin static", rings);
      break;
    }
    case "door": {
      ink(rect(r, -0.2, -0.4, 0.4, 0.8, 0.008), "ink thin");
      const leaf = el("g", { class: "leaf" }, g);
      el("rect", { x: -0.2, y: -0.4, width: 0.4, height: 0.8, class: "fill" }, leaf);
      path(rect(r, -0.17, -0.37, 0.34, 0.74, 0.006), "ink", leaf);
      el("circle", { cx: 0.1, cy: 0.04, r: 0.03, class: "knob" }, leaf);
      const arc = el("g", { class: "reward" }, g);
      // The architectural door-swing symbol.
      path("M-0.2 0.4L-0.2 -0.4M-0.2 -0.4A0.8 0.8 0 0 0 0.37 0.17", "red-stroke thin static dashed", arc);
      break;
    }
    case "plant": {
      el("path", { d: "M-0.17 0.1L0.17 0.1L0.12 0.4L-0.12 0.4Z", class: "fill" }, g);
      ink(line(r, -0.17, 0.1, 0.17, 0.1, 0.006) + line(r, 0.17, 0.1, 0.12, 0.4, 0.006) + line(r, 0.12, 0.4, -0.12, 0.4, 0.006) + line(r, -0.12, 0.4, -0.17, 0.1, 0.006));
      const leaves = el("g", { class: "leaves" }, g);
      path("M0 0.1C0 -0.1 0.02 -0.25 0 -0.38M0 -0.05C-0.12 -0.08 -0.18 -0.18 -0.16 -0.28C-0.06 -0.24 -0.02 -0.14 0 -0.05M0.01 -0.16C0.12 -0.2 0.18 -0.3 0.16 -0.4C0.06 -0.36 0.02 -0.26 0.01 -0.16", "ink", leaves);
      const drops = el("g", { class: "reward" }, g);
      for (const [x, y] of [[-0.24, -0.5], [0.05, -0.62], [0.26, -0.48]] as const) el("path", { d: `M${x} ${y - 0.07}Q${x + 0.05} ${y} ${x} ${y + 0.03}Q${x - 0.05} ${y} ${x} ${y - 0.07}Z`, class: "drop" }, drops);
      break;
    }
  }
}
