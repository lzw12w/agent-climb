/** A single benchmark task. `id` must be unique and stable: splits are derived from it. */
export interface Task<TInput = unknown> {
  id: string;
  /** Natural-language instructions shown to the agent. */
  prompt: string;
  /** Benchmark-specific payload (starter files, tests, metadata...). Never shown verbatim unless the benchmark chooses to. */
  input: TInput;
  tags?: string[];
}

/** What an agent produced for a task (e.g. final file contents or a patch). */
export interface Submission {
  taskId: string;
  /** Files written by the agent, path -> contents. */
  files: Record<string, string>;
  /** Optional cost accounting from the run. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface ScoreResult {
  taskId: string;
  /** Normalized score in [0, 1]. */
  score: number;
  passed: boolean;
  /** Human/LLM-readable feedback for the climber (test output, errors). */
  feedback?: string;
  durationMs?: number;
}

export interface Scorer<TInput = unknown> {
  score(task: Task<TInput>, submission: Submission, opts?: { signal?: AbortSignal }): Promise<ScoreResult>;
}

export interface Benchmark<TInput = unknown> {
  name: string;
  version: string;
  description?: string;
  loadTasks(): Promise<Task<TInput>[]>;
  scorer: Scorer<TInput>;
}
