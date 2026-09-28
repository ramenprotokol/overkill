import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../agent/cost.js";
import { DEFAULT_MODEL, runAgent, type RunRecord } from "../agent/loop.js";
import { initPhysics } from "../core/sim.js";
import { createCappedApi, PartialUsageError, WORST_CALL_USD, type StreamCall } from "./capped-api.js";
import { CHORES } from "./chores.js";
import { parseSpikeOptions, type SpikeOptions } from "./options.js";
import { provisionalCauses, renderMarkdown, summarize, type ReportMeta } from "./summary.js";

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
  // The SDK's automatic retries (2 by default, on connection errors, 408/409/429 and 5xx) are off: a retried request
  // is one the cost cap never checked, and one the API had already accepted could still bill its input tokens.
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  const client = new Anthropic({ apiKey, authToken: null, baseURL: "https://api.anthropic.com", maxRetries: 0 });

  // Stream: replies can be long (max_tokens 64000 covers thinking), and streaming avoids HTTP timeouts. If the stream
  // dies midway, the SDK's usage snapshot (real input counts, output not yet reported) is handed to the adapter, which
  // charges it with a full max_tokens of output so it still counts against the cap.
  const stream: StreamCall = async (body, signal) => {
    const s = client.messages.stream(body, { signal });
    try {
      return await s.finalMessage();
    } catch (e) {
      const partial = s.currentMessage?.usage;
      throw partial ? new PartialUsageError(e, partial) : e;
    }
  };
  // Counts every billed call, including one in a run the cap cuts off, and refuses any call that could pass the cap.
  const capped = createCappedApi(stream, opts.maxCost);
  const { api } = capped;
  await initPhysics();

  const dir = join(opts.out, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const summaryPath = join(dir, "summary.md");
  // Gates are judged against the full eval set, so a --limit run reports "only N of 20 chores ran" and is never GO.
  const chores = CHORES.slice(0, opts.limit);

  const runs: RunRecord[] = [];
  let cutOff: string | null = null;
  let stoppedByCap = false;
  let stoppedByApiError = false;
  const meta = (): ReportMeta => ({
    model: runs[0]?.model ?? DEFAULT_MODEL,
    effort: opts.effort,
    maxAttempts: opts.maxAttempts,
    planned: CHORES.length,
    limit: chores.length,
    maxCost: opts.maxCost,
    spentUsd: capped.spent(),
    cutOff,
    stoppedByCap,
    stoppedByApiError,
  });
  const writeSummary = () => writeFileSync(summaryPath, renderMarkdown(summarize(runs, CHORES.length), runs, meta()));

  for (const chore of chores) {
    if (capped.spent() + WORST_CALL_USD > opts.maxCost) {
      stoppedByCap = true;
      console.log(`Stopping: $${capped.spent().toFixed(2)} spent, and one more call (up to $${WORST_CALL_USD}) could pass the $${opts.maxCost} cap.`);
      break;
    }
    console.log(`\n▶ ${chore}`);
    const run = await runAgent(chore, {
      api,
      effort: opts.effort,
      maxAttempts: opts.maxAttempts,
      onAttempt: (a) => console.log(`  attempt ${a.attempt}: ${a.report?.summary ?? `invalid: ${a.errors[0] ?? "unknown error"}`}${a.note ? `  "${a.note}"` : ""}`),
    });

    if (capped.capHit()) {
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
      stoppedByApiError = true;
      console.log(`Stopping: the API rejected the request (${run.error}). Fix the key or request before re-running.`);
      break;
    }
  }

  writeSummary();
  const causes = provisionalCauses(runs, meta());
  const verdict =
    runs.length === 0
      ? "NO VERDICT (no runs completed)"
      : `${summarize(runs, CHORES.length).verdict}${causes.length > 0 ? ` (provisional: ${causes.join("; ")})` : ""}`;
  console.log(`\nVerdict: ${verdict}. Spent $${capped.spent().toFixed(2)}. Summary: ${summaryPath}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
