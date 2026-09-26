import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { addUsage, costUsd, emptyUsage } from "../agent/cost.js";
import { DEFAULT_MODEL, runAgent, type MessagesApi, type RunRecord } from "../agent/loop.js";
import { initPhysics } from "../core/sim.js";
import { CHORES } from "./chores.js";
import { parseSpikeOptions, type SpikeOptions } from "./options.js";
import { renderMarkdown, summarize } from "./summary.js";

/** One maximum-length reply (64k output tokens ≈ $1.28) plus a large prompt. */
const WORST_CALL_USD = 1.5;
/** A stalled stream is abandoned after this long. */
const CALL_TIMEOUT_MS = 10 * 60 * 1000;

function readOptions(): SpikeOptions {
  const { values } = parseArgs({
    options: {
      limit: { type: "string", default: String(CHORES.length) },
      effort: { type: "string", default: "high" },
      attempts: { type: "string", default: "12" },
      "max-cost": { type: "string", default: "30" },
      out: { type: "string", default: "results" },
    },
  });
  return parseSpikeOptions(values);
}

async function main(): Promise<void> {
  // Only the Ramen Protocol key is accepted, so a run can never bill another account by accident.
  const apiKey = process.env.RAMEN_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Set RAMEN_ANTHROPIC_API_KEY (the Ramen Protocol Anthropic key, with a workspace spend limit). Other keys are ignored on purpose.");
    process.exit(1);
  }

  // Every flag is checked before any client, physics or directory exists, so a typo can't change cost or results.
  let opts: SpikeOptions;
  try {
    opts = readOptions();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // Every request goes to https://api.anthropic.com with the Ramen key as its only credential: ANTHROPIC_BASE_URL can't
  // redirect it, ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN and config-file profiles are never consulted (an explicit key
  // and a null auth token skip the SDK's credential lookup), and ANTHROPIC_CUSTOM_HEADERS can't add headers.
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  const client = new Anthropic({ apiKey, authToken: null, baseURL: "https://api.anthropic.com" });

  // `spent` counts every billed call, including one in a run the cap cuts off. A call is only made when even a
  // maximum-length reply would keep spending within the cap.
  let spent = 0;
  let capHit = false;
  const addSpend = (usage: Anthropic.Usage) => {
    spent += costUsd(addUsage(emptyUsage(), usage));
  };
  const api: MessagesApi = {
    messages: {
      create: async (body) => {
        if (spent + WORST_CALL_USD > opts.maxCost) {
          capHit = true;
          throw new Error(`cost cap reached: $${spent.toFixed(2)} spent of $${opts.maxCost}`);
        }
        // Stream: replies can be long (max_tokens 64000 covers thinking), and streaming avoids HTTP timeouts.
        const stream = client.messages.stream(body, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
        try {
          const msg = await stream.finalMessage();
          addSpend(msg.usage);
          return msg;
        } catch (e) {
          // A stream that dies midway may still be billed for what it produced, so count the usage that arrived.
          const partial = stream.currentMessage?.usage;
          if (partial) addSpend(partial);
          throw e;
        }
      },
    },
  };
  await initPhysics();

  const dir = join(opts.out, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const summaryPath = join(dir, "summary.md");
  const planned = CHORES.slice(0, opts.limit);

  const runs: RunRecord[] = [];
  let cutOff: string | null = null;
  let stoppedByCap = false;
  const writeSummary = () =>
    writeFileSync(
      summaryPath,
      renderMarkdown(summarize(runs, planned.length), runs, {
        model: runs[0]?.model ?? DEFAULT_MODEL,
        effort: opts.effort,
        maxAttempts: opts.maxAttempts,
        planned: planned.length,
        maxCost: opts.maxCost,
        spentUsd: spent,
        cutOff,
        stoppedByCap,
      }),
    );

  for (const chore of planned) {
    if (spent + WORST_CALL_USD > opts.maxCost) {
      stoppedByCap = true;
      console.log(`Stopping: $${spent.toFixed(2)} spent, and one more call (up to $${WORST_CALL_USD}) could pass the $${opts.maxCost} cap.`);
      break;
    }
    console.log(`\n▶ ${chore}`);
    const run = await runAgent(chore, {
      api,
      effort: opts.effort,
      maxAttempts: opts.maxAttempts,
      onAttempt: (a) => console.log(`  attempt ${a.attempt}: ${a.report?.summary ?? `invalid: ${a.errors[0] ?? "unknown error"}`}${a.note ? `  "${a.note}"` : ""}`),
    });

    if (capHit) {
      // The budget, not the model, ended this run, so it would skew the verdict; keep it on record but out of the summary.
      stoppedByCap = true;
      cutOff = chore;
      appendFileSync(join(dir, "runs.jsonl"), JSON.stringify({ ...run, cutOffByCap: true }) + "\n");
      console.log(`  → cut off by the $${opts.maxCost} cost cap after ${run.attempts.length} attempt(s); left out of the summary`);
      writeSummary();
      break;
    }

    runs.push(run);
    appendFileSync(join(dir, "runs.jsonl"), JSON.stringify(run) + "\n");
    console.log(`  → ${run.outcome} in ${run.attempts.length} attempt(s), ${(run.wallMs / 1000).toFixed(0)} s, $${costUsd(run.usage).toFixed(3)}, cache reads ${run.usage.cacheRead} tokens, ${run.truncations} truncated${run.error !== undefined ? `, error: ${run.error}` : ""}`);
    writeSummary();

    if (run.outcome === "api_error" && /^(400|401|403)\b/.test(run.error ?? "")) {
      console.log(`Stopping: the API rejected the request (${run.error}). Fix the key or request before re-running.`);
      break;
    }
  }

  writeSummary();
  const verdict = summarize(runs, planned.length).verdict;
  console.log(`\nVerdict: ${verdict}${stoppedByCap ? " (provisional: stopped by the cost cap)" : ""}. Spent $${spent.toFixed(2)}. Summary: ${summaryPath}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
