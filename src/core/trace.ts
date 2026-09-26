import { JOIN_SLACK, MIN_CHAIN_PARTS, MOVE_WINDOW } from "./constants.js";
import type { Blueprint } from "./blueprint.js";
import { runSim, type SimResult } from "./sim.js";

/** First step in [from, to] at which the part was moving, if any. */
function firstMovingIn(sim: SimResult, id: string, from: number, to: number): number | undefined {
  let first: number | undefined;
  for (const [start, end] of sim.moving[id] ?? []) {
    const t = Math.max(from, start);
    if (t < end && t <= to && (first === undefined || t < first)) first = t;
  }
  return first;
}

/**
 * Every touch of the finale by a part that was moving at the time, with the step it counts from. Resting against
 * the finale doesn't count. The impact itself can stop the part within the contact step, so its motion is looked
 * for one step earlier. Includes touches while the machine settles (negative steps).
 */
function movingFinaleTouches(sim: SimResult): { by: string; step: number }[] {
  const out: { by: string; step: number }[] = [];
  for (const c of sim.contacts) {
    if (c.a !== "finale" && c.b !== "finale") continue;
    const by = c.a === "finale" ? c.b : c.a;
    const moving = firstMovingIn(sim, by, c.from - 1, c.to);
    if (moving !== undefined) out.push({ by, step: Math.max(moving, c.from) });
  }
  return out;
}

/**
 * True when the machine hits the finale without the first push: a replay with no push in which any part moves into
 * the finale, at any step, settling included. A machine like that does the chore on its own, so a success with the
 * push shouldn't be credited to the chain.
 */
export function finaleTriggeredWithoutPush(bp: Blueprint): boolean {
  return movingFinaleTouches(runSim(bp, undefined, { push: false })).length > 0;
}

export type Outcome = "success" | "not_overkill" | "missed";

export interface AttemptReport {
  outcome: Outcome;
  success: boolean;
  /** Path from the pushed ball to the part that hit the finale — or to where the chain stopped. */
  chain: string[];
  /** Chain length on success, otherwise 0. */
  overkillScore: number;
  finaleHitBy: string | null;
  stoppedAt: string | null;
  closest: { part: string; cells: number } | null;
  neverMoved: string[];
  fellOff: string[];
  summary: string;
}

export function analyze(bp: Blueprint, sim: SimResult): AttemptReport {
  const root = bp.firstPush.ball;
  // parent[x] = the chain part that set x off (null for the pushed ball). Map order = order parts joined.
  const parent = new Map<string, string | null>([[root, null]]);
  const joinedAt = new Map<string, number>([[root, 0]]);

  // Grow the chain earliest-first until nothing else can join. A part joins from a chain part it is touching —
  // a fresh hit or a resting contact — when it starts moving during that contact or within MOVE_WINDOW steps after.
  // Parts already moving on their own can't join: they have no new start. The machine settles before the push
  // (step 0), so a part may be seen moving up to JOIN_SLACK steps before the part that set it off — motion is
  // sampled per body, and nothing is allowed to join before the push itself.
  for (;;) {
    let next: { id: string; from: string; fromJoined: number; step: number } | null = null;
    for (const c of sim.contacts) {
      for (const [x, y] of [[c.a, c.b], [c.b, c.a]] as const) {
        const xJoined = joinedAt.get(x);
        if (xJoined === undefined || joinedAt.has(y) || !(y in sim.parts)) continue;
        const from = Math.max(c.from, xJoined - JOIN_SLACK, 0); // nothing joins before the push
        if (from > c.to) continue;
        const onset = (sim.moving[y] ?? []).map(([start]) => start).find((s) => s >= from && s <= c.to + MOVE_WINDOW);
        if (onset === undefined) continue;
        const better = !next || onset < next.step || (onset === next.step && (y < next.id || (y === next.id && (xJoined < next.fromJoined || (xJoined === next.fromJoined && x < next.from)))));
        if (better) next = { id: y, from: x, fromJoined: xJoined, step: onset };
      }
    }
    if (!next) break;
    parent.set(next.id, next.from);
    joinedAt.set(next.id, next.step);
  }

  const pathTo = (id: string): string[] => {
    const path: string[] = [];
    for (let cur: string | null | undefined = id; cur; cur = parent.get(cur)) path.unshift(cur);
    return path;
  };

  // The chore happens the first time a moving part touches the finale.
  // It only counts for the machine if that part had already joined the chain by then.
  let trigger: { by: string; step: number; inChain: boolean } | null = null;
  for (const { by: p, step } of movingFinaleTouches(sim)) {
    const inChain = (joinedAt.get(p) ?? Infinity) <= step;
    const better = !trigger || step < trigger.step || (step === trigger.step && (inChain !== trigger.inChain ? inChain : p < trigger.by));
    if (better) trigger = { by: p, step, inChain };
  }
  const hitBy = trigger?.by ?? null;
  const hitByChain = trigger?.inChain ?? false;
  let chain: string[];
  let outcome: Outcome;
  if (hitBy !== null && hitByChain) {
    chain = pathTo(hitBy);
    outcome = chain.length >= MIN_CHAIN_PARTS ? "success" : "not_overkill";
  } else if (hitBy !== null) {
    chain = [hitBy];
    outcome = "not_overkill";
  } else {
    chain = [];
    for (const id of parent.keys()) {
      const p = pathTo(id);
      if (p.length >= chain.length) chain = p; // ties go to the part that joined later
    }
    outcome = "missed";
  }

  let closestId: string | null = null;
  for (const id of parent.keys()) {
    const t = sim.parts[id];
    if (t && (closestId === null || t.minDistToFinale < sim.parts[closestId]!.minDistToFinale)) closestId = id;
  }
  const closest = closestId === null ? null : { part: closestId, cells: Math.round(sim.parts[closestId]!.minDistToFinale * 10) / 10 };

  const ids = Object.keys(sim.parts).sort();
  const success = outcome === "success";
  const report: Omit<AttemptReport, "summary"> = {
    outcome,
    success,
    chain,
    overkillScore: success ? chain.length : 0,
    finaleHitBy: hitBy,
    stoppedAt: outcome === "missed" ? (chain.at(-1) ?? null) : null,
    closest,
    neverMoved: ids.filter((id) => !sim.parts[id]!.moved),
    fellOff: ids.filter((id) => sim.parts[id]!.end.y < -1),
  };
  return { ...report, summary: summarize(report, hitByChain) };
}

function summarize(r: Omit<AttemptReport, "summary">, hitByChain: boolean): string {
  const path = r.chain.join(" → ");
  if (r.outcome === "success") return `Success: ${r.chain.length}-part chain ${path} → finale.`;
  if (r.outcome === "not_overkill") {
    if (!hitByChain) return `Not overkill enough: ${r.finaleHitBy} hit the finale on its own, before the chain reached it.`;
    return `Not overkill enough: ${path} → finale is a ${r.chain.length}-part chain; it needs at least ${MIN_CHAIN_PARTS}.`;
  }
  const closest = r.closest ? ` Closest to the finale: ${r.closest.part} at ${r.closest.cells} cells.` : "";
  return `Missed: the chain ${path} stopped at ${r.stoppedAt}.${closest}`;
}
