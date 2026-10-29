import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadAgentConfig } from "../agent-config.js";
import { runBenchmark, type PiInvoker } from "../pi-runner.js";
import { sampleTasks, splitTasks } from "../split.js";
import type { Benchmark, Task } from "../types.js";
import { condenseTrace, type HistoryItem, type Proposer, type ProposerInput } from "./proposer.js";
import { validateCandidate } from "./validate.js";

export interface TaskEval { taskId: string; passed: boolean; score: number; costUsd: number; turns: number; toolCalls: number; feedback: string; tracePath?: string; error?: string }
export type Evaluator = (o: { configDir: string; tasks: Task<any>[]; maxCostUsd: number; traceDir: string }) => Promise<TaskEval[]>;

export interface ClimbOptions {
  runDir: string;
  seedConfigDir: string;
  budgetUsd: number;
  maxIterations: number;
  /** Stop after this many consecutive iterations without a held-out improvement (accepted candidate). */
  patience?: number;
  screenSize?: number;
  /** Size of the optimization subset used for "full" opt eval (capped by the opt split). */
  optSize?: number;
  /** Held-out subset size. */
  heldOutSize?: number;
  heldOutRatio?: number;
  seed?: string;
  /** Relative cost reduction that counts as an improvement at equal score. */
  minCostGain?: number;
  /** opt - heldOut score gap that is flagged as overfitting. */
  overfitGap?: number;
  /** Do not start a step if remaining budget is below this (USD). */
  reserveUsd?: number;
  surfaceDoc?: string;
  log?: (m: string) => void;
}

export type CandStatus = "pending" | "seed" | "invalid" | "proposer_error" | "screen_reject" | "opt_reject" | "heldout_reject" | "accepted" | "incomplete";
export interface Candidate {
  id: string; parent?: string; iteration: number; mutationType: string; rationale: string; status: CandStatus;
  errors?: string[]; proposerCostUsd: number;
  evals: Record<string, TaskEval>;
  screen?: Stat & { parent: Stat }; opt?: Stat; heldOut?: Stat; overfit?: string;
}
export interface Stat { score: number; costPerTask: number; n: number }
export interface ClimbState {
  version: 1; benchmark: string; split: { opt: string[]; heldOut: string[]; screen: string[]; optSubset: string[]; heldOutSubset: string[] };
  spent: { proposer: number; eval: number }; iteration: number; bestId: string; sinceImprove: number;
  candidates: Record<string, Candidate>; curve: { iteration: number; bestId: string; opt: number; heldOut: number; spentUsd: number }[];
  done?: string;
}

const spentTotal = (s: ClimbState) => s.spent.proposer + s.spent.eval;
const cid = (n: number) => `c${String(n).padStart(3, "0")}`;

