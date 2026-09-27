# OVERKILL — Design Spec

- **Status:** approved design, pre-spike
- **Date:** 2026-09-25
- **Owner:** Ramen Protocol (`ramenprotokol`)
- **Built with:** Claude Opus 5.5 (`claude-opus-5-5`)
- **Working name:** OVERKILL (final public name is an open decision — see §12)

## 1. One-line pitch

Type a tiny chore. Claude Opus 5.5 designs an absurd chain-reaction machine to do it — and then has to **prove it works** in a real physics simulation, or honestly admit it couldn't.

Tagline: *Claude overengineers your chores, then has to prove it works.*

Public copy says "chain-reaction machine", never the name of the cartoonist these machines are usually named after (that name is believed to be protected).

## 2. Why this exists

- **For visitors:** a funny toy you can try in 30 seconds and share.
- **For the portfolio:** the Ramen Protocol theme — *don't trust the model, check it* — made visible and fun. The physics engine is the judge, not the AI.
- **What it demonstrates:** an agent using tools in a loop on structured feedback, stopping honestly at a budget; deterministic, independently checkable verification; cost control for a public AI app; a published, honest eval.

## 3. The experience

1. **Landing:** one input — "What chore needs overkill?" — above a gallery of past machines.
2. **Wager:** before the run, "How many attempts will it take?" (one number). Makes the share line write itself: "I bet 3. It took 11."
3. **Build:** each attempt plays in the simulator with a counter ("Attempt 3 — ball stopped 2 cells short of the bucket") and a one-line engineer's note from Opus. Notes are dry, not wacky: *"Domino 7 was load-bearing. It was also facing the wrong way."* While Opus works on the next attempt, the previous one replays in slow motion so the screen is never idle.
4. **Honest ending:**
   - Success: "Worked on attempt N." Finale fires (switch flips, bowl fills). Overkill score shown.
   - Failure: "Gave up after N attempts. Closest: X cells." Never faked.
5. **Share link (`/m/:id`) is the failure reel:** attempts 1..N-1 at 4× speed, each captioned with its note, then the final attempt at 1× with the finale. The browser re-runs the physics itself and shows **"Replay verified ✓"** when its result matches the server's (§7).
6. **Sabotage:** after a replay, the viewer can drag one part and press Run — pure browser physics, no Opus call. "Break Claude's machine." Keeps the site alive when the budget is spent.
7. **Budget closed:** "The workshop is closed. Opus is out of budget until tomorrow." Gallery, replays and sabotage stay open.
8. **Leave and come back:** a run keeps going on the server; its link works mid-run and shows progress so far.

## 4. The overkill rule (enforced, not vibes)

A run only counts as a success if the finale is triggered at the end of a **chain of at least 5 distinct part-events** (a part hitting or moving another part). Dropping a ball straight onto the switch is a failure with the reason "not overkill enough". The trace analyzer checks this.

**Overkill score** = number of distinct parts in the successful chain (shown as "7 parts to flip one switch").

## 5. Scope

**In v1**
- 2D, hand-drawn blueprint look, rendered as SVG.
- **Grid world:** 16 × 10 cells. Parts snap to cells; angles in 15° steps; sizes from a small fixed set. This turns "place objects in continuous space" into "arrange parts on a board", which models handle far better.
- **Parts kit (5):** ball, plank/ramp, domino, seesaw, bucket — plus the finale target.
- **Finale targets (5):** switch, bowl, bell, door, plant. Opus picks one and labels it with the chore.
- **Attempt cap:** default 12, final number set from the spike's attempt distribution.
- Max 25 parts per machine.
- Wager, live attempt view, failure-reel replay with verification, sabotage, gallery, budget-closed state, link-preview image.
- Daily run cap, per-visitor rate limit, chore moderation.
- Published eval in the README.

**Not in v1 (YAGNI):** 3D, video/GIF export (launch clips are recorded locally), accounts, sound, custom parts, pendulum/spring parts (after the spike), multiplayer, likes/comments, a curation UI (hall of fame is a JSON file in the repo), WebSockets, SQL.

## 6. Architecture

```
Browser (React + TS + Vite, Cloudflare Pages)
  │  POST /api/runs {chore, wager}   ← only chore text + a number leave the browser
  │  GET  /api/runs/:id/events (SSE) ← attempts stream back
  │  GET  /api/runs/:id              ← finished or in-progress run
  ▼
Cloudflare Worker — validation, rate limit, budget check, moderation, OG image
  ▼
Run Durable Object (one per run) — owns the agent loop, one attempt per alarm step
  ├─ Opus 5.5 call with tools `preview(blueprint)` and `simulate(blueprint)`
  ├─ Physics (Rapier 2D, deterministic build, version-pinned)
  ├─ Trace analyzer → compact attempt report for the next turn
  └─ writes run record → KV
```

**Units (small, one job each, testable alone):**

