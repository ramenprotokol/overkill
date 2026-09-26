import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("spike CLI", () => {
  it("refuses to run without the Ramen Protocol API key", () => {
    const r = spawnSync("npx", ["tsx", "src/spike/cli.ts", "--limit", "1"], {
      env: { ...process.env, RAMEN_ANTHROPIC_API_KEY: "" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("RAMEN_ANTHROPIC_API_KEY");
  }, 30_000);
});