export async function climb<T>(benchmark: Benchmark<T>, proposer: Proposer, evaluate: Evaluator, o: ClimbOptions): Promise<ClimbState> {
  const log = o.log ?? (() => {});
  const statePath = join(o.runDir, "state.json");
  await mkdir(o.runDir, { recursive: true });
  const all = await benchmark.loadTasks();
  const byId = new Map(all.map((t) => [t.id, t]));
  let s: ClimbState;
  if (existsSync(statePath)) {
    s = JSON.parse(await readFile(statePath, "utf8"));
    log(`resuming ${o.runDir} at iteration ${s.iteration}, spent $${spentTotal(s).toFixed(4)}`);
  } else {
    const sp = splitTasks(all, { seed: o.seed, heldOutRatio: o.heldOutRatio });
    const optSubset = sampleTasks(sp.optimization, o.optSize ?? sp.optimization.length, { seed: o.seed });
    s = {
      version: 1, benchmark: benchmark.name,
      split: {
        opt: sp.optimization.map((t) => t.id), heldOut: sp.heldOut.map((t) => t.id),
        optSubset: optSubset.map((t) => t.id),
        // nested: screen ⊂ optSubset because both are prefixes of the same hash order
        screen: sampleTasks(sp.optimization, Math.min(o.screenSize ?? 5, optSubset.length), { seed: o.seed }).map((t) => t.id),
        heldOutSubset: sampleTasks(sp.heldOut, o.heldOutSize ?? sp.heldOut.length, { seed: o.seed }).map((t) => t.id),
      },
      spent: { proposer: 0, eval: 0 }, iteration: 0, bestId: cid(0), sinceImprove: 0, candidates: {}, curve: [],
    };
    await cp(o.seedConfigDir, join(o.runDir, "candidates", cid(0), "config"), { recursive: true });
    s.candidates[cid(0)] = { id: cid(0), iteration: 0, mutationType: "seed", rationale: `seed from ${o.seedConfigDir}`, status: "pending", proposerCostUsd: 0, evals: {} };
  }
  const save = async () => { await writeFile(statePath + ".tmp", JSON.stringify(s, null, 2)); await rename(statePath + ".tmp", statePath); };
  await save();
  const heldOutSet = new Set(s.split.heldOut);
  const tasks = (ids: string[]) => ids.map((i) => byId.get(i)!).filter(Boolean);
  const cdir = (id: string) => join(o.runDir, "candidates", id, "config");
  const remaining = () => o.budgetUsd - spentTotal(s);
  const reserve = o.reserveUsd ?? 0.01;

  /** Evaluate missing tasks for a candidate (cached per task => resumable). Returns false if budget ran out. */
  const evalOn = async (c: Candidate, ids: string[]): Promise<boolean> => {
    const missing = ids.filter((i) => !c.evals[i]);
    if (!missing.length) return true;
    if (remaining() < reserve) return false;
    const res = await evaluate({ configDir: cdir(c.id), tasks: tasks(missing), maxCostUsd: remaining(), traceDir: join(o.runDir, "candidates", c.id, "traces") });
    for (const r of res) { c.evals[r.taskId] = r; s.spent.eval += r.costUsd; }
    await save();
    return ids.every((i) => c.evals[i]);
  };
  const stat = (c: Candidate, ids: string[]): Stat => {
    const ev = ids.map((i) => c.evals[i]!).filter(Boolean);
    return { n: ev.length, score: ev.length ? ev.reduce((a, e) => a + e.score, 0) / ev.length : 0, costPerTask: ev.length ? ev.reduce((a, e) => a + e.costUsd, 0) / ev.length : 0 };
  };
  const better = (a: Stat, b: Stat, gain: number) => a.score > b.score + 1e-9 || (Math.abs(a.score - b.score) < 1e-9 && a.costPerTask < b.costPerTask * (1 - gain));
  const finish = async (why: string) => { s.done = why; await save(); log(`stop: ${why}`); return s; };
  const pushCurve = () => {
    const b = s.candidates[s.bestId]!;
    s.curve.push({ iteration: s.iteration, bestId: s.bestId, opt: b.opt?.score ?? 0, heldOut: b.heldOut?.score ?? 0, spentUsd: spentTotal(s) });
  };

  // Seed: full opt subset + held-out subset.
  const seed = s.candidates[cid(0)]!;
  if (seed.status === "pending" || seed.status === "incomplete") {
    if (!(await evalOn(seed, s.split.optSubset)) || !(await evalOn(seed, s.split.heldOutSubset))) { seed.status = "incomplete"; return finish("budget exhausted during seed eval"); }
    seed.opt = stat(seed, s.split.optSubset); seed.heldOut = stat(seed, s.split.heldOutSubset); seed.status = "seed";
    pushCurve(); await save();
    log(`seed opt=${seed.opt.score.toFixed(3)} heldOut=${seed.heldOut.score.toFixed(3)} spent=$${spentTotal(s).toFixed(4)}`);
  }

  while (!s.done) {
    if (s.iteration >= o.maxIterations) return finish("max iterations");
    if (s.sinceImprove >= (o.patience ?? 5)) return finish(`held-out plateau (${s.sinceImprove} iterations without improvement)`);
    if (remaining() < reserve) return finish("budget exhausted");
    const best = s.candidates[s.bestId]!;

    // Resume an in-flight candidate, or propose a new one.
    let c = Object.values(s.candidates).find((x) => x.status === "pending" || (x.status === "incomplete" && x.id !== cid(0)));
    if (!c) {
      s.iteration++;
      const id = cid(Object.keys(s.candidates).length);
      c = { id, parent: best.id, iteration: s.iteration, mutationType: "?", rationale: "", status: "pending", proposerCostUsd: 0, evals: {} };
      s.candidates[id] = c;
      const input = buildInput(s, best, byId, o.surfaceDoc ?? "");
      input.parent = await loadAgentConfig(cdir(best.id));
      assertNoHeldOutLeak(input, heldOutSet, byId);
      try {
        const p = await proposer(input);
        c.proposerCostUsd = p.costUsd; s.spent.proposer += p.costUsd;
        c.mutationType = p.mutationType; c.rationale = p.rationale;
        await applyProposal(cdir(best.id), cdir(id), p.files, { parent: best.id, mutation: `${p.mutationType}: ${p.rationale}`.slice(0, 2000), name: id });
        const v = await validateCandidate(await loadAgentConfig(cdir(id)));
        if (!v.ok) { c.status = "invalid"; c.errors = v.errors; }
      } catch (e) { c.status = "proposer_error"; c.errors = [String(e).slice(0, 1000)]; }
      if (c.status !== "pending") { s.sinceImprove++; pushCurve(); await save(); log(`${id} [${c.mutationType}] ${c.status}: ${c.errors?.[0] ?? ""}`); continue; }
      await save();
      log(`${id} [${c.mutationType}] proposed: ${c.rationale.slice(0, 160)}`);
    }
    const parent = s.candidates[c.parent!]!;

    // 1) screening on a small nested sample, compared on the same tasks with the parent (cached).
    if (!(await evalOn(c, s.split.screen))) { c.status = "incomplete"; return finish("budget exhausted during screening"); }
    c.screen = { ...stat(c, s.split.screen), parent: stat(parent, s.split.screen) };
    const promising = c.screen.score > c.screen.parent.score + 1e-9 || (Math.abs(c.screen.score - c.screen.parent.score) < 1e-9 && c.screen.costPerTask <= c.screen.parent.costPerTask * 1.1);
    if (!promising) { c.status = "screen_reject"; s.sinceImprove++; pushCurve(); await save(); log(`${c.id} screen_reject ${fmt(c.screen)} vs ${fmt(c.screen.parent)}`); continue; }

    // 2) full optimization subset.
    if (!(await evalOn(c, s.split.optSubset))) { c.status = "incomplete"; return finish("budget exhausted during opt eval"); }
    c.opt = stat(c, s.split.optSubset);
    if (!better(c.opt, parent.opt!, o.minCostGain ?? 0.1)) { c.status = "opt_reject"; s.sinceImprove++; pushCurve(); await save(); log(`${c.id} opt_reject ${fmt(c.opt)} vs ${fmt(parent.opt!)}`); continue; }

    // 3) held-out, only for candidates that improved on opt. Acceptance is decided by held-out vs current best.
    if (!(await evalOn(c, s.split.heldOutSubset))) { c.status = "incomplete"; return finish("budget exhausted during held-out eval"); }
    c.heldOut = stat(c, s.split.heldOutSubset);
    const bh = s.candidates[s.bestId]!.heldOut!;
    const optGain = c.opt.score - parent.opt!.score, hoGain = c.heldOut.score - bh.score;
    if (c.opt.score - c.heldOut.score > (o.overfitGap ?? 0.1)) c.overfit = `opt-heldOut gap ${(c.opt.score - c.heldOut.score).toFixed(3)}`;
    if (optGain > 0 && hoGain < 0) c.overfit = `opt +${optGain.toFixed(3)} but held-out ${hoGain.toFixed(3)}`;
    // Accept if held-out is no worse and it is better on held-out by score or cost (opt improvement already required).
    if (c.heldOut.score >= bh.score - 1e-9 && better(c.heldOut, bh, (o.minCostGain ?? 0.1) / 2)) {
      c.status = "accepted"; s.bestId = c.id; s.sinceImprove = 0;
    } else { c.status = "heldout_reject"; s.sinceImprove++; }
    pushCurve(); await save();
    log(`${c.id} ${c.status} opt ${fmt(c.opt)} heldOut ${fmt(c.heldOut)}${c.overfit ? " OVERFIT? " + c.overfit : ""}`);
  }
  return s;
}

