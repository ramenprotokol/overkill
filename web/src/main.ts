import "@fontsource/big-shoulders-display/latin-800";
import "@fontsource/barlow-semi-condensed/latin-400";
import "@fontsource/barlow-semi-condensed/latin-400-italic";
import "@fontsource/barlow-semi-condensed/latin-600";
import "@fontsource/martian-mono/latin-400";
import "./styles.css";
import { parseBlueprint } from "../../src/core/blueprint.js";
import { CHORES } from "../../src/spike/chores.js";
import { SIM_STEPS } from "../../src/core/constants.js";
import type { AttemptReport } from "../../src/core/trace.js";
import type { MachineFile, StoredAttempt } from "../../src/design/machines.js";
import { Board, frameOfStep, stepOfFrame, type RunView } from "./board.js";
import { MACHINES } from "./data.js";
import { Player } from "./player.js";

type Engine = typeof import("./engine.js");

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const OUTCOME: Record<StoredAttempt["outcome"], string> = {
  success: "Works",
  missed: "Missed",
  not_overkill: "Not overkill enough",
  invalid: "Invalid, never ran",
};

const sheet = $("sheet");
const board = new Board($("board-host"));
const ui = {
  play: $<HTMLButtonElement>("play"),
  replay: $<HTMLButtonElement>("replay"),
  scrub: $<HTMLInputElement>("scrub"),
  clock: $<HTMLOutputElement>("clock"),
  count: $("tb-count"),
  of: $("tb-of"),
  chainSub: $("tb-chain-sub"),
  stamp: $("stamp"),
  verify: $("verify"),
};

let engineError = "";
const engine: Promise<Engine | null> = import("./engine.js")
  .then(async (m) => {
    await m.initPhysics();
    return m;
  })
  .catch(() => {
    engineError = "The physics engine couldn't start in this browser (it needs WebAssembly). The drawings and revision history still show, but the machines can't run here.";
    return null;
  });

let view: { machine: MachineFile; attempt: StoredAttempt; run: RunView | null } | null = null;
let token = 0;

const player = new Player(
  (position, animate) => {
    board.render(position, animate);
    showProgress(position);
  },
  () => showControls(),
);

// ---- routing ---------------------------------------------------------------------------------------------------

interface Route {
  machine: MachineFile;
  rev: number;
  problem?: string;
}

/** Reads #/<chore-id>/<revision>. Anything else falls back to the first sheet, with a message saying why. */
function route(hash: string): Route {
  const first = MACHINES[0]!;
  const fallback = (problem?: string): Route => ({ machine: first, rev: first.attempts.length, ...(problem ? { problem } : {}) });
  if (hash === "" || hash === "#" || hash === "#/") return fallback();
  const m = /^#\/([a-z0-9-]{1,64})(?:\/(\d{1,3}))?$/.exec(hash);
  if (!m) return fallback(`That link doesn't point at a drawing in this set. Showing “${sentence(first.chore)}”.`);
  const machine = MACHINES.find((x) => x.id === m[1]);
  if (!machine) return fallback(`There's no drawing called “${m[1]}” in this set. Showing “${sentence(first.chore)}”.`);
  const last = machine.attempts.length;
  if (m[2] === undefined) return { machine, rev: last };
  const rev = Number(m[2]);
  if (rev < 1 || rev > last) {
    return { machine, rev: last, problem: `“${sentence(machine.chore)}” has ${last} revision${last === 1 ? "" : "s"}, not ${rev}. Showing revision ${last}.` };
  }
  return { machine, rev };
}

// ---- static parts of the sheet ---------------------------------------------------------------------------------

function summary(m: MachineFile): string {
  const n = m.attempts.length;
  if (m.status === "success") return `Worked on rev ${n} · ${m.attempts[n - 1]!.overkillScore} parts`;
  if (m.status === "gave_up") return `Gave up after ${n} revs`;
  return `No luck in ${n} revs`;
}

