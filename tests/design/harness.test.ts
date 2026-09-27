import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatPreview } from "../../src/agent/format.js";
import { judgeAttempt } from "../../src/agent/judge.js";
import { ENGINE } from "../../src/core/constants.js";
import { preview } from "../../src/core/preview.js";
import { initPhysics } from "../../src/core/sim.js";
import { RunOver, giveUpStep, newMachine, previewStep, simulateStep } from "../../src/design/harness.js";
import { choreId, type MachineFile } from "../../src/design/machines.js";
import { dudMachine, goldenDominoes, lateRoller } from "../fixtures/golden.js";

beforeAll(async () => {
  await initPhysics();
});

describe("choreId", () => {
  it("makes short URL-safe ids from the chore text", () => {
    expect(choreId("turn off the light")).toBe("turn-off-the-light");
    expect(choreId("fill the dog's bowl")).toBe("fill-the-dogs-bowl");
    expect(choreId("mute the TV")).toBe("mute-the-tv");
  });
});

describe("judgeAttempt", () => {
  it("can keep every pose for drawing without changing the judgement", () => {
    const plain = judgeAttempt(goldenDominoes, 1, 12);
    const drawn = judgeAttempt(goldenDominoes, 1, 12, { record: true });
    expect(drawn.feedback).toBe(plain.feedback);
    expect(drawn.record.traceHash).toBe(plain.record.traceHash);
    expect(plain.sim!.frames).toBeUndefined();
    expect(drawn.sim!.frames!.count).toBeGreaterThan(0);
    expect(judgeAttempt({ parts: "nope" }, 1, 12).sim).toBeUndefined();
  });
});

describe("design harness", () => {
  const fresh = () => newMachine("turn off the light");

  it("starts a machine with the loop's budget and the pinned engine", () => {
    const m = fresh();
    expect(m).toMatchObject({ id: "turn-off-the-light", engine: ENGINE, maxAttempts: 12, maxPreviewsPerAttempt: 3, status: "designing", attempts: [] });
  });

  it("previews exactly as the loop's preview tool does, without using an attempt", () => {
    const step = previewStep(fresh(), goldenDominoes);
    expect(step.text).toBe(formatPreview(preview(goldenDominoes)));
    expect(step.machine.pendingPreviews).toBe(1);
    expect(step.machine.attempts).toEqual([]);
  });

  it("refuses a fourth preview before the next attempt, as the loop does", () => {
    let m = fresh();
    for (let i = 0; i < 3; i++) m = previewStep(m, goldenDominoes).machine;
    const blocked = previewStep(m, goldenDominoes);
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toBe("Preview limit reached (3 per attempt). Call simulate.");
    expect(blocked.machine.pendingPreviews).toBe(3);
  });

  it("records every simulate with the loop's own feedback and resets the preview count", () => {
    const m = previewStep(previewStep(fresh(), dudMachine).machine, dudMachine).machine;
    const step = simulateStep(m, dudMachine);
    const judged = judgeAttempt(dudMachine, 1, 12);
    expect(step.text).toBe(judged.feedback);
    expect(step.machine.pendingPreviews).toBe(0);
    expect(step.machine.status).toBe("designing");
    expect(step.machine.attempts).toEqual([{
      attempt: 1, previews: 2, input: dudMachine, outcome: "missed", feedback: judged.feedback,
      chain: judged.record.report!.chain, overkillScore: 0, hash: judged.record.traceHash,
    }]);
  });

  it("records an invalid blueprint as a used attempt with no hash", () => {
    const step = simulateStep(fresh(), { parts: "nope" });
    expect(step.isError).toBe(true);
    expect(step.machine.attempts[0]).toMatchObject({ attempt: 1, outcome: "invalid", hash: null, chain: [] });
    expect(step.text).toContain("INVALID blueprint (the attempt is used)");
  });

  it("applies the no-push rule, like the loop", () => {
    const step = simulateStep(fresh(), lateRoller);
    expect(step.success).toBe(false);
    expect(step.machine.attempts[0]!.outcome).toBe("not_overkill");
    expect(step.text).toContain("Not overkill enough: the finale gets hit even without the first push.");
  });

  it("stops at a success and refuses any further call", () => {
    const won = simulateStep(simulateStep(fresh(), dudMachine).machine, goldenDominoes);
    expect(won.success).toBe(true);
    expect(won.machine.status).toBe("success");
    expect(won.machine.attempts.map((a) => a.outcome)).toEqual(["missed", "success"]);
    expect(won.machine.attempts[1]!.overkillScore).toBe(6);
    expect(() => simulateStep(won.machine, goldenDominoes)).toThrow(RunOver);
    expect(() => previewStep(won.machine, goldenDominoes)).toThrow(RunOver);
    expect(() => giveUpStep(won.machine, "done")).toThrow(RunOver);
  });

  it("ends the run when the attempts run out", () => {
    let m: MachineFile = { ...fresh(), maxAttempts: 2 };
    m = simulateStep(m, dudMachine).machine;
    m = simulateStep(m, dudMachine).machine;
    expect(m.status).toBe("out_of_attempts");
    expect(() => simulateStep(m, goldenDominoes)).toThrow(RunOver);
  });

  it("lets the designer give up only after an attempt, with a reason", () => {
    expect(() => giveUpStep(fresh(), "No layout can work.")).toThrow(RunOver);
    const tried = simulateStep(fresh(), dudMachine).machine;
    expect(() => giveUpStep(tried, "  ")).toThrow(RunOver);
    expect(giveUpStep(tried, "No layout can work.")).toMatchObject({ status: "gave_up", gaveUp: "No layout can work." });
  });
});

