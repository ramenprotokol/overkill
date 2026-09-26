import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics, runSim, type PartTrack, type SimEvent, type SimResult } from "../../src/core/sim.js";
import { analyze } from "../../src/core/trace.js";
import { dudMachine, goldenDominoes, lazyRoll, shortChain } from "../fixtures/golden.js";

const ev = (step: number, a: string, b: string, aMoves = true, bMoves = true): SimEvent => ({ step, a, b, aMoves, bMoves });
const track = (moved: boolean, minDistToFinale = 5, endY = 0.5): PartTrack => ({
  start: { x: 0, y: 0 }, end: { x: 0, y: endY }, moved, minDistToFinale,
});
const sim = (events: SimEvent[], parts: Record<string, PartTrack>, finaleHit: SimResult["finaleHit"] = null): SimResult => ({
  events, parts, finaleHit, steps: 1200, hash: "test", engine: "test",
});
const allMoved = { b1: track(true), d1: track(true), d2: track(true), d3: track(true), d4: track(true), d5: track(true) };

describe("analyze (hand-built traces)", () => {
  it("scores a full chain into the finale as success", () => {
    const r = analyze(goldenDominoes, sim(
      [ev(1, "b1", "d1"), ev(2, "d1", "d2"), ev(3, "d2", "d3"), ev(4, "d3", "d4"), ev(5, "d4", "d5"), ev(6, "d5", "finale", true, false)],
      allMoved,
      { step: 6, by: "d5" },
    ));
    expect(r.outcome).toBe("success");
    expect(r.success).toBe(true);
    expect(r.chain).toEqual(["b1", "d1", "d2", "d3", "d4", "d5"]);
    expect(r.overkillScore).toBe(6);
    expect(r.summary).toBe("Success: 6-part chain b1 → d1 → d2 → d3 → d4 → d5 → finale.");
  });

  it("calls a short chain that reaches the finale not overkill enough", () => {
    const r = analyze(goldenDominoes, sim([ev(1, "b1", "d1"), ev(2, "d1", "finale", true, false)], allMoved, { step: 2, by: "d1" }));
    expect(r.outcome).toBe("not_overkill");
    expect(r.overkillScore).toBe(0);
    expect(r.summary).toBe("Not overkill enough: b1 → d1 → finale is a 2-part chain; it needs at least 5.");
  });

  it("does not credit a finale hit by a part the chain never reached", () => {
    const r = analyze(goldenDominoes, sim([ev(1, "b1", "d1")], allMoved, { step: 9, by: "d3" }));
    expect(r.outcome).toBe("not_overkill");
    expect(r.chain).toEqual(["d3"]);
    expect(r.summary).toBe("Not overkill enough: d3 hit the finale on its own, before the chain reached it.");
  });

  it("does not credit a part that hit the finale before the chain reached it", () => {
    const r = analyze(goldenDominoes, sim(
      [ev(1, "d4", "finale", true, false), ev(10, "b1", "d1"), ev(20, "d1", "d2"), ev(30, "d2", "d3"), ev(40, "d3", "d4")],
      allMoved,
      { step: 1, by: "d4" },
    ));
    expect(r.outcome).toBe("not_overkill");
    expect(r.success).toBe(false);
    expect(r.chain).toEqual(["d4"]);
    expect(r.summary).toBe("Not overkill enough: d4 hit the finale on its own, before the chain reached it.");
  });

  it("credits a part that joined the chain on the same step it hit the finale", () => {
    const r = analyze(goldenDominoes, sim(
      [ev(1, "b1", "d1"), ev(2, "d1", "d2"), ev(3, "d2", "d3"), ev(4, "d3", "d4"), ev(5, "d4", "d5"), ev(5, "d5", "finale", true, false)],
      allMoved,
      { step: 5, by: "d5" },
    ));
    expect(r.outcome).toBe("success");
    expect(r.chain).toEqual(["b1", "d1", "d2", "d3", "d4", "d5"]);
  });

  it("only extends the chain when the hit part actually moves", () => {
    const r = analyze(goldenDominoes, sim([ev(1, "b1", "d1", true, false)], { ...allMoved, d1: track(false) }));
    expect(r.outcome).toBe("missed");
    expect(r.chain).toEqual(["b1"]);
    expect(r.stoppedAt).toBe("b1");
  });

  it("respects event order: a hit before a part joined the chain does not count", () => {
    const r = analyze(goldenDominoes, sim([ev(5, "d1", "d2"), ev(10, "b1", "d1")], allMoved));
    expect(r.chain).toEqual(["b1", "d1"]);
  });

  it("reports where a miss stopped, what came closest, what never moved and what fell off", () => {
    const r = analyze(goldenDominoes, sim(
      [ev(10, "b1", "d1"), ev(20, "d1", "d2")],
      { b1: track(true, 5, -3), d1: track(true, 3.2), d2: track(true, 1.44), d3: track(false, 0.9), d4: track(false), d5: track(false) },
    ));
    expect(r.outcome).toBe("missed");
    expect(r.stoppedAt).toBe("d2");
    expect(r.closest).toEqual({ part: "d2", cells: 1.4 });
    expect(r.neverMoved).toEqual(["d3", "d4", "d5"]);
    expect(r.fellOff).toEqual(["b1"]);
    expect(r.summary).toBe("Missed: the chain b1 → d1 → d2 stopped at d2. Closest to the finale: d2 at 1.4 cells.");
  });
});

describe("analyze (real physics)", () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it("scores the golden machine as a 6-part success", () => {
    const r = analyze(goldenDominoes, runSim(goldenDominoes));
    expect(r.outcome).toBe("success");
    expect(r.chain).toEqual(["b1", "d1", "d2", "d3", "d4", "d5"]);
  });

  it("scores a 3-part machine as not overkill enough", () => {
    const r = analyze(shortChain, runSim(shortChain));
    expect(r.outcome).toBe("not_overkill");
    expect(r.chain).toEqual(["b1", "d1", "d2"]);
  });

  it("scores the lazy roll as not overkill enough", () => {
    const r = analyze(lazyRoll, runSim(lazyRoll));
    expect(r.outcome).toBe("not_overkill");
    expect(r.chain).toEqual(["b1"]);
  });

  it("scores the dud as a miss with the ball off the board", () => {
    const r = analyze(dudMachine, runSim(dudMachine));
    expect(r.outcome).toBe("missed");
    expect(r.fellOff).toEqual(["b1"]);
    expect(r.neverMoved).toEqual(["d1", "d2", "d3", "d4", "d5"]);
  });
});