function renderIndex(current: MachineFile): void {
  $("index-count").textContent = `${MACHINES.length} of ${CHORES.length} eval chores drawn`;
  const list = $("chores");
  list.replaceChildren(
    ...MACHINES.map((m) => {
      const li = make("li");
      const a = make("a", "chore");
      a.href = `#/${m.id}`;
      if (m === current) a.setAttribute("aria-current", "page");
      const finale = (m.attempts.at(-1)?.input as { finale?: { kind?: string } } | undefined)?.finale?.kind ?? "";
      a.append(make("span", "chore-kind", finale), make("span", "chore-name", sentence(m.chore)), make("span", "chore-result", summary(m)));
      li.append(a);
      return li;
    }),
  );
  // In the phone layout the index scrolls sideways; bring the current sheet into view without moving the page.
  const item = list.querySelector<HTMLElement>('[aria-current="page"]')?.parentElement;
  if (item && list.scrollWidth > list.clientWidth) list.scrollLeft = item.offsetLeft - list.offsetLeft;
}

function renderRevisions(m: MachineFile, rev: number): void {
  $("revs").replaceChildren(
    ...m.attempts.map((a) => {
      const li = make("li");
      const link = make("a", `rev rev-${a.outcome}`);
      link.href = `#/${m.id}/${a.attempt}`;
      if (a.attempt === rev) link.setAttribute("aria-current", "true");
      const delta = make("span", "delta", String(a.attempt));
      delta.setAttribute("aria-label", `Revision ${a.attempt}`);
      const note = (a.input as { note?: unknown }).note;
      link.append(delta, make("span", "rev-outcome", OUTCOME[a.outcome]), make("span", "rev-note", typeof note === "string" ? note : "(no note)"));
      li.append(link);
      return li;
    }),
  );
  const a = m.attempts[rev - 1]!;
  const tail = a.outcome === "success" ? "\n\n(The loop stops at a success, so the model never reads this one. It's the report the harness printed.)" : "";
  $("feedback").textContent = a.feedback + tail;
}

function renderTitleBlock(m: MachineFile, a: StoredAttempt): void {
  $("tb-chore").textContent = sentence(m.chore);
  $("tb-rev").textContent = `${a.attempt} of ${m.attempts.length} · budget ${m.maxAttempts}`;
  const finale = (a.input as { finale?: { kind?: unknown; label?: unknown } }).finale;
  $("tb-finale").textContent = typeof finale?.kind === "string" ? `${finale.kind} · “${String(finale.label ?? "")}”` : "none";
  const note = (a.input as { note?: unknown }).note;
  $("drawing-note").textContent = typeof note === "string" && note ? `Note, rev ${a.attempt}: ${note}` : "";
}

// ---- the run ---------------------------------------------------------------------------------------------------

/** Plays on for 2.5 simulated seconds after the machine's last chain event, then stops. */
function endFrameOf(report: AttemptReport): number {
  let last = report.finaleStep ?? 0;
  for (const step of Object.values(report.joinedAt)) last = Math.max(last, step);
  return frameOfStep(Math.min(SIM_STEPS - 1, last + 150));
}

function stampText(a: StoredAttempt): string {
  return a.outcome === "success" ? "Works" : OUTCOME[a.outcome];
}

