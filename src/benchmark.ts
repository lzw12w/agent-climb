import type { Benchmark, ScoreResult, Submission, Task } from "./types.js";

export interface AggregateScore { mean: number; passed: number; total: number; results: ScoreResult[] }

/** Score a batch of submissions with bounded concurrency. Missing submissions score 0. */
export async function scoreAll<T>(
  bench: Benchmark<T>, tasks: Task<T>[], subs: Map<string, Submission>, concurrency = 4,
): Promise<AggregateScore> {
  const results: ScoreResult[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      const t = tasks[i]!;
      const s = subs.get(t.id);
      results[i] = s ? await bench.scorer.score(t, s) : { taskId: t.id, score: 0, passed: false, feedback: "no submission" };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  const passed = results.filter((r) => r.passed).length;
  const mean = tasks.length ? results.reduce((a, r) => a + r.score, 0) / tasks.length : 0;
  return { mean, passed, total: tasks.length, results };
}