const fmt = (x: Stat) => `${x.score.toFixed(3)}@$${x.costPerTask.toFixed(5)}/task(n=${x.n})`;

function buildInput(s: ClimbState, best: Candidate, byId: Map<string, Task<any>>, surfaceDoc: string): ProposerInput {
  const optEvals = s.split.optSubset.map((i) => best.evals[i]).filter((e): e is TaskEval => !!e);
  const failing = optEvals.filter((e) => !e.passed).slice(0, 4);
  const traces = failing.map((e) => {
    let tr = ""; try { tr = e.tracePath ? condenseTrace(readFileSync(e.tracePath, "utf8")) : ""; } catch { /* trace missing */ }
    return { taskId: e.taskId, prompt: byId.get(e.taskId)?.prompt ?? "", feedback: e.feedback + (e.error ? `\nrunner error: ${e.error}` : ""), trace: tr };
  });
  const pass = optEvals.filter((e) => e.passed);
  const avg = (f: (e: TaskEval) => number) => (pass.length ? pass.reduce((a, e) => a + f(e), 0) / pass.length : 0);
  const history: HistoryItem[] = Object.values(s.candidates).filter((c) => c.parent).map((c) => ({
    id: c.id, mutationType: c.mutationType, rationale: c.rationale,
    outcome: c.status + (c.screen ? ` screen ${c.screen.score.toFixed(2)} vs parent ${c.screen.parent.score.toFixed(2)}, $/task ${c.screen.costPerTask.toFixed(5)} vs ${c.screen.parent.costPerTask.toFixed(5)}` : "") + (c.opt ? ` opt ${c.opt.score.toFixed(3)}` : "") + (c.errors ? ` errors: ${c.errors.join("; ").slice(0, 300)}` : ""),
  }));
  return {
    parentId: best.id, parent: undefined as any, // loaded by the caller
    scores: { optScore: best.opt?.score ?? 0, optCostPerTask: best.opt?.costPerTask ?? 0 },
    failures: traces,
    passingStats: `${pass.length} passing; mean $/task ${avg((e) => e.costUsd).toFixed(5)}, turns ${avg((e) => e.turns).toFixed(1)}, tool calls ${avg((e) => e.toolCalls).toFixed(1)}`,
    history, surfaceDoc,
  };
}


