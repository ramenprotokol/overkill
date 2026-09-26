import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { runAgent, type MessagesApi } from "../../src/agent/loop.js";
import { initPhysics } from "../../src/core/sim.js";
import { dudMachine, goldenDominoes } from "../fixtures/golden.js";

let nextId = 0;
const toolUse = (name: string, input: unknown) =>
  ({ type: "tool_use", id: `toolu_${nextId++}`, name, input }) as unknown as Anthropic.ContentBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Anthropic.ContentBlock;
const reply = (content: Anthropic.ContentBlock[], stop_reason: string = "tool_use") =>
  ({
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 80 },
  }) as unknown as Anthropic.Message;

/** The API rejects a request where an earlier tool_use has no tool_result right after it; enforce that on every call. */
function assertToolPairing(messages: Anthropic.MessageParam[]) {
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || i === messages.length - 1 || typeof m.content === "string") return;
    const next = messages[i + 1]!;
    const resultIds =
      typeof next.content === "string"
        ? []
        : next.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []));
    for (const b of m.content) {
      if (b.type === "tool_use" && !resultIds.includes(b.id)) {
        throw new Error(`tool_use ${b.id} in message ${i} has no matching tool_result in message ${i + 1}`);
      }
    }
  });
}

function fake(responses: Anthropic.Message[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const api: MessagesApi = {
    messages: {
      create: async (body) => {
        assertToolPairing(body.messages);
        calls.push(structuredClone(body));
        const r = responses.shift();
        if (!r) throw new Error("no more scripted responses");
        return r;
      },
    },
  };
  return { api, calls };
}

const lastUserContent = (body: Anthropic.MessageCreateParamsNonStreaming) => body.messages.at(-1)!.content;

beforeAll(async () => {
  await initPhysics();
});

describe("runAgent", () => {
  it("stops on the first successful simulate", async () => {
    const { api, calls } = fake([reply([toolUse("simulate", goldenDominoes)])]);
    const run = await runAgent("turn off the light", { api });
    expect(run.outcome).toBe("success");
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]!.report!.overkillScore).toBe(6);
    expect(run.attempts[0]!.traceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(run.attempts[0]!.note).toBe(goldenDominoes.note);
    expect(run.usage).toEqual({ input: 100, output: 50, cacheWrite: 0, cacheRead: 80 });
    expect(calls).toHaveLength(1);
  });

  it("sends the Opus 5.5 request shape", async () => {
    const { api, calls } = fake([reply([toolUse("simulate", goldenDominoes)])]);
    await runAgent("turn off the light", { api });
    const body = calls[0]!;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.thinking).toBeUndefined();
    expect(body.tools!.map((t) => (t as { name: string }).name)).toEqual(["preview", "simulate"]);
  });

  it("lets the model preview without using an attempt", async () => {
    const { api, calls } = fake([reply([toolUse("preview", goldenDominoes)]), reply([toolUse("simulate", goldenDominoes)])]);
    const run = await runAgent("turn off the light", { api });
    expect(run.previews).toBe(1);
    expect(run.attempts).toHaveLength(1);
    expect(JSON.stringify(lastUserContent(calls[1]!))).toContain("Preview (no attempt used).");
  });

  it("caps previews per attempt", async () => {
    const { api, calls } = fake([
      reply([toolUse("preview", goldenDominoes)]),
      reply([toolUse("preview", goldenDominoes)]),
      reply([toolUse("simulate", goldenDominoes)]),
    ]);
    const run = await runAgent("turn off the light", { api, maxPreviewsPerAttempt: 1 });
    expect(run.previews).toBe(1);
    const blocked = lastUserContent(calls[2]!) as Anthropic.ToolResultBlockParam[];
    expect(blocked[0]!.is_error).toBe(true);
  });

  it("counts an invalid blueprint as a used attempt and reports it as an error", async () => {
    const { api, calls } = fake([reply([toolUse("simulate", { parts: "nope" })]), reply([toolUse("simulate", goldenDominoes)])]);
    const run = await runAgent("turn off the light", { api });
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0]!.errors.length).toBeGreaterThan(0);
    const result = lastUserContent(calls[1]!) as Anthropic.ToolResultBlockParam[];
    expect(result[0]!.is_error).toBe(true);
    expect(run.outcome).toBe("success");
  });

  it("stops at the attempt cap", async () => {
    const { api } = fake([reply([toolUse("simulate", dudMachine)]), reply([toolUse("simulate", dudMachine)])]);
    const run = await runAgent("turn off the light", { api, maxAttempts: 2 });
    expect(run.outcome).toBe("out_of_attempts");
    expect(run.attempts).toHaveLength(2);
  });

  it("treats a reply without a tool call after an attempt as giving up", async () => {
    const { api } = fake([reply([toolUse("simulate", dudMachine)]), reply([text("No layout on this board can work.")], "end_turn")]);
    const run = await runAgent("turn off the light", { api });
    expect(run.outcome).toBe("gave_up");
    expect(run.attempts).toHaveLength(1);
  });

  it("nudges once when the first reply has no tool call", async () => {
    const { api, calls } = fake([reply([text("Which chore?")], "end_turn"), reply([toolUse("simulate", goldenDominoes)])]);
    const run = await runAgent("turn off the light", { api });
    expect(run.outcome).toBe("success");
    expect(JSON.stringify(lastUserContent(calls[1]!))).toContain("call `simulate`");
  });

  it("does not use an attempt when a reply is cut off by max_tokens", async () => {
    const { api } = fake([reply([toolUse("simulate", { note: "trunc" })], "max_tokens"), reply([toolUse("simulate", goldenDominoes)])]);
    const run = await runAgent("turn off the light", { api });
    expect(run.attempts).toHaveLength(1);
    expect(run.outcome).toBe("success");
  });

  it("records a refusal", async () => {
    const { api } = fake([reply([], "refusal")]);
    expect((await runAgent("turn off the light", { api })).outcome).toBe("refused");
  });

  it("records an API failure instead of throwing", async () => {
    const api: MessagesApi = { messages: { create: async () => { throw new Error("boom"); } } };
    const run = await runAgent("turn off the light", { api });
    expect(run.outcome).toBe("api_error");
    expect(run.error).toBe("Error: boom");
  });

  it("records an SDK API error by its own message, which already carries the status", async () => {
    const err = new Anthropic.APIError(529, undefined, "Overloaded", undefined);
    const api: MessagesApi = { messages: { create: async () => { throw err; } } };
    const run = await runAgent("turn off the light", { api });
    expect(run.outcome).toBe("api_error");
    expect(run.error).toBe(err.message);
  });

  it("stops with turn_limit when the model keeps previewing", async () => {
    const { api } = fake([
      reply([toolUse("preview", goldenDominoes)]),
      reply([toolUse("preview", goldenDominoes)]),
      reply([toolUse("preview", goldenDominoes)]),
    ]);
    const run = await runAgent("turn off the light", { api, maxTurns: 3 });
    expect(run.outcome).toBe("turn_limit");
    expect(run.turns).toBe(3);
  });

  it("answers an unknown tool with an error and carries on", async () => {
    const { api, calls } = fake([reply([toolUse("launch", {})]), reply([toolUse("simulate", goldenDominoes)])]);
    const run = await runAgent("turn off the light", { api });
    expect(run.outcome).toBe("success");
    const result = lastUserContent(calls[1]!) as Anthropic.ToolResultBlockParam[];
    expect(result[0]!.is_error).toBe(true);
  });

  it("treats an empty reply as giving up", async () => {
    const { api, calls } = fake([reply([], "end_turn")]);
    const run = await runAgent("turn off the light", { api });
    expect(run.outcome).toBe("gave_up");
    expect(calls).toHaveLength(1);
  });

  it("counts truncated replies", async () => {
    const cut = toolUse("simulate", { note: "trunc" }) as Anthropic.ToolUseBlock;
    const { api, calls } = fake([reply([cut], "max_tokens"), reply([toolUse("simulate", goldenDominoes)])]);
    const run = await runAgent("turn off the light", { api });
    expect(run.outcome).toBe("success");
    expect(run.truncations).toBe(1);
    expect(run.attempts).toHaveLength(1);
    const result = lastUserContent(calls[1]!) as Anthropic.ToolResultBlockParam[];
    expect(result[0]!.tool_use_id).toBe(cut.id);
    expect(result[0]!.is_error).toBe(true);
  });

  it("counts a context-window stop as a truncation", async () => {
    const cut = toolUse("simulate", { note: "trunc" }) as Anthropic.ToolUseBlock;
    const { api, calls } = fake([
      reply([cut], "model_context_window_exceeded"),
      reply([toolUse("simulate", goldenDominoes)]),
    ]);
    const run = await runAgent("turn off the light", { api });
    expect(run.outcome).toBe("success");
    expect(run.truncations).toBe(1);
    expect(run.attempts).toHaveLength(1);
    const result = lastUserContent(calls[1]!) as Anthropic.ToolResultBlockParam[];
    expect(result[0]!.tool_use_id).toBe(cut.id);
    expect(result[0]!.is_error).toBe(true);
  });

  it("reports zero truncations when nothing was cut off", async () => {
    const { api } = fake([reply([toolUse("simulate", goldenDominoes)])]);
    expect((await runAgent("turn off the light", { api })).truncations).toBe(0);
  });

  it("scales the default turn cap with attempts and previews", async () => {
    const { api } = fake(Array.from({ length: 20 }, () => reply([toolUse("preview", goldenDominoes)])));
    const run = await runAgent("turn off the light", { api, maxAttempts: 1, maxPreviewsPerAttempt: 1 });
    expect(run.outcome).toBe("turn_limit");
    expect(run.turns).toBe(1 * (1 + 1) + 12);
  });

  it("only ever appends to the conversation", async () => {
    const { api, calls } = fake([
      reply([toolUse("preview", dudMachine)]),
      reply([toolUse("simulate", dudMachine)]),
      reply([toolUse("simulate", goldenDominoes)]),
    ]);
    await runAgent("turn off the light", { api });
    expect(calls).toHaveLength(3);
    for (let i = 0; i + 1 < calls.length; i++) {
      const before = calls[i]!.messages;
      expect(calls[i + 1]!.messages.slice(0, before.length)).toEqual(before);
    }
  });
});
