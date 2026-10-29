import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { materialize } from "./agent-config.js";
import type { Benchmark, ScoreResult, Submission, Task } from "./types.js";

export interface InvokeRequest { args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }
export interface InvokeResult { code: number | null; stdout: string; stderr: string }
/** Seam for tests: the real one spawns `pi`, tests inject a fake. */
export type PiInvoker = (req: InvokeRequest) => Promise<InvokeResult>;

export function spawnPiInvoker(piBin = "pi"): PiInvoker {
  return (req) => new Promise((res) => {
    const child = spawn(piBin, req.args, {
      cwd: req.cwd, env: { ...process.env, ...req.env }, timeout: req.timeoutMs, signal: req.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => res({ code: null, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; turns: number; toolCalls: number }

/** Parse pi `--mode json` JSONL. Usage is summed over assistant `message_end` records (docs/json.md). */
export function parsePiEvents(stdout: string): { events: any[]; usage: Usage; finalText: string } {
  const events: any[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* ignore non-JSON noise */ }
  }
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, turns: 0, toolCalls: 0 };
  let finalText = "";
  for (const e of events) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const u = e.message.usage ?? {};
      usage.inputTokens += u.input ?? 0;
      usage.outputTokens += u.output ?? 0;
      usage.cacheReadTokens += u.cacheRead ?? 0;
      usage.costUsd += u.cost?.total ?? 0;
      usage.turns++;
      const c = e.message.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") : "";
      if (text) finalText = text;
    }
    if (e.type === "tool_execution_start") usage.toolCalls++;
  }
  return { events, usage, finalText };
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, v] of Object.entries(files)) {
    const p = resolve(root, rel);
    if (!p.startsWith(root + sep)) throw new Error(`path escapes workdir: ${rel}`);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, v);
  }
}

async function snapshot(root: string, base = root, out: Record<string, string> = {}, maxBytes = 1_000_000) {
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "__pycache__" || e.name === ".pi") continue;
    const p = join(root, e.name);
    if (e.isDirectory()) await snapshot(p, base, out, maxBytes);
    else if (e.isFile()) {
      const buf = await readFile(p);
      if (buf.length <= maxBytes) out[p.slice(base.length + 1)] = buf.toString("utf8");
    }
  }
  return out;
}

export interface TaskRun { task: Task<any>; submission: Submission; result: ScoreResult; usage: Usage; exitCode: number | null; tracePath?: string; error?: string }

export interface RunOptions<T> {
  configDir: string;
  benchmark: Benchmark<T>;
  tasks: Task<T>[];
  /** Starter files placed in the workdir before pi runs. */
  starterFiles: (task: Task<T>) => Record<string, string>;
  invoker?: PiInvoker;
  concurrency?: number;
  timeoutMsPerTask?: number;
  budget?: { maxCostUsd?: number; maxTasks?: number };
  /** If set, per-task JSONL traces + stderr are written here. */
  traceDir?: string;
  /** Wrap task prompt (e.g. add "work in the current directory"). */
  formatPrompt?: (task: Task<T>) => string;
  onTaskDone?: (r: TaskRun) => void;
}

export interface RunReport {
  runs: TaskRun[];
  skipped: string[];
  stoppedReason?: "maxCostUsd" | "maxTasks";
  totals: Usage & { tasks: number; passed: number; meanScore: number };
}

const defaultPrompt = (t: Task<any>) =>
  `${t.prompt}\n\nWork in the current directory. Edit the files in place; do not ask questions.`;

/**
 * Baseline runner: for each task, fresh temp workdir + fresh agent dir materialized from the AgentConfig,
 * run pi, snapshot files as the Submission, score with the benchmark's scorer.
 * Budget: no new task starts once spent cost >= maxCostUsd or maxTasks have started (in-flight tasks may overshoot by
 * at most `concurrency` tasks' cost).
 */
export async function runBenchmark<T>(o: RunOptions<T>): Promise<RunReport> {
  const invoke = o.invoker ?? spawnPiInvoker();
  const conc = Math.max(1, o.concurrency ?? 2);
  const runs: TaskRun[] = [];
  const skipped: string[] = [];
  let spent = 0, started = 0, idx = 0;
  let stoppedReason: RunReport["stoppedReason"];
  if (o.traceDir) await mkdir(o.traceDir, { recursive: true });

  const runOne = async (task: Task<T>): Promise<TaskRun> => {
    const root = await mkdtemp(join(tmpdir(), "agent-climb-run-"));
    const work = join(root, "work"), agentDir = join(root, "agent");
    try {
      await mkdir(work);
      await writeFiles(work, o.starterFiles(task));
      const { args, env } = await materialize(o.configDir, agentDir);
      const res = await invoke({ args: [...args, "--", (o.formatPrompt ?? defaultPrompt)(task)], cwd: work, env, timeoutMs: o.timeoutMsPerTask ?? 600_000 });
      const { usage } = parsePiEvents(res.stdout);
      let tracePath: string | undefined;
      if (o.traceDir) {
        tracePath = join(o.traceDir, `${task.id.replace(/[^\w.-]+/g, "_")}.jsonl`);
        await writeFile(tracePath, res.stdout);
        if (res.stderr) await writeFile(tracePath.replace(/\.jsonl$/, ".stderr.txt"), res.stderr);
      }
      const submission: Submission = {
        taskId: task.id, files: await snapshot(work),
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd },
      };
      const result = await o.benchmark.scorer.score(task, submission);
      return { task, submission, result, usage, exitCode: res.code, tracePath, ...(res.code !== 0 ? { error: res.stderr.slice(-2000) } : {}) };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  const worker = async () => {
    while (idx < o.tasks.length) {
      const task = o.tasks[idx++]!;
      if (o.budget?.maxTasks !== undefined && started >= o.budget.maxTasks) { stoppedReason ??= "maxTasks"; skipped.push(task.id); continue; }
      if (o.budget?.maxCostUsd !== undefined && spent >= o.budget.maxCostUsd) { stoppedReason ??= "maxCostUsd"; skipped.push(task.id); continue; }
      started++;
      let r: TaskRun;
      try { r = await runOne(task); } catch (e) {
        const z: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, turns: 0, toolCalls: 0 };
        r = { task, submission: { taskId: task.id, files: {} }, result: { taskId: task.id, score: 0, passed: false, feedback: String(e) }, usage: z, exitCode: null, error: String(e) };
      }
      spent += r.usage.costUsd;
      runs.push(r);
      o.onTaskDone?.(r);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));

  const order = new Map(o.tasks.map((t, i) => [t.id, i]));
  runs.sort((a, b) => order.get(a.task.id)! - order.get(b.task.id)!);
  const sum = (f: (u: Usage) => number) => runs.reduce((a, r) => a + f(r.usage), 0);
  return {
    runs, skipped, stoppedReason,
    totals: {
      inputTokens: sum((u) => u.inputTokens), outputTokens: sum((u) => u.outputTokens), cacheReadTokens: sum((u) => u.cacheReadTokens),
      costUsd: sum((u) => u.costUsd), turns: sum((u) => u.turns), toolCalls: sum((u) => u.toolCalls),
      tasks: runs.length, passed: runs.filter((r) => r.result.passed).length,
      meanScore: runs.length ? runs.reduce((a, r) => a + r.result.score, 0) / runs.length : 0,
    },
  };
}
