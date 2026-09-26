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
npm run spike -- --limit 2 --max-cost 10   # smoke test
npm run spike                               # all 20 chores, cost cap $30
```

The spike stops making calls before the next call could take spending past the cap (`--max-cost`, default $30, minimum $2). Before each call it assumes the worst: at least $2, and more once a conversation gets long (the previous reply's tokens plus 20k, all priced as cache writes, plus a full 64k-token reply).

What counts toward the cap:

- A finished reply: the usage the API reports.
- A reply whose stream breaks or hits the 10-minute call timeout: the input and cache tokens reported when the stream started, plus a full 64k tokens of output. The real output count only arrives at the end of the stream, so the spike assumes the most it could have been.
- A call that fails before the API reports any usage: nothing.

A run cut off by the cap is reported separately. The verdict is marked provisional when the cost cap or an API rejection stops the spike, or when any run ends in an API error (including a timeout). With no completed runs there is no verdict.

Results are written to `results/<timestamp>/` (`runs.jsonl` and `summary.md`). `summary.md` is rewritten after every chore, so an interrupted spike keeps its report.

## Built with

Claude Opus 5.5 (`claude-opus-5-5`) and Rapier 2D (`@dimforge/rapier2d-deterministic-compat`). AI-assisted development is part of how this project is built and is visible in the commit history.

## License

MIT
