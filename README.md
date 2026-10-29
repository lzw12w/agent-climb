# Agent Climb

**Bring your benchmarks. Get back the strongest [pi](https://github.com/earendil-works/pi) agent we can climb to.**

agent-climb takes one or more benchmarks you provide and uses frontier models to iteratively improve an agent built on the pi coding-agent framework, through a loop of run, score, analyze and revise. The output is an agent configuration tuned to get as close as possible to the ceiling of your benchmarks, ready for you to use.

> Status: early prototype. The full loop runs end to end on MBPP+ (see [first run report](docs/runs/mbppplus-real1.md)). APIs and formats may still change.

## How it works

1. **You provide benchmarks.** Each benchmark is a set of tasks plus a scorer.
2. **Baseline.** agent-climb runs a starting pi agent and records scores and traces.
3. **Climb.** A frontier model reads the failures and proposes changes to the agent: system prompt, skills, tools and pi extension code.
4. **Evaluate and keep the best.** Each candidate is scored; improvements are kept, regressions are dropped.
5. **Deliver.** When the budget runs out or progress stalls, you get the best agent plus a report of what changed and why.

## Design principles

### 1. Guard against overfitting

Optimizing for a score invites the agent to exploit quirks of the benchmark instead of getting better at the task.

- Every benchmark is split into an **optimization set** and a **held-out set**. The climbing loop only sees the optimization set.
- Reported results always use the **held-out score**. The optimization score is shown only as a diagnostic.
- Large gaps between the two scores are flagged as likely overfitting.

### 2. Control cost

Each iteration runs a benchmark with frontier models, which gets expensive fast.

- A hard **budget cap** (money and/or iterations) is required.
- **Early stopping** when the held-out score stops improving.
- **Screen cheaply first**: candidates are tested on a small sample, and only promising ones get a full run.

### 3. Only change the extension layer

The climber edits what pi is designed to be extended with: system prompts, skills, tools and extension code. It does **not** modify pi's core. That keeps the delivered agent a normal pi setup you can run, read and maintain.

## Quick start

Requires Node 20+, Python 3 (for MBPP+), pi (`@earendil-works/pi-coding-agent`) on your PATH, and a model API key (the current proposer uses `DEEPSEEK_API_KEY`).

```bash
npm install
npm test
npx tsx src/cli.ts run --benchmark mbppplus --seed-config configs/baseline --budget-usd 1 --iterations 5 --run-dir runs/my-run
```

The run directory holds resumable state; rerun the same command to continue. A `report.md` with the score curve, lineage, diffs and costs is written there.

## Project layout

- `src/types.ts`, `src/split.ts`: benchmark interface, seeded optimization / held-out split, nested screening samples
- `src/benchmarks/`: benchmark adapters (MBPP+); `src/examples/toy.ts`: a tiny JS benchmark
- `src/local-test-scorer.ts`: scores a submission by running hidden tests in a temp dir (not sandboxed)
- `src/agent-config.ts`: a candidate agent is a directory (`agent.json`, `SYSTEM.md`, `AGENTS.md`, `skills/`, `extensions/*.ts`) loaded by pi in isolation
- `src/pi-runner.ts`: runs pi headless per task with budget caps, concurrency and traces
- `src/climb/`: proposer, cheap candidate validation, screened evaluation, held-out acceptance, report
- `docs/pi-extension-surface.md`: every pi extension point and whether it is a useful knob to climb

The climber can change system prompts, AGENTS.md, skills, tool selection, new or merged tools, tool call / result interception, context and compaction handling, settle-time self-checks, and model / thinking settings.

## Roadmap

- [x] Benchmark interface (tasks + scorer) and optimization / held-out split
- [x] Baseline runner on pi
- [x] Climbing loop with budget cap and early stopping
- [x] Candidate screening on small samples
- [x] Final report: held-out scores, diffs and cost
- [ ] Aider Polyglot adapter (benchmark with more headroom)
- [ ] Larger held-out sets and repeated runs to reduce noise
- [ ] Sandboxed scoring (docker) for untrusted code
- [ ] Pluggable proposer models

## Related work

- [Gen-Verse/RSI-Anything](https://github.com/Gen-Verse/RSI-Anything): recursive self-improvement with world models (research)
- [browser-use/browser-use-pi](https://github.com/browser-use/browser-use-pi): a TypeScript web agent hill-climbed on browser evals
- [scaleapi/vero](https://github.com/scaleapi/vero): an evaluation harness for using coding agents to optimize LLM-based agents
- [lobehub/awesome-rsi](https://github.com/lobehub/awesome-rsi): a research map of recursive self-improvement

## License

MIT
