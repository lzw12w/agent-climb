#!/usr/bin/env node
// agent-climb run --benchmark mbppplus --seed-config configs/baseline --budget-usd 1 [--run-dir runs/x] [--iterations 5] ...
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { mbppPlusBenchmark } from "./benchmarks/mbppplus.js";
import { toyBenchmark } from "./examples/toy.js";
import { climb, piEvaluator } from "./climb/climb.js";
import { openAiCompatProposer } from "./climb/proposer.js";
import { writeReport } from "./climb/report.js";

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    benchmark: { type: "string", default: "mbppplus" }, "seed-config": { type: "string", default: "configs/baseline" },
    "budget-usd": { type: "string", default: "1" }, iterations: { type: "string", default: "5" }, patience: { type: "string", default: "3" },
    "run-dir": { type: "string" }, "screen-size": { type: "string", default: "5" }, "opt-size": { type: "string", default: "20" },
    "heldout-size": { type: "string", default: "15" }, concurrency: { type: "string", default: "4" }, seed: { type: "string", default: "agent-climb" },
    "proposer-model": { type: "string", default: "deepseek-v4-pro" }, "proposer-base-url": { type: "string", default: "https://api.deepseek.com" },
    "proposer-key-env": { type: "string", default: "DEEPSEEK_API_KEY" },
  },
});
if (positionals[0] !== "run") { console.error("usage: agent-climb run --benchmark mbppplus|toy --seed-config DIR --budget-usd X [--run-dir DIR] [--iterations N]"); process.exit(2); }
const bench: any = v.benchmark === "toy" ? toyBenchmark : mbppPlusBenchmark();
const runDir = v["run-dir"] ?? `runs/${v.benchmark}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const surfaceDoc = await readFile(new URL("../docs/pi-extension-surface.md", import.meta.url), "utf8");
const state = await climb(bench, openAiCompatProposer({ model: v["proposer-model"], baseUrl: v["proposer-base-url"], apiKeyEnv: v["proposer-key-env"] }),
  piEvaluator(bench, (t: any) => t.input.starterFiles, { concurrency: Number(v.concurrency) }), {
    runDir, seedConfigDir: v["seed-config"]!, budgetUsd: Number(v["budget-usd"]), maxIterations: Number(v.iterations), patience: Number(v.patience),
    screenSize: Number(v["screen-size"]), optSize: Number(v["opt-size"]), heldOutSize: Number(v["heldout-size"]), seed: v.seed, surfaceDoc,
    log: (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`),
  });
await writeReport(runDir, state);
console.log(`report: ${runDir}/report.md (best ${state.bestId}, spent $${(state.spent.proposer + state.spent.eval).toFixed(4)})`);
