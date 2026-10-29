import { createHash } from "node:crypto";
import type { Task } from "./types.js";

export interface SplitOptions {
  /** Fraction of tasks that go to the held-out set, in (0, 1). Default 0.3. */
  heldOutRatio?: number;
  /** Seed string; same seed + same ids => same split. Default "agent-climb". */
  seed?: string;
}

export interface Split<T> {
  optimization: T[];
  heldOut: T[];
  seed: string;
  heldOutRatio: number;
}

/** Stable 64-bit-ish hash of (seed, id) as a hex string, used for ordering. */
export function taskHash(seed: string, id: string): string {
  return createHash("sha256").update(seed).update("\0").update(id).digest("hex");
}

/**
 * Deterministic split. Tasks are ordered by hash(seed, id) so the result depends only on
 * the seed and the set of task ids — not on input order or the runtime.
 * held-out size = round(n * ratio), clamped so both sides are non-empty when n >= 2.
 */
export function splitTasks<T extends Pick<Task, "id">>(tasks: readonly T[], opts: SplitOptions = {}): Split<T> {
  const seed = opts.seed ?? "agent-climb";
  const ratio = opts.heldOutRatio ?? 0.3;
  if (!(ratio > 0 && ratio < 1)) throw new RangeError(`heldOutRatio must be in (0,1), got ${ratio}`);
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    ids.add(t.id);
  }
  const ordered = [...tasks].sort((a, b) => {
    const ha = taskHash(seed, a.id), hb = taskHash(seed, b.id);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  const n = ordered.length;
  let k = Math.round(n * ratio);
  if (n >= 2) k = Math.min(Math.max(k, 1), n - 1);
  const heldOutIds = new Set(ordered.slice(0, k).map((t) => t.id));
  // Preserve original input order within each side for readability.
  return {
    optimization: tasks.filter((t) => !heldOutIds.has(t.id)),
    heldOut: tasks.filter((t) => heldOutIds.has(t.id)),
    seed,
    heldOutRatio: ratio,
  };
}

export interface SampleOptions {
  seed?: string;
  /** Optional stratification key (e.g. language or difficulty tag); samples proportionally per stratum. */
  stratify?: (task: any) => string;
}

/**
 * Deterministic small-sample selection for cheap candidate screening.
 * Same (seed, ids, size) => same sample. Growing `size` yields a superset (nested samples),
 * so a screening sample is always contained in a larger confirmation sample.
 */
export function sampleTasks<T extends Pick<Task, "id">>(tasks: readonly T[], size: number, opts: SampleOptions = {}): T[] {
  const seed = `sample:${opts.seed ?? "agent-climb"}`;
  if (!Number.isInteger(size) || size < 0) throw new RangeError(`size must be a non-negative integer`);
  if (size >= tasks.length) return [...tasks];
  const byHash = (a: T, b: T) => {
    const ha = taskHash(seed, a.id), hb = taskHash(seed, b.id);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  };
  let chosen: T[];
  if (!opts.stratify) {
    chosen = [...tasks].sort(byHash).slice(0, size);
  } else {
    // Round-robin over strata (each stratum hash-ordered), strata visited in order of size desc.
    const groups = new Map<string, T[]>();
    for (const t of tasks) {
      const k = opts.stratify(t);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
    }
    // Interleave by quota so the sample tracks stratum proportions and stays nested.
    const lists = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v.sort(byHash));
    const queue: { t: T; key: number }[] = [];
    for (const list of lists) list.forEach((t, i) => queue.push({ t, key: (i + 0.5) / list.length }));
    queue.sort((a, b) => a.key - b.key || byHash(a.t, b.t));
    chosen = queue.slice(0, size).map((q) => q.t);
  }
  const ids = new Set(chosen.map((t) => t.id));
  return tasks.filter((t) => ids.has(t.id));
}
