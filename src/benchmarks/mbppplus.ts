import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Benchmark, Task } from "../types.js";
import { LocalTestScorer, type LocalTestInput } from "../local-test-scorer.js";

/**
 * MBPP+ (EvalPlus) adapter. Dataset: https://huggingface.co/datasets/evalplus/mbppplus (378 tasks, v0.2.x),
 * license apache-2.0 per the HF dataset card (checked 2026-10-29). Original MBPP is CC-BY-4.0 (Google) — unverified here.
 * Hidden tests are EvalPlus' augmented `test` field (needs python3 + numpy).
 */
export interface MbppPlusRow { task_id: number; prompt: string; code: string; test: string; test_list: string[]; test_imports: string[] }

const ROWS_URL = "https://datasets-server.huggingface.co/rows?dataset=evalplus/mbppplus&config=default&split=test";

export async function downloadMbppPlus(cacheDir = ".cache", fetchImpl: typeof fetch = fetch): Promise<MbppPlusRow[]> {
  const file = join(cacheDir, "mbppplus.json");
  try { return JSON.parse(await readFile(file, "utf8")); } catch { /* not cached */ }
  const rows: MbppPlusRow[] = [];
  for (let offset = 0; ; offset += 100) {
    const r = await fetchImpl(`${ROWS_URL}&offset=${offset}&length=100`);
    if (!r.ok) throw new Error(`MBPP+ download failed: HTTP ${r.status}`);
    const j = (await r.json()) as { rows: { row: MbppPlusRow }[]; num_rows_total: number };
    rows.push(...j.rows.map((x) => x.row));
    if (rows.length >= j.num_rows_total || j.rows.length === 0) break;
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(rows));
  return rows;
}

/** Name of the function under test: a `def` in the reference code that the first public assert calls. */
export function entryPoint(row: Pick<MbppPlusRow, "code" | "test_list">): string {
  const defs = [...row.code.matchAll(/^def\s+(\w+)\s*\(/gm)].map((m) => m[1]!);
  const probe = row.test_list.join("\n");
  return defs.find((d) => new RegExp(`\\b${d}\\s*\\(`).test(probe)) ?? defs[defs.length - 1] ?? "solution";
}

export function mbppRowToTask(row: MbppPlusRow, python = "python3"): Task<LocalTestInput> {
  const fn = entryPoint(row);
  const imports = (row.test_imports ?? []).join("\n");
  return {
    id: `mbppplus/${row.task_id}`,
    prompt: `${row.prompt.trim()}\n\nImplement \`${fn}\` in solution.py. Your code should pass, e.g.:\n${row.test_list[0] ?? ""}`,
    input: {
      starterFiles: { "solution.py": `# Implement ${fn} here.\n` },
      testFiles: { "test_solution.py": `${imports}\nfrom solution import *\n\n${row.test}\n` },
      command: [python, "test_solution.py"],
      timeoutMs: 60_000,
    },
    tags: ["python", "mbppplus"],
  };
}

export function mbppPlusBenchmark(opts: { cacheDir?: string; python?: string; fetchImpl?: typeof fetch } = {}): Benchmark<LocalTestInput> {
  return {
    name: "mbppplus",
    version: "0.2",
    description: "EvalPlus MBPP+ (378 Python tasks, augmented hidden tests)",
    loadTasks: async () => (await downloadMbppPlus(opts.cacheDir, opts.fetchImpl)).map((r) => mbppRowToTask(r, opts.python)),
    scorer: new LocalTestScorer({ defaultTimeoutMs: 60_000 }),
  };
}
