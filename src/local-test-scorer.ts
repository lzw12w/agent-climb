import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ScoreResult, Scorer, Submission, Task } from "./types.js";

/** Input for tasks scored by running a local test command in a scratch directory. */
export interface LocalTestInput {
  /** Starter files given to the agent. */
  starterFiles: Record<string, string>;
  /** Hidden test files, written after the submission (they override same-named submission files). */
  testFiles: Record<string, string>;
  /** Command + args to run, e.g. ["node", "test.mjs"]. Exit code 0 = pass. */
  command: string[];
  timeoutMs?: number;
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = resolve(root, rel);
    if (!p.startsWith(root + sep)) throw new Error(`path escapes workdir: ${rel}`);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
}

/** Runs tests locally (no sandbox!). Fine for toy/trusted tasks; use docker for untrusted code. */
export class LocalTestScorer implements Scorer<LocalTestInput> {
  constructor(private readonly opts: { defaultTimeoutMs?: number; maxFeedbackChars?: number } = {}) {}

  async score(task: Task<LocalTestInput>, sub: Submission, o: { signal?: AbortSignal } = {}): Promise<ScoreResult> {
    const start = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "agent-climb-"));
    try {
      await writeFiles(dir, task.input.starterFiles);
      await writeFiles(dir, sub.files);
      await writeFiles(dir, task.input.testFiles);
      const [cmd, ...args] = task.input.command;
      const timeout = task.input.timeoutMs ?? this.opts.defaultTimeoutMs ?? 10_000;
      const { code, output } = await new Promise<{ code: number | null; output: string }>((res) => {
        const child = spawn(cmd!, args, { cwd: dir, timeout, signal: o.signal, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("error", (e) => res({ code: null, output: out + String(e) }));
        child.on("close", (c, s) => res({ code: c, output: out + (s ? `\n[killed: ${s}]` : "") }));
      });
      const passed = code === 0;
      const max = this.opts.maxFeedbackChars ?? 4000;
      return { taskId: task.id, score: passed ? 1 : 0, passed, feedback: output.slice(-max), durationMs: Date.now() - start };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
