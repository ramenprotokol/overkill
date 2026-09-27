import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { thirdPartyNotices } from "../../web/vite.config.js";
import { parseHeaders } from "../e2e/serve.js";

describe("third-party notices", () => {
  it("names every shipped component with its version and carries each licence in full", () => {
    const text = thirdPartyNotices();
    for (const pkg of ["@dimforge/rapier2d-deterministic-compat", "zod", "@fontsource/big-shoulders-display", "@fontsource/barlow-semi-condensed", "@fontsource/martian-mono"]) {
      const version = (JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, "utf8")) as { version: string }).version;
      expect(text).toContain(`${pkg} ${version}`);
    }
    expect(text).toContain("Apache License");
    expect(text).toContain("Copyright 2020 Dimforge EURL");
    expect(text).toContain("Copyright (c) 2025 Colin McDonnell");
    expect(text.match(/SIL Open Font License/g)!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("_headers", () => {
  const rules = parseHeaders(readFileSync("web/public/_headers", "utf8"));
  const all = new Map(rules.find((r) => r.pattern === "/*")!.headers);

  it("sets a tight CSP that allows only this site's scripts, plus WebAssembly compilation for the physics engine", () => {
    const csp = all.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'|https?:/);
    expect(all.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("caches only content-hashed build assets for a long time", () => {
    const cached = rules.filter((r) => r.headers.some(([k]) => k === "Cache-Control"));
    expect(cached.map((r) => r.pattern)).toEqual(["/assets/*"]);
  });
});
