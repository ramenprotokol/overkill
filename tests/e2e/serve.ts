import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

type Rule = { pattern: string; headers: [string, string][] };

/** Reads a Cloudflare Pages `_headers` file: an unindented path pattern, then indented `Name: value` lines. */
export function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), headers: [] });
      continue;
    }
    const i = raw.indexOf(":");
    rules.at(-1)?.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
  }
  return rules;
}

const matches = (pattern: string, path: string) => (pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern);

/** Serves dist/ on a free local port the way Pages would: same files, same headers (so the CSP is live). */
export async function serveDist(dir = "dist"): Promise<{ url: string; close: () => Promise<void> }> {
  const root = resolve(dir);
  const rules = parseHeaders(readFileSync(join(root, "_headers"), "utf8"));
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      const body = readFileSync(file);
      res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
      for (const rule of rules) if (matches(rule.pattern, path)) for (const [k, v] of rule.headers) res.setHeader(k, v);
      res.writeHead(200).end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => server.close(() => ok())) };
}