describe("design CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "overkill-design-"));
  const bp = join(dir, "bp.json");
  writeFileSync(bp, JSON.stringify(goldenDominoes));
  const run = (...args: string[]) =>
    spawnSync("npx", ["tsx", "src/design/cli.ts", ...args], { env: { PATH: process.env.PATH, OVERKILL_MACHINES_DIR: dir }, encoding: "utf8" });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("previews, then simulates and records, printing the tool results word for word", () => {
    const p = run("--chore", "turn-off-the-light", "--preview", "--blueprint", bp);
    expect(p.status).toBe(0);
    expect(p.stdout.trim()).toBe(formatPreview(preview(goldenDominoes)));
    const s = run("--chore", "turn-off-the-light", "--blueprint", bp);
    expect(s.status).toBe(0);
    expect(s.stdout.trim()).toBe(judgeAttempt(goldenDominoes, 1, 12).feedback);
    const saved = JSON.parse(readFileSync(join(dir, "turn-off-the-light.json"), "utf8")) as MachineFile;
    expect(saved.status).toBe("success");
    expect(saved.attempts[0]!.previews).toBe(1);
    const again = run("--chore", "turn-off-the-light", "--blueprint", bp);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already worked on attempt 1");
  }, 60_000);

  it("runs one call per chore at a time: a call that finds the chore locked records nothing", () => {
    writeFileSync(join(dir, "close-the-door.lock"), "");
    const r = run("--chore", "close-the-door", "--blueprint", bp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Another design call");
    expect(existsSync(join(dir, "close-the-door.json"))).toBe(false);
    rmSync(join(dir, "close-the-door.lock"));
    expect(run("--chore", "close-the-door", "--preview", "--blueprint", bp).status).toBe(0);
    expect(existsSync(join(dir, "close-the-door.lock"))).toBe(false); // released afterwards
  }, 60_000);

  it("has no option for writing a history anywhere but machines/", () => {
    const r = spawnSync("npx", ["tsx", "src/design/cli.ts", "--dir", dir, "--list"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--dir");
  }, 60_000);

  it("rejects an unknown chore and a blueprint file that isn't JSON without using an attempt", () => {
    expect(run("--chore", "juggle", "--blueprint", bp).status).toBe(1);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    const r = run("--chore", "feed-the-cat", "--blueprint", bad);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("as JSON");
    expect(run("--chore", "feed-the-cat", "--history").stdout).toContain("not started");
  }, 60_000);
});
