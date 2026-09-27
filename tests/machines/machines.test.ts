import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { judgeAttempt } from "../../src/agent/judge.js";
import { ENGINE, MIN_CHAIN_PARTS } from "../../src/core/constants.js";
import { initPhysics } from "../../src/core/sim.js";
import { MAX_ATTEMPTS, MAX_PREVIEWS_PER_ATTEMPT } from "../../src/design/harness.js";
import { DESIGNER, choreId, type MachineFile } from "../../src/design/machines.js";
import { CHORES } from "../../src/spike/chores.js";

const DIR = "machines";
const machines = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8")) as MachineFile] as const);

beforeAll(async () => {
  await initPhysics();
});

describe("stored machines", () => {
  it("cover at least 8 chores from the eval set, every one finished", () => {
    expect(machines.length).toBeGreaterThanOrEqual(8);
    expect(machines.every(([, m]) => m.status !== "designing")).toBe(true);
  });

  describe.each(machines)("%s", (file, m) => {
    // Numbering and outcomes are checked here; that attempts were never edited or removed is what git history shows.
    it("is a well-formed history made under the loop's budget", () => {
      expect(file).toBe(`${m.id}.json`);
      expect(m.id).toBe(choreId(m.chore));
      expect(CHORES).toContain(m.chore);
      expect(m).toMatchObject({ designer: DESIGNER, engine: ENGINE, maxAttempts: MAX_ATTEMPTS, maxPreviewsPerAttempt: MAX_PREVIEWS_PER_ATTEMPT });
      expect(m.attempts.length).toBeGreaterThan(0);
      expect(m.attempts.length).toBeLessThanOrEqual(m.maxAttempts);
      m.attempts.forEach((a, i) => {
        expect(a.attempt).toBe(i + 1);
        expect(a.previews).toBeLessThanOrEqual(m.maxPreviewsPerAttempt);
        if (i < m.attempts.length - 1) expect(a.outcome).not.toBe("success");
      });
      const last = m.attempts.at(-1)!;
      expect(m.status === "success").toBe(last.outcome === "success");
      if (m.status === "out_of_attempts") expect(m.attempts.length).toBe(m.maxAttempts);
      if (m.status === "gave_up") expect(m.gaveUp).toBeTruthy();
      if (m.status === "success") {
        expect(m.pendingPreviews).toBe(0);
        expect(last.overkillScore).toBeGreaterThanOrEqual(MIN_CHAIN_PARTS);
        expect(last.chain).toHaveLength(last.overkillScore);
      }
    });

    it("re-simulates every attempt to its recorded outcome, feedback and final-state hash", () => {
      for (const a of m.attempts) {
        const judged = judgeAttempt(a.input, a.attempt, m.maxAttempts);
        const report = judged.record.report;
        expect({
          outcome: report?.outcome ?? "invalid",
          feedback: judged.feedback,
          chain: report?.chain ?? [],
          overkillScore: report?.overkillScore ?? 0,
          hash: judged.record.traceHash,
        }).toEqual({ outcome: a.outcome, feedback: a.feedback, chain: a.chain, overkillScore: a.overkillScore, hash: a.hash });
      }
    });
  });
});
