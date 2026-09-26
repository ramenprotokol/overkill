import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../agent/cost.js";
import { DEFAULT_MODEL, runAgent, type Effort, type MessagesApi, type RunRecord } from "../agent/loop.js";
import { initPhysics } from "../core/sim.js";
import { CHORES } from "./chores.js";
import { renderMarkdown, summarize } from "./summary.js";

const { values } = parseArgs({
  options: {
    limit: { type: "string", default: String(CHORES.length) },
    effort: { type: "string", default: "high" },
    attempts: { type: "string", default: "12" },
    "max-cost": { type: "string", default: "30" },
    out: { type: "string", default: "results" },
  },
});

async function main(): Promise<void> {
  // Only the Ramen Protocol key is accepted, so a run can never bill another account by accident.
  const apiKey = process.env.RAMEN_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Set RAMEN_ANTHROPIC_API_KEY (the Ramen Protocol Anthropic key, with a workspace spend limit). Other keys are ignored on purpose.");
    process.exit(1);
  }
  const client = new Anthropic({ apiKey });
  // Stream: replies can be long (max_tokens 64000 covers thinking), and streaming avoids HTTP timeouts.
  const api: MessagesApi = { messages: { create: (body) => client.messages.stream(body).finalMessage() } };
  await initPhysics();

  const limit = Number(values.limit);
  const maxAttempts = Number(values.attempts);
  const maxCost = Number(values["max-cost"]);
  const effort = values.effort as Effort;
  const dir = join(String(values.out), new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });

  const runs: RunRecord[] = [];
  let spent = 0;
  for (const chore of CHORES.slice(0, limit)) {
    if (spent >= maxCost) {
      console.log(`Stopping: spent $${spent.toFixed(2)} of the $${maxCost} cap.`);
      break;
    }
    console.log(`\n▶ ${chore}`);
    const run = await runAgent(chore, {
      api,
      effort,
      maxAttempts,
      onAttempt: (a) => console.log(`  attempt ${a.attempt}: ${a.report?.summary ?? `invalid: ${a.errors[0] ?? "unknown error"}`}${a.note ? `  "${a.note}"` : ""}`),
    });
    spent += costUsd(run.usage);
    runs.push(run);
    appendFileSync(join(dir, "runs.jsonl"), JSON.stringify(run) + "\n");
    console.log(`  → ${run.outcome} in ${run.attempts.length} attempt(s), ${(run.wallMs / 1000).toFixed(0)} s, $${costUsd(run.usage).toFixed(3)}, cache reads ${run.usage.cacheRead} tokens, ${run.truncations} truncated`);
  }

  const summary = summarize(runs);
  const path = join(dir, "summary.md");
  writeFileSync(path, renderMarkdown(summary, runs, { model: runs[0]?.model ?? DEFAULT_MODEL, effort, maxAttempts }));
  console.log(`\nVerdict: ${summary.verdict}. Total $${summary.totalCostUsd.toFixed(2)}. Summary: ${path}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
