import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics, runSim, type Contact, type Deviation, type PartTrack, type SimResult } from "../../src/core/sim.js";
import { analyze, finaleTriggeredWithoutPush } from "../../src/core/trace.js";
import { droppedOnFinale, dudMachine, goldenDominoes, lateRoller, lazyRoll, neighbourBalls, shortChain, slidingBucket, twinOnlyHit } from "../fixtures/golden.js";

type Spans = [number, number][];
const touch = (a: string, b: string, from: number, to = from + 5): Contact => (a < b ? { a, b, from, to } : { a: b, b: a, from, to });
const track = (moved: boolean, minDistToFinale = 5, endY = 0.5): PartTrack => ({
  start: { x: 0, y: 0 }, end: { x: 0, y: endY }, moved, minDistToFinale,
});
/** By default a part leaves its push-free path (and visibly so) the moment it starts moving after the push. */
const devFrom = (moving: Record<string, Spans>): Record<string, Deviation> =>
  Object.fromEntries(Object.entries(moving).map(([id, spans]) => {
    const onset = spans.map(([start]) => start).find((start) => start >= 0) ?? null;
    return [id, { onset, visible: onset, moved: onset }];
  }));
const dev = (onset: number | null, visible: number | null = onset, moved: number | null = visible): Deviation => ({ onset, visible, moved });
const sim = (
  contacts: Contact[], moving: Record<string, Spans>, parts: Record<string, PartTrack> = {}, deviation: Record<string, Deviation> = {},
  twinContacts: Contact[] = [],
): SimResult => ({
  events: [], contacts, moving, twinContacts,
  parts: { ...Object.fromEntries(Object.entries(moving).map(([id, spans]) => [id, track(spans.length > 0)])), ...parts },
  deviation: { ...devFrom(moving), ...deviation },
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
    expect(r.joinedAt).toEqual({ b1: 0, d1: 10, d2: 20, d3: 30, d4: 40, d5: 50 });
    expect(r.parents).toEqual({ b1: null, d1: "b1", d2: "d1", d3: "d2", d4: "d3", d5: "d4" });
    expect(r.finaleStep).toBe(60);
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
      {},
      { d4: dev(40) }, // its early wobble happens without the push too
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
    // b2 settles on the seesaw at step 3 (in the push-free twin too); the pushed ball lands on the seesaw at 100 and b2 is flung at 101.
    const r = analyze(goldenDominoes, sim(
      [touch("b2", "s1", 3, 200), touch("b1", "s1", 100)],
      { b1: [[0, 110]], s1: [[100, 150]], b2: [[0, 3], [101, 180]] },
      {},
      { b2: dev(101) },
    ));
    expect(r.chain).toEqual(["b1", "s1", "b2"]);
    expect(r.stoppedAt).toBe("b2");
  });

  it("does not credit a part moving on its own when the push never changes its path", () => {
    const r = analyze(goldenDominoes, sim(
      [touch("b1", "d1", 10), touch("b2", "d1", 50)],
      { b1: [[0, 100]], d1: [[10, 80]], b2: [[0, 300]] },
      {},
      { b2: dev(null) }, // it rolls exactly the same way in the push-free twin
    ));
    expect(r.chain).toEqual(["b1", "d1"]);
  });

  it("credits a part already moving on its own when a chain part changes its path", () => {
    const r = analyze(goldenDominoes, sim(
      [touch("b1", "b2", 50)],
      { b1: [[0, 100]], b2: [[-59, 300]] },
      {},
      { b2: dev(50, 53) },
    ));
    expect(r.chain).toEqual(["b1", "b2"]);
  });

  it("does not credit a part the push only nudged, never 5 cm off its push-free path", () => {
    const r = analyze(goldenDominoes, sim([touch("b1", "d1", 10)], { ...idle, b1: [[0, 50]], d1: [[10, 14]] }, {}, { d1: dev(10, null) }));
    expect(r.chain).toEqual(["b1"]);
  });

  it("does not credit a part whose path changed away from any touch with the chain", () => {
    // Without the push, b2 would have been knocked over at step 125; with it, the chain reaches it at 138. The push only delayed it.
    const r = analyze(goldenDominoes, sim([touch("b1", "b2", 138)], { b1: [[0, 200]], b2: [[138, 150]] }, {}, { b2: dev(125, 136) }));
    expect(r.chain).toEqual(["b1"]);
  });

  it("does not credit a part the push only kept from being hit: the gap opens but the part never moves", () => {
    // In the push-free twin a spare ball hits d1 at step 50; with the push it doesn't, so d1 stays put beside b1.
    const r = analyze(goldenDominoes, sim([touch("b1", "d1", 40, 200)], { b1: [[0, 45]], d1: [] }, {}, { d1: dev(50, 55, null) }));
    expect(r.chain).toEqual(["b1"]);
  });

  it("does not credit a gap that starts with a touch only the push-free twin had", () => {
    const r = analyze(
      goldenDominoes,
      sim([touch("b1", "d1", 40, 200)], { b1: [[0, 45]], d1: [[50, 90]] }, {}, { d1: dev(50) }, [touch("b9", "d1", 50, 60)]),
    );
    expect(r.chain).toEqual(["b1"]);
  });

  it("still credits a part when the twin has the same touch at the same time", () => {
    const r = analyze(
      goldenDominoes,
      sim([touch("b1", "d1", 50, 60)], { b1: [[0, 60]], d1: [[50, 90]] }, {}, { d1: dev(50) }, [touch("b1", "d1", 51, 60)]),
    );
    expect(r.chain).toEqual(["b1", "d1"]);
  });

  it("only extends the chain when the touch moves the part off its push-free path", () => {
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

  it("ignores a part resting against the finale that never moves into it", () => {
    const r = analyze(goldenDominoes, sim([touch("b1", "d1", 10), touch("d5", "finale", -30, 1200)], { ...idle, b1: [[0, 50]], d1: [[10, 40]] }));
    expect(r.outcome).toBe("missed");
    expect(r.finaleHitBy).toBeNull();
  });

  it("counts something that hit the finale while the machine was settling as hitting it on its own", () => {
    const r = analyze(goldenDominoes, sim([touch("b2", "finale", -20)], { b1: [[0, 50]], b2: [[-40, -19]] }));
    expect(r.outcome).toBe("not_overkill");
    expect(r.chain).toEqual(["b2"]);
  });

  it("lets a part leave its push-free path up to JOIN_SLACK steps either side of a touch, but not further", () => {
    const moving = { ...idle, b1: [[0, 50]], d1: [[14, 60]] } as Record<string, Spans>;
    expect(analyze(goldenDominoes, sim([touch("b1", "d1", 10, 12)], moving, {}, { d1: dev(14) })).chain).toEqual(["b1", "d1"]);
    expect(analyze(goldenDominoes, sim([touch("b1", "d1", 10, 12)], moving, {}, { d1: dev(15) })).chain).toEqual(["b1"]);
    expect(analyze(goldenDominoes, sim([touch("b1", "d1", 10, 12)], moving, {}, { d1: dev(8) })).chain).toEqual(["b1", "d1"]);
    expect(analyze(goldenDominoes, sim([touch("b1", "d1", 10, 12)], moving, {}, { d1: dev(7) })).chain).toEqual(["b1"]);
  });

  it("never lets a fixed part join the chain", () => {
    const r = analyze(goldenDominoes, sim([touch("b1", "p9", 10)], { ...idle, b1: [[0, 50]] }));
    expect(r.chain).toEqual(["b1"]);
  });

  it("credits a load that leaves its push-free path a step before the seesaw carrying it", () => {
    // A bucket at the end of a tipping seesaw moves further than the seesaw's own points, so it can register first.
    const r = analyze(goldenDominoes, sim(
      [touch("k1", "s1", -10, 500), touch("b1", "s1", 100)],
      { b1: [[0, 110]], s1: [[101, 150]], k1: [[-50, -40], [100, 160]] },
      {},
      { s1: dev(101), k1: dev(100) },
    ));
    expect(r.chain).toEqual(["b1", "s1", "k1"]);
    expect(r.joinedAt).toEqual({ b1: 0, s1: 101, k1: 101 });
  });

  it("credits the earliest-joined parent when two chain parts set a part off at once", () => {
    const r = analyze(goldenDominoes, sim(
      [touch("b1", "a1", 5), touch("a1", "z1", 20), touch("b1", "z1", 20)],
      { b1: [[0, 50]], a1: [[5, 50]], z1: [[20, 50]] },
    ));
    expect(r.chain).toEqual(["b1", "z1"]);
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

  it("follows the pushed ball through its neighbour into the dominoes", () => {
    const r = analyze(neighbourBalls, runSim(neighbourBalls));
    expect(r.outcome).toBe("success");
    expect(r.chain).toEqual(["b1", "b2", "d1", "d2", "d3", "d4", "d5"]);
  });

  it("credits a bucket whose slide a seesaw changed, which the old motion-start rule could not", () => {
    const sim = runSim(slidingBucket);
    // The bucket is still sliding on its own when the ball lands on the seesaw under it.
    expect(sim.moving.k1!.some(([start, end]) => start <= sim.deviation.k1!.onset! && end > sim.deviation.k1!.onset!)).toBe(true);
    const r = analyze(slidingBucket, sim);
    expect(r.chain).toEqual(["b1", "s1", "k1"]);
    expect(r.joinedAt.k1).toBeGreaterThanOrEqual(r.joinedAt.s1!);
  });

  it("gives no chain credit for motion only the push-free twin makes (review repro)", () => {
    // The push sends b1 away before d5 can topple into d3 and d7, so in the pushed run they barely move; only the twin hits them.
    const r = analyze(twinOnlyHit, runSim(twinOnlyHit));
    expect(r.chain).not.toContain("d7");
    expect(Object.keys(r.joinedAt)).not.toContain("d7");
  });

  it("gives no chain credit for motion the push-free twin makes too", () => {
    const r = analyze(lateRoller, runSim(lateRoller));
    expect(runSim(lateRoller).deviation.b2).toEqual({ onset: null, visible: null, moved: null }); // the spare ball rolls the same either way
    expect(Object.keys(r.joinedAt)).not.toContain("b2");
  });
});

describe("finaleTriggeredWithoutPush (real physics)", () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it("is false for the golden machine: nothing reaches the finale unless the ball is pushed", () => {
    expect(finaleTriggeredWithoutPush(goldenDominoes)).toBe(false);
  });

  it("is true when a spare ball is dropped onto the finale from above", () => {
    expect(finaleTriggeredWithoutPush(droppedOnFinale)).toBe(true);
  });

  it("is true for a machine that succeeds with the push while a spare ball reaches the finale on its own later", () => {
    expect(analyze(lateRoller, runSim(lateRoller)).success).toBe(true);
    expect(finaleTriggeredWithoutPush(lateRoller)).toBe(true);
  });

  it("is false when nothing moves into the finale without the push", () => {
    expect(finaleTriggeredWithoutPush(dudMachine)).toBe(false);
    expect(finaleTriggeredWithoutPush(lazyRoll)).toBe(false);
  });
});
