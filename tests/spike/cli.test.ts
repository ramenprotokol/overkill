import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Only PATH and the one variable under test, so nothing else in the shell can reach the CLI. */
const runCli = (key: string, ...args: string[]) =>
  spawnSync("npx", ["tsx", "src/spike/cli.ts", ...args], {
    env: { PATH: process.env.PATH, RAMEN_ANTHROPIC_API_KEY: key },
    encoding: "utf8",
  });

describe("spike CLI", () => {
  it("refuses to run without the Ramen Protocol API key", () => {
    const r = runCli("", "--limit", "1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("RAMEN_ANTHROPIC_API_KEY");
  }, 30_000);

  it("rejects a bad flag before any client exists", () => {
    const r = runCli("test-key-not-real", "--limit", "1", "--max-cost", "$5");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--max-cost");
    expect(r.stdout).toBe("");
  }, 30_000);
});
