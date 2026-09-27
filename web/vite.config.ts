import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

interface Component {
  pkg: string;
  what: string;
  source: string;
  licence: string;
}

/** Third-party code and fonts that end up in dist/. Each one's full licence text is copied from its package. */
const SHIPPED: Component[] = [
  { pkg: "@dimforge/rapier2d-deterministic-compat", what: "2D physics engine (JavaScript bindings and WebAssembly)", source: "https://github.com/dimforge/rapier", licence: "Apache-2.0" },
  { pkg: "zod", what: "schema validation for blueprints", source: "https://github.com/colinhacks/zod", licence: "MIT" },
  { pkg: "@fontsource/big-shoulders-display", what: "Big Shoulders Display typeface (latin, weight 800)", source: "https://github.com/xotypeco/big_shoulders", licence: "OFL-1.1" },
  { pkg: "@fontsource/barlow-semi-condensed", what: "Barlow Semi Condensed typeface (latin, weights 400, 400 italic, 600)", source: "https://github.com/jpt/barlow", licence: "OFL-1.1" },
  { pkg: "@fontsource/martian-mono", what: "Martian Mono typeface (latin, weight 400)", source: "https://github.com/evilmartians/mono", licence: "OFL-1.1" },
];

export function thirdPartyNotices(): string {
  const parts = SHIPPED.map((c) => {
    const dir = resolve(root, "node_modules", c.pkg);
    const version = (JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { version: string }).version;
    const text = readFileSync(resolve(dir, "LICENSE"), "utf8").trim();
    return [`${c.pkg} ${version}`, c.what, `Licence: ${c.licence}`, `Source: ${c.source}`, "", text].join("\n");
  });
  const rule = "\n\n" + "=".repeat(78) + "\n\n";
  return [
    "OVERKILL ships the following third-party components in this site. Their licences follow in full.",
    "OVERKILL's own code is MIT-licensed: https://github.com/ramenprotokol/overkill",
    ...parts,
  ].join(rule) + "\n";
}

function notices(): Plugin {
  return {
    name: "third-party-notices",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "THIRD-PARTY-NOTICES.txt", source: thirdPartyNotices() });
    },
  };
}

export default defineConfig({
  root: here,
  base: "/",
  publicDir: resolve(here, "public"),
  plugins: [notices()],
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    target: "es2022",
    // Fonts and images stay files, so the CSP never has to allow data: fonts.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    // The physics chunk carries Rapier's WebAssembly inline; it's big on purpose.
    chunkSizeWarningLimit: 4000,
  },
});
