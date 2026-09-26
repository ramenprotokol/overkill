import Anthropic from "@anthropic-ai/sdk";
import { parseBlueprint, type Blueprint } from "../core/blueprint.js";
import { ENGINE } from "../core/constants.js";
import { preview } from "../core/preview.js";
import { runSim } from "../core/sim.js";
import { analyze, type AttemptReport } from "../core/trace.js";
import { addUsage, emptyUsage, type Usage } from "./cost.js";
import { formatInvalid, formatPreview, formatReport } from "./format.js";
import { SYSTEM_PROMPT, TOOLS, userPrompt } from "./prompt.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The one SDK call the loop needs — injectable so tests can script the model. */
export interface MessagesApi {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface AttemptRecord {
  attempt: number;
  blueprint: Blueprint | null;
  report: AttemptReport | null;
  errors: string[];
  note: string;
  traceHash: string | null;
}

export type RunOutcome = "success" | "gave_up" | "out_of_attempts" | "turn_limit" | "refused" | "api_error";

export interface RunRecord {
  chore: string;
  outcome: RunOutcome;
  attempts: AttemptRecord[];
  previews: number;
  turns: number;
  /** Replies cut off by max_tokens or by the context window. */
  truncations: number;
  usage: Usage;
  wallMs: number;
  model: string;
  effort: Effort;
  engine: string;
  error?: string;
}

export interface AgentOptions {
  api: MessagesApi;
  model?: string;
  effort?: Effort;
  maxAttempts?: number;
  maxPreviewsPerAttempt?: number;
  /** Hard stop on model calls, whatever happens. Default: maxAttempts * (maxPreviewsPerAttempt + 1) + 12. */
  maxTurns?: number;
  onAttempt?: (a: AttemptRecord) => void;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

function toolResult(id: string, content: string, isError = false): Anthropic.MessageParam {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] };
}

/**
 * Runs one chore. History is append-only: every model reply is appended unchanged (thinking blocks included)
 * and nothing earlier is ever edited, which Opus 5.5's preserved thinking requires.
 */
export async function runAgent(chore: string, opts: AgentOptions): Promise<RunRecord> {
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? "high";
  const maxAttempts = opts.maxAttempts ?? 12;
  const maxPreviews = opts.maxPreviewsPerAttempt ?? 3;
  const maxTurns = opts.maxTurns ?? maxAttempts * (maxPreviews + 1) + 12;
  const started = Date.now();

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt(chore, maxAttempts, maxPreviews) }];
  const attempts: AttemptRecord[] = [];
  let usage = emptyUsage();
  let previews = 0;
  let previewsThisAttempt = 0;
  let turns = 0;
  let truncations = 0;
  let nudged = false;
  let outcome: RunOutcome = "turn_limit";
  let error: string | undefined;

  const record = (a: AttemptRecord) => {
    attempts.push(a);
    opts.onAttempt?.(a);
  };

  while (turns < maxTurns) {
    turns++;
    let res: Anthropic.Message;
    try {
      res = await opts.api.messages.create({
        model,
        max_tokens: 64000, // Opus 5.5 thinking counts toward max_tokens; this large a cap means callers must stream.
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        output_config: { effort },
        cache_control: { type: "ephemeral" },
        messages,
      });
    } catch (e) {
      outcome = "api_error";
      error = e instanceof Anthropic.APIError ? e.message : String(e);
      break;
    }
    usage = addUsage(usage, res.usage);
    if (res.stop_reason === "refusal") {
      outcome = "refused";
      break;
    }
    messages.push({ role: "assistant", content: res.content });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded") {
      truncations++;
      if (call) messages.push(toolResult(call.id, "Your reply was cut off before the blueprint was complete. Send it again, shorter.", true));
      else messages.push({ role: "user", content: "Your reply was cut off. Continue with a tool call." });
      continue;
    }

    if (!call) {
      if (res.content.length === 0) {
        outcome = "gave_up";
        break;
      }
      if (attempts.length === 0 && !nudged) {
        nudged = true;
        messages.push({ role: "user", content: "Please design a machine and call `simulate` (or `preview` first)." });
        continue;
      }
      outcome = "gave_up";
      break;
    }

    if (call.name === "preview") {
      if (previewsThisAttempt >= maxPreviews) {
        messages.push(toolResult(call.id, `Preview limit reached (${maxPreviews} per attempt). Call simulate.`, true));
      } else {
        previews++;
        previewsThisAttempt++;
        messages.push(toolResult(call.id, formatPreview(preview(call.input))));
      }
      continue;
    }

    if (call.name !== "simulate") {
      messages.push(toolResult(call.id, `Unknown tool "${call.name}". Use preview or simulate.`, true));
      continue;
    }

    previewsThisAttempt = 0;
    const n = attempts.length + 1;
    const parsed = parseBlueprint(call.input);
    if (!parsed.ok) {
      record({ attempt: n, blueprint: null, report: null, errors: parsed.errors, note: "", traceHash: null });
      messages.push(toolResult(call.id, formatInvalid(n, maxAttempts, parsed.errors), true));
    } else {
      const sim = runSim(parsed.blueprint);
      const report = analyze(parsed.blueprint, sim);
      record({ attempt: n, blueprint: parsed.blueprint, report, errors: [], note: parsed.blueprint.note, traceHash: sim.hash });
      if (report.success) {
        outcome = "success";
        break;
      }
      messages.push(toolResult(call.id, formatReport(n, maxAttempts, report)));
    }
    if (attempts.length >= maxAttempts) {
      outcome = "out_of_attempts";
      break;
    }
  }

  return {
    chore, outcome, attempts, previews, turns, truncations, usage,
    wallMs: Date.now() - started, model, effort, engine: ENGINE,
    ...(error !== undefined ? { error } : {}),
  };
}
