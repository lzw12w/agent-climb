import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePiEvents, runBenchmark, toyBenchmark, toyReferenceSolutions, type PiInvoker } from "../src/index.js";

const cfgDir = join(__dirname, "..", "configs", "baseline");
const ev = (cost: number) => [
  { type: "session" }, { type: "agent_start" },
  { type: "tool_execution_start", toolName: "write" },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 100, output: 10, cacheRead: 5, cost: { total: cost } } } },
  { type: "agent_settled" },
].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n";

/** Fake pi: writes the reference solution (or garbage for tasks in `fail`) into cwd. */
const fakePi = (fail = new Set<string>(), cost = 0.01, seen: any[] = []): PiInvoker => async (req) => {
  seen.push(req);
  const prompt = req.args[req.args.length - 1]!;
  const id = Object.keys(toyReferenceSolutions).find((k) => prompt.includes(k.split("/")[1]!.replace("-", "")) || prompt.toLowerCase().includes(k.split("/")[1]!)) ;
  const entry = Object.entries(toyReferenceSolutions).find(([k]) => k === id);
  await writeFile(join(req.cwd, "solution.mjs"), entry && !fail.has(entry[0]) ? entry[1] : "export {}\n");
  return { code: 0, stdout: ev(cost), stderr: "" };
};

describe("parsePiEvents", () => {
  it("sums usage and ignores junk", () => {
    const { usage, finalText } = parsePiEvents(ev(0.5) + ev(0.25));
    expect(usage).toMatchObject({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 10, turns: 2, toolCalls: 2 });
    expect(usage.costUsd).toBeCloseTo(0.75);
    expect(finalText).toBe("done");
  });
});

describe("runBenchmark (mocked pi)", () => {
  const promptFor = (t: any) => `${t.id} ${t.prompt}`;
  it("runs, collects files, scores, aggregates", async () => {
    const tasks = await toyBenchmark.loadTasks();
    const seen: any[] = [];
    const rep = await runBenchmark({
      configDir: cfgDir, benchmark: toyBenchmark, tasks, starterFiles: (t) => t.input.starterFiles,
      invoker: fakePi(new Set(["toy/add"]), 0.01, seen), concurrency: 3, formatPrompt: promptFor,
    });
    expect(rep.totals.tasks).toBe(5);
    expect(rep.totals.passed).toBe(4);
    expect(rep.runs.find((r) => r.task.id === "toy/add")!.result.passed).toBe(false);
    expect(rep.totals.costUsd).toBeCloseTo(0.05);
    expect(rep.runs[0]!.submission.files["solution.mjs"]).toBeDefined();
    expect(rep.runs.map((r) => r.task.id)).toEqual(tasks.map((t) => t.id));
    expect(new Set(seen.map((s) => s.cwd)).size).toBe(5); // isolated workdirs
    expect(seen[0].env.PI_CODING_AGENT_DIR).toMatch(/agent$/);
  });
  it("stops at maxTasks", async () => {
    const tasks = await toyBenchmark.loadTasks();
    const rep = await runBenchmark({ configDir: cfgDir, benchmark: toyBenchmark, tasks, starterFiles: (t) => t.input.starterFiles, invoker: fakePi(), concurrency: 1, budget: { maxTasks: 2 }, formatPrompt: promptFor });
    expect(rep.totals.tasks).toBe(2);
    expect(rep.skipped).toHaveLength(3);
    expect(rep.stoppedReason).toBe("maxTasks");
  });
  it("stops at maxCostUsd", async () => {
    const tasks = await toyBenchmark.loadTasks();
    const rep = await runBenchmark({ configDir: cfgDir, benchmark: toyBenchmark, tasks, starterFiles: (t) => t.input.starterFiles, invoker: fakePi(new Set(), 0.4), concurrency: 1, budget: { maxCostUsd: 1 }, formatPrompt: promptFor });
    expect(rep.totals.tasks).toBe(3); // 0.4, 0.8 < 1 -> third starts; then 1.2 >= 1
    expect(rep.stoppedReason).toBe("maxCostUsd");
  });
  it("records invoker crashes as failures", async () => {
    const tasks = (await toyBenchmark.loadTasks()).slice(0, 1);
    const rep = await runBenchmark({ configDir: cfgDir, benchmark: toyBenchmark, tasks, starterFiles: (t) => t.input.starterFiles, invoker: async () => { throw new Error("boom"); } });
    expect(rep.runs[0]!.result.passed).toBe(false);
    expect(rep.runs[0]!.error).toMatch(/boom/);
  });
});