| Unit | Job | Depends on |
|---|---|---|
| `blueprint` | Schema + validation: grid bounds, part limits, allowed sizes/angles, no starting overlaps. Pure. | zod |
| `sim` | Blueprint → deterministic physics run → event log + trace hash. Same package in Worker and browser. | Rapier 2D (pinned) |
| `trace` | Event log → attempt report: success, chain length, closest approach, first broken link, per-part touched/moved. Pure. | `sim` output |
| `preview` | Static checks without simulating: overlaps, unsupported parts, "nothing within reach of domino 4". Pure. | `blueprint` |
| `agent` | Opus tool-use loop: prompts, tools, attempt budget, stop rules, append-only history. | Anthropic API, `sim`, `trace`, `preview` |
| `budget` | Daily run cap + per-visitor limit. | Durable Object storage |
| `moderation` | Wordlist + one cheap classification call (Claude Haiku 4.5) before Opus sees the chore. | Anthropic API |
| `store` | Save/load run records and gallery. | KV |
| `web` | Input, wager, live view, reel replay + verification, sabotage, gallery. | `sim`, `blueprint`, API |

**Why a server-side loop:** visitors can't use the endpoint as a free Opus proxy, can't fake a trace, and every gallery entry is server-checked. The browser re-runs blueprints only to *show* them, and share-link viewers re-run them to *check* them.

**Why one attempt per alarm step:** a multi-minute loop held open as one request is fragile. Each attempt is its own short step; the Durable Object only persists state and fans events out to watchers. Exact Cloudflare CPU/duration limits must be checked against current docs during the spike, not assumed.

## 7. Data flow