async function show(r: Route): Promise<void> {
  const my = ++token;
  const { machine, rev } = r;
  const attempt = machine.attempts[rev - 1]!;
  const message = $("route-message");
  message.hidden = !r.problem;
  message.textContent = r.problem ?? "";
  document.title = `${sentence(machine.chore)}, rev ${rev} · OVERKILL`;
  renderIndex(machine);
  renderRevisions(machine, rev);
  renderTitleBlock(machine, attempt);

  const parsed = parseBlueprint(attempt.input);
  const bp = parsed.ok ? parsed.blueprint : null;
  const label = { title: `${sentence(machine.chore)}, revision ${rev}`, desc: attempt.feedback };
  board.show(bp, null, label);
  view = { machine, attempt, run: null };
  player.load(0);
  ui.stamp.textContent = stampText(attempt);
  ui.stamp.className = `stamp stamp-${attempt.outcome}`;
  sheet.dataset.state = "loading";
  delete sheet.dataset.verified;
  ui.verify.textContent = "Running the machine in this browser…";

  const eng = await engine;
  if (my !== token) return;
  if (!eng) {
    ui.verify.textContent = engineError;
    sheet.dataset.state = "error";
    return;
  }

  const t0 = performance.now();
  const judged = eng.judgeAttempt(attempt.input, attempt.attempt, machine.maxAttempts, { record: true });
  const ms = Math.round(performance.now() - t0);
  const hash = judged.record.traceHash;
  const matches = hash === attempt.hash && judged.feedback === attempt.feedback;
  sheet.dataset.hash = hash ?? "none";
  sheet.dataset.expected = attempt.hash ?? "none";
  sheet.dataset.verified = matches ? "match" : "mismatch";

  const report = judged.record.report;
  const frames = judged.sim?.frames;
  if (!report || !frames) {
    ui.verify.textContent = matches
      ? "This revision was invalid, so it never ran. Your browser rejected it with the same errors."
      : "This revision was invalid, and your browser's errors differ from the recorded ones.";
    ui.stamp.classList.add("on");
    sheet.dataset.state = "ready";
    showProgress(0);
    return;
  }

  const run: RunView = { frames, report, endFrame: endFrameOf(report) };
  view = { machine, attempt, run };
  board.show(bp, run, label);
  ui.verify.textContent = matches
    ? `Ran here in ${ms} ms. Trace ${hash} matches the run recorded in Node.`
    : `Ran here, but the trace came out ${hash ?? "empty"} instead of the recorded ${attempt.hash ?? "none"}, so this device's run doesn't match the record.`;
  player.load(run.endFrame, reducedMotion.matches ? run.endFrame : 0);
  sheet.dataset.state = "ready";
  if (!reducedMotion.matches) player.play();
}

function showProgress(position: number): void {
  const run = view?.run;
  const a = view?.attempt;
  if (!a) return;
  if (!run) {
    ui.count.textContent = "0";
    ui.of.textContent = "";
    ui.chainSub.textContent = a.outcome === "invalid" ? "never ran" : "waiting for the physics engine";
    ui.clock.textContent = "—";
    return;
  }
  const r = run.report;
  ui.count.textContent = String(board.chainSoFar(position));
  ui.of.textContent = ` / ${r.chain.length}`;
  ui.chainSub.textContent = chainCaption(r, view!.machine.chore);
  const step = stepOfFrame(position);
  ui.clock.textContent = step < 0 ? "settling" : `${(step / 60).toFixed(2)} s`;
  const stampAt = r.success && r.finaleStep !== null ? frameOfStep(r.finaleStep) : run.endFrame;
  ui.stamp.classList.toggle("on", position >= stampAt);
  ui.scrub.value = String(Math.round(position));
}

function chainCaption(r: AttemptReport, chore: string): string {
  if (r.outcome === "success") return `parts to ${chore}`;
  if (r.outcome === "missed") return `parts, then it stopped at ${r.stoppedAt ?? "the push"}`;
  if (r.summary.includes("even without the first push")) return "parts, but the finale gets hit without the push too";
  if (r.finaleHitBy !== null && r.joinedAt[r.finaleHitBy] === undefined) return `parts; ${r.finaleHitBy} hit the finale on its own`;
  return "parts reached the finale; it takes 5";
}

function showControls(): void {
  const ready = !!view?.run;
  ui.play.disabled = !ready;
  ui.replay.disabled = !ready;
  ui.scrub.disabled = !ready;
  ui.play.textContent = player.playing ? "Pause" : "Play";
  ui.play.setAttribute("aria-pressed", String(player.playing));
  ui.scrub.max = String(Math.max(1, player.end));
  ui.scrub.value = String(Math.round(player.position));
}

// ---- wiring ----------------------------------------------------------------------------------------------------

ui.play.addEventListener("click", () => player.toggle());
ui.replay.addEventListener("click", () => {
  player.seek(0);
  player.play();
});
ui.scrub.addEventListener("input", () => player.seek(Number(ui.scrub.value)));
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="speed"]')) {
  radio.addEventListener("change", () => {
    if (radio.checked) player.speed = Number(radio.value);
  });
}
window.addEventListener("hashchange", () => void show(route(location.hash)));
void show(route(location.hash));
