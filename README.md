# OVERKILL

> Working name. Claude Opus 5.5 overengineers your chores as chain-reaction machines, then has to prove they work in a physics simulation.

**Status:** pre-release. This repository currently holds the physics core, the agent loop and a feasibility spike. There is no web app yet.

## How it works

1. A chore goes in ("turn off the light").
2. Claude Opus 5.5 designs a machine as a JSON blueprint on a 16 × 10 grid: balls, dominoes, planks, seesaws, buckets and a finale.
3. A deterministic 2D physics engine runs the machine. The model never judges its own work.
4. A trace analyzer turns the run into short feedback: which parts joined the chain, where it stopped, what came closest.
5. The model gets a fixed number of attempts. A success needs a chain of at least 5 parts, so dropping a ball on the switch doesn't count.

## Run the tests

```bash
npm install
npm test
```

## Run the feasibility spike

Uses real API calls and costs money. Needs an Anthropic API key in `RAMEN_ANTHROPIC_API_KEY`, ideally in a workspace with a spend limit.

```bash
npm run spike -- --limit 2 --max-cost 5   # smoke test
npm run spike                              # all 20 chores, stops at $30
```

Results are written to `results/<timestamp>/` (`runs.jsonl` and `summary.md`).

## Built with

Claude Opus 5.5 (`claude-opus-5-5`) and Rapier 2D (`@dimforge/rapier2d-deterministic-compat`). AI-assisted development is part of how this project is built and is visible in the commit history.

## License

MIT