1. Visitor submits chore + wager → Worker checks length, rate limit, daily budget, moderation → creates a Run Durable Object → returns run id → browser opens the SSE stream.
2. The Run object calls Opus with: system prompt (rules, grid, parts kit, overkill rule), tool definitions, the chore marked as untrusted data. System prompt and tools are prompt-cached. Effort is set explicitly (start at `high`; the spike measures `medium` too). Opus 5.5 can't be forced to call a tool, so the loop checks that a call was made and nudges once if not.
3. Opus may call `preview` (does not count as an attempt, max 3 per attempt so it can't stall the loop) and `simulate` (counts as an attempt).
4. Each `simulate`: validate (schema, then no starting overlaps — the same check `preview` runs) → run sim (fixed timestep, fixed step count, ~20 s simulated) → trace report + trace hash → if it succeeded, replay without the first push and downgrade it to "not overkill enough" when the finale gets hit anyway → stream attempt to watchers → return a ~300-token report to Opus.
5. History is append-only: Opus 5.5 rejects replayed reasoning when earlier turns change, so older attempts are never trimmed or rewritten. Attempt reports stay compact (~300 tokens) instead; 12 attempts fit comfortably in context.
6. Loop ends on: success, attempt cap, Opus gives up, a hard token/time ceiling, or a full context window (`context_full`: the run ends with no further call, since the next request would be rejected; it counts as a failure, not an API error).
7. Run record saved to KV: chore, wager, every attempt's blueprint + report + note + trace hash, outcome, engine version.

**Verification:** the browser replays each blueprint with the same pinned engine, hashes its event trace, and compares with the stored hash. Match → "Replay verified ✓". Mismatch → shows the server's stored report and says "couldn't verify on this device". (Stored keyframes as a fallback are deferred unless the spike shows mismatches.)

**Blueprint (sketch):**
```json
{
  "finale": {"kind": "switch", "label": "turn off the light", "cell": [15, 2]},
  "firstPush": {"part": "b1", "direction": "right", "strength": "medium"},
  "parts": [
    {"id": "b1", "kind": "ball", "cell": [0, 1], "size": "m"},
    {"id": "p1", "kind": "plank", "cell": [1, 2], "length": 3, "angle": -15, "fixed": true},
    {"id": "d1", "kind": "domino", "cell": [4, 3]}
  ],
  "note": "Domino 7 was load-bearing. It was also facing the wrong way."
}
```

**Attempt report (sketch):**
```json
{
  "attempt": 3, "success": false, "chainLength": 4, "overkillOk": false,
  "firstBrokenLink": {"from": "d3", "to": "d4", "reason": "d3 fell away from d4"},
  "closestToFinale": {"part": "b1", "cells": 2},
  "parts": {"d4": {"touched": false}, "b1": {"touched": true, "moved": true}}
}
```

## 8. Safety, cost and failure handling

- **Budget fences (outer to inner):** Anthropic workspace spend limit → daily run cap (config) → per-visitor rate limit → attempt cap → max tokens per call → run wall-clock ceiling.
- **Untrusted input:** chore text is data, never instructions; length-limited; wordlist + Haiku classification; refused chores get a dry refusal and don't count against the visitor.
- **Untrusted output:** only schema-valid blueprints are simulated; notes length-limited and filtered; all user/model text rendered as text, never HTML.
- **Gallery:** shows only runs that passed moderation; hall of fame is hand-picked in a repo JSON file.
- **API failure:** one retry with backoff, then the run ends honestly ("Opus is having a moment") and doesn't count against the visitor.
- **Invalid blueprint:** returned to Opus as a validation error; counts as an attempt. Parts that start overlapping make a blueprint invalid too, so it is never simulated (the engine would fling the parts apart).
- **Privacy:** no accounts, no personal data; only chore text, wager and machine data stored. No identifying analytics.

## 9. Testing

- **Unit:** `blueprint` validation; `preview` checks; `trace` on hand-built event logs (success, near miss, broken chain, not-overkill-enough).
- **Determinism:** same blueprint → identical trace hash across repeated runs and across the Worker and browser builds.
- **Golden machines:** hand-built blueprints that must succeed with a known overkill score (regression guard for sim/trace changes).
- **Agent:** loop logic against a mocked Opus — cap stop, give-up, invalid blueprint, API error, append-only history (no earlier message is ever modified).
- **Budget/moderation:** cap and rate-limit edges; refused chores don't consume budget.
- **Eval (published):** a fixed 20-chore set run against real Opus 5.5 → success rate, attempt histogram, overkill scores, cost per run, p50/p95 wall-clock, and a "what Opus 5.5 is bad at" section with the ugliest failures.

## 10. Spike — go/no-go (first thing built)

A CLI running the real Opus + `preview` + `simulate` loop on the 20-chore set. No UI, no Worker.

- **Go:** ≥ 60% succeed (overkill rule enforced) within 12 attempts, median attempts ≤ 6, p50 wall-clock per run < ~2 min.
- **40–60%:** ship, framed as "watch it struggle" — still honest, still shareable.
- **< 40%:** change the interface (templates, starter kits, finer feedback), not the concept; re-run.
- Also in the spike: one full loop on a deployed Worker (not only local), and a determinism check between the Worker build and a browser build.
- The spike's attempt distribution sets the final attempt cap.

## 11. Build order

1. Spike (§10).
2. `blueprint`, `preview`, `sim`, `trace` with tests; SVG renderer.
3. Run Durable Object loop, Worker API, budget, moderation, KV.
4. Web: wager, live view, reel replay + verification, sabotage, gallery, budget-closed, OG image.
5. Launch: Repo Audit Crew → public repo; README with eval, cost table, threat model, "decisions I rejected", public blueprint schema; launch clip recorded locally; `About overkill.md` in the vault; Proof Wall entry.

**Launch hook:** "I gave Claude Opus 5.5 a physics engine and 12 tries to turn off a light." + the failure reel.

**README stars:** the trace analyzer (turning physics into model-readable feedback is the real engineering); the verification hash; the honest eval. Any Opus 5.5 / API feature claims are checked against current docs and cited, not asserted from memory.

## 12. Open decisions and prerequisites

**Decisions (owner: Ramen Protocol)**
- **Final public name:** decide after the spike. If the cap stays at 12, "Twelve Attempts" puts the honesty mechanic in the name; otherwise OVERKILL or "Overengineered". Check for existing products with the name before launch.
- **Daily cap amount:** set from the spike's measured cost per run and the budget you're willing to spend.
- **URL:** a `pages.dev` subdomain on the Ramen Cloudflare account.

**Prerequisites (before the spike)**
- Fix `RAMEN_GITHUB_TOKEN` so `preflight.sh all` passes.
- An Anthropic API key on a Ramen Protocol account, with a workspace spend limit set.
- Ramen Cloudflare account token (`RAMEN_CF_*`) for the deployed-Worker part of the spike.

## 13. Known limitations (from spike-build reviews, 2026-09-25; attribution updated 2026-09-26)

- **Chain attribution is counterfactual (fixed 2026-09-26).** It used to rely on motion thresholds: a part riding another (for example a bucket on a seesaw that tips gradually) could cross the threshold a few steps before its carrier and go uncredited, a part already moving could never join, and a part jostled into motion near the chain was credited even if the chain didn't move it. Now every pushed run steps a push-free twin of the machine in lockstep (the engine is deterministic, so the two are bit-identical until the push). A part's *onset* is the first step at which some point of it is 0.1 mm from its twin's pose; it joins the chain from a chain part it was touching at that step (2 steps of slack for contact-event timing and for a load registering a step before its carrier), and only if the push eventually moves it at least 5 cm from its twin's pose. On 553 random machines the new rule changed no outcome; it dropped credit for dominoes that wobbled without moving 5 cm and added credit for already-moving parts whose paths the chain changed.
- **What the counterfactual rule still can't do.** A part that the push only *delays* (the twin would have been hit a few steps earlier by the same chain part) is not credited, because its path changed before the push-world touch. A part nudged below 0.1 mm by a non-chain part first, and hit properly by the chain later, is not credited either. Both errors are conservative: they can shorten a chain, never lengthen it.
- **The finale rule is unchanged.** The first moving touch of the finale counts only if the toucher is already in the chain, and a success is downgraded when a push-free run hits the finale anyway (that check replays the machine without the push, at any step, settling included).
- Preview's floating-part warning says a part "will fall as soon as the machine starts"; with the 1-second settle it actually falls while settling.
- `SimResult.events` / `finaleHit` count any first contact with the finale (including during settling); the trace uses its own moving-contact definition. Nothing reads the sim's version yet.
