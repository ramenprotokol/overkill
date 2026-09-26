import { MIN_CHAIN_PARTS } from "./constants.js";
import type { Blueprint } from "./blueprint.js";
import type { SimResult } from "./sim.js";

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
  // joinedAt[x] = the step at which x became part of the chain (-1 for the pushed ball).
  const joinedAt = new Map<string, number>([[root, -1]]);
  for (const e of sim.events) {
    if (parent.has(e.a) && !parent.has(e.b) && e.b in sim.parts && e.bMoves) {
      parent.set(e.b, e.a);
      joinedAt.set(e.b, e.step);
    } else if (parent.has(e.b) && !parent.has(e.a) && e.a in sim.parts && e.aMoves) {
      parent.set(e.a, e.b);
      joinedAt.set(e.a, e.step);
    }
  }
  const pathTo = (id: string): string[] => {
    const path: string[] = [];
    for (let cur: string | null | undefined = id; cur; cur = parent.get(cur)) path.unshift(cur);
    return path;
  };

  const hitBy = sim.finaleHit?.by ?? null;
  // A part only counts as "in the chain" for the finale hit if it had already joined
  // the chain by the step the finale was hit — joining later means the chain reached
  // it too late to take credit for a hit that already happened.
  const hitByChain = hitBy !== null && sim.finaleHit !== null && (joinedAt.get(hitBy) ?? Infinity) <= sim.finaleHit.step;
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
