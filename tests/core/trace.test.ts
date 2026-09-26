import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics, runSim, type Contact, type PartTrack, type SimResult } from "../../src/core/sim.js";
import { analyze } from "../../src/core/trace.js";
import { dudMachine, goldenDominoes, lazyRoll, shortChain } from "../fixtures/golden.js";

type Spans = [number, number][];
const touch = (a: string, b: string, from: number, to = from + 5): Contact => (a < b ? { a, b, from, to } : { a: b, b: a, from, to });
const track = (moved: boolean, minDistToFinale = 5, endY = 0.5): PartTrack => ({
  start: { x: 0, y: 0 }, end: { x: 0, y: endY }, moved, minDistToFinale,
});
const sim = (contacts: Contact[], moving: Record<string, Spans>, parts: Record<string, PartTrack> = {}): SimResult => ({
  events: [], contacts, moving,
  parts: { ...Object.fromEntries(Object.entries(moving).map(([id, spans]) => [id, track(spans.length > 0)])), ...parts },
  finaleHit: null, steps: 1200, hash: "test", engine: "test",
});
const idle: Record<string, Spans> = { b1: [], d1: [], d2: [], d3: [], d4: [], d5: [] };

describe("analyze (hand-built traces)", () => {
  it("scores a full chain into the finale as success", () => {
    const r = analyze(goldenDominoes, sim(
      [touch("b1", "d1", 10), touch("d1", "d2", 20), touch("d2", "d3", 30), touch("d3", "d4", 40), touch("d4", "d5", 50), touch("d5", "finale", 60)],
      { b1: [[0, 100]], d1: [[10, 80]], d2: [[20, 90]], d3: [[30, 100]], d4: [[40, 110]], d5: [[50, 120]] },
    ));
    expect(r.outcome).toBe("success");
    expect(r.success).toBe(true);
    expect(r.chain).toEqual(["b1", "d1", "d2", "d3", "d4", "d5"]);
    expect(r.overkillScore).toBe(6);
    expect(r.summary).toBe("Success: 6-part chain b1 → d1 → d2 → d3 → d4 → d5 → finale.");
  });

  it("calls a short chain that reaches the finale not overkill enough", () => {
    const r = analyze(goldenDominoes, sim([touch("b1", "d1", 10), touch("d1", "finale", 20)], { ...idle, b1: [[0, 50]], d1: [[10, 60]] }));
    expect(r.outcome).toBe("not_overkill");
    expect(r.overkillScore).toBe(0);
    expect(r.summary).toBe("Not overkill enough: b1 → d1 → finale is a 2-part chain; it needs at least 5.");
  });

  it("does not credit a finale hit by a part the chain never reached", () => {
    const r = analyze(goldenDominoes, sim([touch("b1", "d1", 10), touch("d3", "finale", 9)], { ...idle, b1: [[0, 50]], d1: [[10, 60]], d3: [[0, 40]] }));
    expect(r.outcome).toBe("not_overkill");
    expect(r.chain).toEqual(["d3"]);
    expect(r.summary).toBe("Not overkill enough: d3 hit the finale on its own, before the chain reached it.");
  });

  it("does not credit a part that hit the finale before the chain reached it", () => {
    const r = analyze(goldenDominoes, sim(
      [touch("d4", "finale", 1), touch("b1", "d1", 10), touch("d1", "d2", 20), touch("d2", "d3", 30), touch("d3", "d4", 40)],
      { ...idle, b1: [[0, 100]], d1: [[10, 100]], d2: [[20, 100]], d3: [[30, 100]], d4: [[1, 5], [40, 100]] },
    ));
    expect(r.outcome).toBe("not_overkill");
    expect(r.success).toBe(false);
    expect(r.chain).toEqual(["d4"]);
    expect(r.summary).toBe("Not overkill enough: d4 hit the finale on its own, before the chain reached it.");
  });

  it("credits a part that joined the chain on the same step it hit the finale", () => {
    const r = analyze(goldenDominoes, sim(
      [touch("b1", "d1", 1), touch("d1", "d2", 2), touch("d2", "d3", 3), touch("d3", "d4", 4), touch("d4", "d5", 5), touch("d5", "finale", 5)],
      { b1: [[0, 50]], d1: [[1, 50]], d2: [[2, 50]], d3: [[3, 50]], d4: [[4, 50]], d5: [[5, 50]] },
    ));
    expect(r.outcome).toBe("success");
    expect(r.chain).toEqual(["b1", "d1", "d2", "d3", "d4", "d5"]);
  });

  it("follows same-step contacts in causal order, whatever order the engine reports them in", () => {
    const r = analyze(goldenDominoes, sim(
      [touch("b1", "d1", 1), touch("d1", "d2", 2), touch("d3", "d4", 5), touch("d2", "d3", 5), touch("d4", "finale", 6)],
      { ...idle, b1: [[0, 50]], d1: [[1, 50]], d2: [[2, 50]], d3: [[5, 50]], d4: [[5, 50]] },
    ));
    expect(r.outcome).toBe("success");
    expect(r.chain).toEqual(["b1", "d1", "d2", "d3", "d4"]);
  });

  it("lets a part already resting on a chain part join when it gets launched", () => {
    // b2 settles on the seesaw at step 3; the pushed ball lands on the seesaw at 100 and b2 is flung at 101.
    const r = analyze(goldenDominoes, sim(
      [touch("b2", "s1", 3, 200), touch("b1", "s1", 100)],
      { b1: [[0, 110]], s1: [[100, 150]], b2: [[0, 3], [101, 180]] },
    ));
    expect(r.chain).toEqual(["b1", "s1", "b2"]);
    expect(r.stoppedAt).toBe("b2");
  });

  it("does not let a part that was already moving on its own join the chain", () => {
    const r = analyze(goldenDominoes, sim([touch("b1", "d1", 10), touch("b2", "d1", 50)], { b1: [[0, 100]], d1: [[10, 80]], b2: [[0, 300]] }));
    expect(r.chain).toEqual(["b1", "d1"]);
  });

  it("only extends the chain when the touched part actually starts moving", () => {
    const r = analyze(goldenDominoes, sim([touch("b1", "d1", 10)], { ...idle, b1: [[0, 50]] }));
    expect(r.outcome).toBe("missed");
    expect(r.chain).toEqual(["b1"]);
    expect(r.stoppedAt).toBe("b1");
  });

  it("ignores a contact that ended before the chain reached either part", () => {
    const r = analyze(goldenDominoes, sim([touch("d1", "d2", 5, 8), touch("b1", "d1", 10)], { ...idle, b1: [[0, 50]], d1: [[10, 50]], d2: [[6, 20]] }));
    expect(r.chain).toEqual(["b1", "d1"]);
  });

  it("reports where a miss stopped, what came closest, what never moved and what fell off", () => {
    const r = analyze(goldenDominoes, sim(
      [touch("b1", "d1", 10), touch("d1", "d2", 20)],
      { ...idle, b1: [[0, 100]], d1: [[10, 60]], d2: [[20, 70]] },
      { b1: track(true, 5, -3), d1: track(true, 3.2), d2: track(true, 1.44), d3: track(false, 0.9), d4: track(false), d5: track(false) },
    ));
    expect(r.outcome).toBe("missed");
    expect(r.stoppedAt).toBe("d2");
    expect(r.closest).toEqual({ part: "d2", cells: 1.4 });
    expect(r.neverMoved).toEqual(["d3", "d4", "d5"]);
    expect(r.fellOff).toEqual(["b1"]);
    expect(r.summary).toBe("Missed: the chain b1 → d1 → d2 stopped at d2. Closest to the finale: d2 at 1.4 cells.");
  });

  it("counts an impact that stops the part in the same step it touches the finale", () => {
    const r = analyze(goldenDominoes, sim(
      [touch("b1", "d1", 1), touch("d1", "d2", 2), touch("d2", "d3", 3), touch("d3", "d4", 4), touch("d4", "d5", 5), touch("d5", "finale", 60)],
      { b1: [[0, 50]], d1: [[1, 50]], d2: [[2, 50]], d3: [[3, 50]], d4: [[4, 50]], d5: [[5, 60]] },
    ));
    expect(r.outcome).toBe("success");
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
