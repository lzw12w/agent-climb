import { describe, expect, it } from "vitest";
import { scoreAll, splitTasks, toyBenchmark, toyReferenceSolutions } from "../src/index.js";
import type { Submission } from "../src/index.js";

describe("toy benchmark", () => {
  it("reference solutions pass all tasks", async () => {
    const tasks = await toyBenchmark.loadTasks();
    const subs = new Map<string, Submission>(tasks.map((t) => [t.id, { taskId: t.id, files: { "solution.mjs": toyReferenceSolutions[t.id]! } }]));
    const r = await scoreAll(toyBenchmark, tasks, subs);
    expect(r.passed).toBe(tasks.length);
    expect(r.mean).toBe(1);
  });
  it("starter stubs fail with feedback; missing submission scores 0", async () => {
    const tasks = await toyBenchmark.loadTasks();
    const subs = new Map<string, Submission>([[tasks[0]!.id, { taskId: tasks[0]!.id, files: {} }]]);
    const r = await scoreAll(toyBenchmark, tasks, subs);
    expect(r.passed).toBe(0);
    expect(r.results[0]!.feedback).toMatch(/Assertion|assert/i);
    expect(r.results[1]!.feedback).toBe("no submission");
  });
  it("submission cannot overwrite hidden tests or escape workdir", async () => {
    const [t] = await toyBenchmark.loadTasks();
    const cheat = await toyBenchmark.scorer.score(t!, { taskId: t!.id, files: { "test.mjs": "console.log('ok')" } });
    expect(cheat.passed).toBe(false);
    await expect(toyBenchmark.scorer.score(t!, { taskId: t!.id, files: { "../evil": "x" } })).rejects.toThrow(/escapes/);
  });
  it("splits the toy set", async () => {
    const s = splitTasks(await toyBenchmark.loadTasks(), { heldOutRatio: 0.4, seed: "toy" });
    expect(s.heldOut).toHaveLength(2);
  });
});
