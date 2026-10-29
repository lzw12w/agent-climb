import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { downloadMbppPlus, entryPoint, mbppPlusBenchmark, mbppRowToTask, LocalTestScorer } from "../src/index.js";

const row = {
  task_id: 2, prompt: "Write a function to find the shared elements from the given two lists.",
  code: "def helper(x):\n  return x\n\ndef similar_elements(a, b):\n  return tuple(set(a) & set(b))\n",
  test_list: ["assert set(similar_elements((3, 4, 5, 6),(5, 7, 4, 10))) == set((4, 5))"],
  test_imports: [],
  test: "inputs = [[(1,2),(2,3)]]\nresults = [(2,)]\nfor i, (inp, exp) in enumerate(zip(inputs, results)):\n    assert set(similar_elements(*inp)) == set(exp)\n",
};
const hasPy = (() => { try { execFileSync("python3", ["-c", "1"]); return true; } catch { return false; } })();

describe("MBPP+ adapter", () => {
  it("finds the entry point", () => expect(entryPoint(row)).toBe("similar_elements"));
  it("converts a row to a task", () => {
    const t = mbppRowToTask(row);
    expect(t.id).toBe("mbppplus/2");
    expect(t.prompt).toContain("similar_elements");
    expect(t.input.testFiles["test_solution.py"]).toContain("from solution import *");
  });
  it.runIf(hasPy)("scores reference vs stub with python", async () => {
    const t = mbppRowToTask(row);
    const s = new LocalTestScorer();
    expect((await s.score(t, { taskId: t.id, files: { "solution.py": row.code } })).passed).toBe(true);
    expect((await s.score(t, { taskId: t.id, files: {} })).passed).toBe(false);
  });
  it("downloads with pagination and caches (mocked fetch)", async () => {
    let calls = 0;
    const fake = (async (url: string) => {
      calls++;
      const off = Number(/offset=(\d+)/.exec(url)![1]);
      const n = Math.max(0, Math.min(100, 150 - off));
      return { ok: true, json: async () => ({ num_rows_total: 150, rows: Array.from({ length: n }, (_, i) => ({ row: { ...row, task_id: off + i } })) }) };
    }) as any;
    const dir = await mkdtemp(join(tmpdir(), "mbpp-"));
    expect(await downloadMbppPlus(dir, fake)).toHaveLength(150);
    expect(calls).toBe(2);
    const tasks = await mbppPlusBenchmark({ cacheDir: dir, fetchImpl: fake }).loadTasks();
    expect(tasks).toHaveLength(150);
    expect(calls).toBe(2);
  });
});