/** Guard: the proposer must never see held-out task ids or prompts. */
export function assertNoHeldOutLeak(input: ProposerInput, heldOut: Set<string>, byId: Map<string, Task<any>>) {
  const blob = JSON.stringify({ ...input, parent: undefined, surfaceDoc: undefined });
  for (const id of heldOut) {
    const t = byId.get(id);
    if (input.failures.some((f) => f.taskId === id) || (t && t.prompt.length > 40 && blob.includes(t.prompt.slice(0, 80)))) throw new Error(`held-out leak: ${id}`);
  }
}

async function applyProposal(parentDir: string, dir: string, files: Record<string, string | null>, meta: { parent: string; mutation: string; name: string }) {
  await rm(dir, { recursive: true, force: true });
  await cp(parentDir, dir, { recursive: true });
  const root = resolve(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = resolve(dir, rel);
    if (!p.startsWith(root + sep)) throw new Error(`path escapes config dir: ${rel}`);
    if (content === null) { await rm(p, { recursive: true, force: true }); continue; }
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  const mp = join(dir, "agent.json");
  const m = JSON.parse(await readFile(mp, "utf8"));
  await writeFile(mp, JSON.stringify({ ...m, ...meta }, null, 2) + "\n");
}

/** Default evaluator backed by the real pi runner. */
export function piEvaluator<T>(benchmark: Benchmark<T>, starterFiles: (t: Task<T>) => Record<string, string>, opts: { invoker?: PiInvoker; concurrency?: number; timeoutMsPerTask?: number } = {}): Evaluator {
  return async ({ configDir, tasks, maxCostUsd, traceDir }) => {
    const rep = await runBenchmark({ configDir, benchmark, tasks: tasks as Task<T>[], starterFiles, invoker: opts.invoker, concurrency: opts.concurrency ?? 3, timeoutMsPerTask: opts.timeoutMsPerTask ?? 240_000, budget: { maxCostUsd }, traceDir });
    return rep.runs.map((r) => ({ taskId: r.task.id, passed: r.result.passed, score: r.result.score, costUsd: r.usage.costUsd, turns: r.usage.turns, toolCalls: r.usage.toolCalls, feedback: (r.result.feedback ?? "").slice(-3000), tracePath: r.tracePath, ...(r.error ? { error: r.error.slice(-1000) } : {}) }));
  };
}
