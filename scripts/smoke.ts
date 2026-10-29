// Tiny real run: N MBPP+ tasks with a given AgentConfig. Usage: tsx scripts/smoke.ts configs/baseline 3
import { mbppPlusBenchmark, runBenchmark, sampleTasks } from "../src/index.js";

const [configDir = "configs/baseline", n = "3"] = process.argv.slice(2);
const bench = mbppPlusBenchmark();
const tasks = sampleTasks(await bench.loadTasks(), Number(n), { seed: "smoke" });
const rep = await runBenchmark({
  configDir, benchmark: bench, tasks, starterFiles: (t) => t.input.starterFiles,
  concurrency: 3, timeoutMsPerTask: 180_000, budget: { maxCostUsd: 0.2, maxTasks: Number(n) }, traceDir: `.cache/traces/${configDir.replace(/\W+/g, "_")}`,
});
for (const r of rep.runs) console.log(r.task.id, r.result.passed ? "PASS" : "FAIL", `exit=${r.exitCode}`, `tok=${r.usage.inputTokens}/${r.usage.outputTokens}`, `$${r.usage.costUsd.toFixed(5)}`, `tools=${r.usage.toolCalls}`, r.error ? r.error.slice(0, 300) : "");
console.log(JSON.stringify(rep.totals));
