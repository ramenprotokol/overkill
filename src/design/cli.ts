import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SYSTEM_PROMPT, userPrompt } from "../agent/prompt.js";
import { initPhysics } from "../core/sim.js";
import { CHORES } from "../spike/chores.js";
import { RunOver, giveUpStep, newMachine, previewStep, simulateStep } from "./harness.js";
import { choreId, type MachineFile } from "./machines.js";

const USAGE = `Offline design harness: the agent loop's preview and simulate tools, with no model and no network.

  npm run design -- --list
  npm run design -- --chore <id> --prompt                          the system prompt and chore the model gets
  npm run design -- --chore <id> --preview --blueprint <file.json>  preview (no attempt used, 3 per attempt)
  npm run design -- --chore <id> --blueprint <file.json>            simulate (uses an attempt, always recorded)
  npm run design -- --chore <id> --history
  npm run design -- --chore <id> --give-up "<one sentence>"

Every attempt is appended to <dir>/<id>.json (default dir: machines) and can't be undone or rewritten.`;

function describe(m: MachineFile): string {
  const last = m.attempts.at(-1);
  if (m.status === "success") return `worked on attempt ${m.attempts.length} (${last!.overkillScore} parts)`;
  if (m.status === "out_of_attempts") return `failed: all ${m.maxAttempts} attempts used`;
  if (m.status === "gave_up") return `gave up after ${m.attempts.length} attempts`;
  return m.attempts.length === 0 ? "not started" : `designing: ${m.attempts.length} of ${m.maxAttempts} attempts used`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      chore: { type: "string" },
      blueprint: { type: "string" },
      preview: { type: "boolean", default: false },
      prompt: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      history: { type: "boolean", default: false },
      "give-up": { type: "string" },
      dir: { type: "string", default: "machines" },
      help: { type: "boolean", default: false },
    },
  });
  const dir = values.dir;
  const fileFor = (id: string) => join(dir, `${id}.json`);
  const load = (chore: string): MachineFile => {
    const path = fileFor(choreId(chore));
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as MachineFile) : newMachine(chore);
  };
  const save = (m: MachineFile) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileFor(m.id), `${JSON.stringify(m, null, 2)}\n`);
  };

  if (values.help || process.argv.length <= 2) {
    console.log(USAGE);
    return 0;
  }
  if (values.list) {
    for (const chore of CHORES) console.log(`${choreId(chore).padEnd(32)} ${describe(load(chore))}`);
    return 0;
  }

  const chore = CHORES.find((c) => choreId(c) === values.chore);
  if (!chore) {
    console.error(`Unknown chore id "${values.chore ?? ""}". Run: npm run design -- --list`);
    return 1;
  }
  let m = load(chore);

  if (values.prompt) {
    console.log(`${SYSTEM_PROMPT}\n\n---\n\n${userPrompt(chore, m.maxAttempts, m.maxPreviewsPerAttempt)}`);
    return 0;
  }
  if (values.history) {
    for (const a of m.attempts) console.log(`--- attempt ${a.attempt} (${a.previews} previews before it) ---\n${a.feedback}\n`);
    console.log(`Status: ${describe(m)}${m.gaveUp ? ` (${m.gaveUp})` : ""}`);
    return 0;
  }

  try {
    if (values["give-up"] !== undefined) {
      m = giveUpStep(m, values["give-up"]);
      save(m);
      console.log(`Recorded: gave up on "${chore}" after ${m.attempts.length} attempts.`);
      return 0;
    }
    if (!values.blueprint) {
      console.error("Pass --blueprint <file.json> to preview or simulate a design.");
      return 1;
    }
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(values.blueprint, "utf8"));
    } catch (e) {
      // The model's tool input is always JSON, so a file that isn't is a harness mistake, not an attempt.
      console.error(`Couldn't read ${values.blueprint} as JSON: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    await initPhysics();
    if (values.preview) {
      const step = previewStep(m, input);
      save(step.machine);
      console.log(step.text);
      return 0;
    }
    const step = simulateStep(m, input);
    save(step.machine);
    console.log(step.text);
    console.error(`\nRecorded attempt ${step.machine.attempts.length} in ${fileFor(m.id)}: ${describe(step.machine)}.`);
    return 0;
  } catch (e) {
    if (e instanceof RunOver) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

process.exitCode = await main();
