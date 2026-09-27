import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judgeAttempt } from "../../src/agent/judge.js";
import { initPhysics } from "../../src/core/sim.js";
import type { MachineFile } from "../../src/design/machines.js";
import { serveDist } from "./serve.js";

const machines = readdirSync("machines")
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join("machines", f), "utf8")) as MachineFile);

let browser: Browser;
let server: Awaited<ReturnType<typeof serveDist>>;

beforeAll(async () => {
  if (!existsSync("dist/index.html")) throw new Error("dist/ is missing: run npm run build first (npm run test:e2e does).");
  await initPhysics();
  server = await serveDist("dist");
  try {
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  } catch (e) {
    throw new Error(`Couldn't start headless Chromium. Install it with: npx playwright-core install chromium\n${String(e)}`);
  }
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Opens the site and collects every console error, page error and CSP violation. */
async function open(options: Parameters<Browser["newPage"]>[0] = {}): Promise<{ page: Page; problems: string[] }> {
  const page = await browser.newPage(options);
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page: ${e.message}`));
  return { page, problems };
}

/** Navigates within the page to a sheet and waits until the browser has run it. */
async function visit(page: Page, hash: string): Promise<{ hash: string; expected: string; verified: string; state: string }> {
  await page.evaluate((h) => {
    document.getElementById("sheet")!.dataset.state = "stale";
    location.hash = h;
  }, hash);
  await page.waitForFunction(() => {
    const s = document.getElementById("sheet")!.dataset.state;
    return s === "ready" || s === "error";
  }, undefined, { timeout: 30_000 });
  return page.evaluate(() => {
    const d = document.getElementById("sheet")!.dataset;
    return { hash: d.hash ?? "", expected: d.expected ?? "", verified: d.verified ?? "", state: d.state ?? "" };
  });
}

describe("built site", () => {
  it("ships its third-party notices and a CSP that allows WebAssembly and nothing inline", () => {
    const notices = readFileSync("dist/THIRD-PARTY-NOTICES.txt", "utf8");
    for (const name of ["@dimforge/rapier2d-deterministic-compat", "zod", "Big Shoulders", "Barlow", "Martian Mono", "Apache License", "SIL Open Font License"]) {
      expect(notices).toContain(name);
    }
    const csp = /Content-Security-Policy: (.*)/.exec(readFileSync("dist/_headers", "utf8"))![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
  });

  it("runs every stored attempt in the browser to the same trace hash as Node, under the CSP, with no console errors", async () => {
    const { page, problems } = await open({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    await page.goto(server.url);
    let checked = 0;
    for (const m of machines) {
      for (const a of m.attempts) {
        const node = judgeAttempt(a.input, a.attempt, m.maxAttempts).record.traceHash ?? "none";
        const seen = await visit(page, `#/${m.id}/${a.attempt}`);
        expect({ id: m.id, attempt: a.attempt, ...seen }).toEqual({ id: m.id, attempt: a.attempt, hash: node, expected: node, verified: "match", state: "ready" });
        checked++;
      }
    }
    expect(checked).toBe(machines.reduce((n, m) => n + m.attempts.length, 0));
    expect(problems).toEqual([]);
    await page.close();
  }, 300_000);

  it("plays a run, then fits a 400 px phone screen without sideways scrolling", async () => {
    const { page, problems } = await open({ viewport: { width: 400, height: 860 } });
    const first = machines[0]!;
    await page.goto(`${server.url}/#/${first.id}`);
    await page.waitForFunction(() => document.getElementById("sheet")!.dataset.state === "ready", undefined, { timeout: 30_000 });
    // It autoplays: the playhead moves.
    const start = Number(await page.inputValue("#scrub"));
    await page.waitForFunction((s) => Number((document.getElementById("scrub") as HTMLInputElement).value) > s + 30, start, { timeout: 10_000 });
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    expect(await page.isVisible(".board")).toBe(true);
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("doesn't autoplay for visitors who prefer reduced motion, and shows the finished run", async () => {
    const { page } = await open({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    await page.goto(server.url);
    await page.waitForFunction(() => document.getElementById("sheet")!.dataset.state === "ready", undefined, { timeout: 30_000 });
    expect(await page.textContent("#play")).toBe("Play");
    const scrub = await page.$eval("#scrub", (e) => ({ value: (e as HTMLInputElement).value, max: (e as HTMLInputElement).max }));
    expect(scrub.value).toBe(scrub.max);
    await page.close();
  }, 60_000);

  it("keeps the current sheet when the skip link is used, and focus on a revision link after following it", async () => {
    const { page, problems } = await open({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const m = machines.find((x) => x.attempts.length > 1)!;
    await page.goto(`${server.url}/#/${m.id}/1`);
    await page.waitForFunction(() => document.getElementById("sheet")!.dataset.state === "ready", undefined, { timeout: 30_000 });
    const title = await page.title();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.className)).toBe("skip");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "sheet");
    // The address still names this sheet, so a reload or a copied link opens it, not the first sheet.
    expect(await page.evaluate(() => location.hash)).toBe(`#/${m.id}/1`);
    expect(Math.abs(await page.evaluate(() => document.getElementById("sheet")!.getBoundingClientRect().top))).toBeLessThan(1);
    expect(await page.title()).toBe(title);
    expect(await page.isHidden("#route-message")).toBe(true);

    const href = `#/${m.id}/2`;
    await page.focus(`a.rev[href="${href}"]`);
    await page.evaluate(() => { document.getElementById("sheet")!.dataset.state = "stale"; });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("sheet")!.dataset.state === "ready", undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe(href);
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("explains a link to a drawing that doesn't exist and shows the first sheet instead", async () => {
    const { page, problems } = await open();
    await page.goto(`${server.url}/#/not-a-chore`);
    await page.waitForFunction(() => document.getElementById("sheet")!.dataset.state === "ready", undefined, { timeout: 30_000 });
    expect(await page.isVisible("#route-message")).toBe(true);
    expect(await page.textContent("#route-message")).toContain("no drawing called “not-a-chore”");
    await visit(page, `#/${machines[0]!.id}/99`);
    expect(await page.textContent("#route-message")).toContain("not 99");
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);
});
