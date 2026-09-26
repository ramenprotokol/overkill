import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { ENGINE } from "../../src/core/constants.js";
import { initPhysics, runSim } from "../../src/core/sim.js";
import { dudMachine, goldenDominoes, seesawDrop, shortChain } from "../fixtures/golden.js";

beforeAll(async () => {
  await initPhysics();
});

describe("runSim", () => {
  it("runs the golden machine into the finale via every domino", () => {
    const r = runSim(goldenDominoes);
    expect(r.finaleHit?.by).toBe("d5");
    const pairs = r.events.map((e) => `${e.a}-${e.b}`);
    for (const p of ["b1-d1", "d1-d2", "d2-d3", "d3-d4", "d4-d5", "d5-finale"]) expect(pairs).toContain(p);
  });

  it("is deterministic: the same blueprint gives the same hash", () => {
    expect(runSim(goldenDominoes).hash).toBe(runSim(goldenDominoes).hash);
  });

  it("gives different machines different hashes", () => {
    expect(runSim(goldenDominoes).hash).not.toBe(runSim(shortChain).hash);
  });

  it("lets a ball pushed away from everything roll off the board", () => {
    const r = runSim(dudMachine);
    expect(r.finaleHit).toBeNull();
    expect(r.parts.b1!.end.y).toBeLessThan(-1);
    expect(r.parts.d1!.moved).toBe(false);
  });

  it("tips a seesaw when a ball lands on it", () => {
    const r = runSim(seesawDrop);
    expect(r.events.map((e) => `${e.a}-${e.b}`)).toContain("b1-s1");
    expect(r.parts.s1!.moved).toBe(true);
  });

  it("names the installed physics engine version", () => {
    const pkg = JSON.parse(readFileSync("node_modules/@dimforge/rapier2d-deterministic-compat/package.json", "utf8")) as { version: string };
    expect(ENGINE).toBe(`@dimforge/rapier2d-deterministic-compat@${pkg.version}`);
    expect(runSim(goldenDominoes).engine).toBe(ENGINE);
  });

  it("records contact intervals, including resting contacts, without the floor", () => {
    const r = runSim(seesawDrop);
    const c = r.contacts.find((x) => x.a === "b1" && x.b === "s1");
    expect(c).toBeDefined();
    expect(c!.from).toBeLessThanOrEqual(c!.to);
    expect(r.contacts.every((x) => x.a < x.b && x.a !== "floor" && x.b !== "floor" && x.to <= r.steps)).toBe(true);
  });

  it("records when each part was moving, in step numbers where the push is step 0", () => {
    const r = runSim(goldenDominoes);
    expect(r.moving.b1!.some(([s]) => s === 0)).toBe(true);
    const hit = r.events.find((e) => e.a === "b1" && e.b === "d1")!;
    const d1Starts = r.moving.d1!.map(([s]) => s).filter((s) => s >= 0);
    expect(d1Starts[0]).toBeGreaterThanOrEqual(hit.step - 1);
  });

  it("runs the same settle and steps without the first push when push is false", () => {
    const r = runSim(goldenDominoes, undefined, { push: false });
    expect(r.steps).toBe(runSim(goldenDominoes).steps);
    expect(r.moving.b1![0]![0]).toBeLessThan(0); // it still settled
    expect(r.moving.b1!.every(([, end]) => end <= 0)).toBe(true); // but never moved after the push step
    expect(r.parts.b1!.moved).toBe(false);
    expect(r.parts.d1!.moved).toBe(false);
    expect(r.finaleHit).toBeNull();
    expect(r.hash).not.toBe(runSim(goldenDominoes).hash);
  });

  it("pushes by default", () => {
    expect(runSim(goldenDominoes, undefined, { push: true }).hash).toBe(runSim(goldenDominoes).hash);
  });

  it("lets the machine settle before the first push", () => {
    const r = runSim(goldenDominoes);
    expect(r.moving.b1![0]![0]).toBeLessThan(0); // it dropped onto the floor while settling
    expect(r.parts.b1!.start.y).toBeCloseTo(0.3, 1); // and was resting there when pushed
  });
});
