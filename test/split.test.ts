import { describe, expect, it } from "vitest";
import { sampleTasks, splitTasks } from "../src/split.js";

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, lang: i % 3 === 0 ? "py" : "js" }));

describe("splitTasks", () => {
  it("is deterministic and independent of input order", () => {
    const a = splitTasks(mk(100), { seed: "s" });
    const b = splitTasks([...mk(100)].reverse(), { seed: "s" });
    expect(a.heldOut.map((t) => t.id).sort()).toEqual(b.heldOut.map((t) => t.id).sort());
  });
  it("respects ratio and partitions", () => {
    const s = splitTasks(mk(100), { heldOutRatio: 0.2 });
    expect(s.heldOut).toHaveLength(20);
    expect(s.optimization).toHaveLength(80);
    const ids = new Set([...s.heldOut, ...s.optimization].map((t) => t.id));
    expect(ids.size).toBe(100);
  });
  it("different seeds give different splits", () => {
    const a = splitTasks(mk(100), { seed: "a" }).heldOut.map((t) => t.id);
    const b = splitTasks(mk(100), { seed: "b" }).heldOut.map((t) => t.id);
    expect(a).not.toEqual(b);
  });
  it("adding tasks mostly keeps existing assignments", () => {
    const a = new Set(splitTasks(mk(100), { seed: "x" }).heldOut.map((t) => t.id));
    const b = splitTasks(mk(110), { seed: "x" }).heldOut.map((t) => t.id);
    const kept = b.filter((id) => a.has(id)).length;
    expect(kept).toBeGreaterThanOrEqual(27);
  });
  it("keeps both sides non-empty for tiny sets and validates input", () => {
    const s = splitTasks(mk(2), { heldOutRatio: 0.01 });
    expect(s.heldOut).toHaveLength(1);
    expect(() => splitTasks(mk(3), { heldOutRatio: 1 })).toThrow(RangeError);
    expect(() => splitTasks([{ id: "a" }, { id: "a" }])).toThrow(/duplicate/);
  });
  it("is pinned (stable across versions/runtimes)", () => {
    expect(splitTasks(mk(10), { seed: "pin", heldOutRatio: 0.3 }).heldOut.map((t) => t.id)).toMatchSnapshot();
  });
});

describe("sampleTasks", () => {
  it("is deterministic and nested", () => {
    const t = mk(50);
    const s5 = sampleTasks(t, 5, { seed: "q" }).map((x) => x.id);
    expect(sampleTasks(t, 5, { seed: "q" }).map((x) => x.id)).toEqual(s5);
    const s10 = new Set(sampleTasks(t, 10, { seed: "q" }).map((x) => x.id));
    expect(s5.every((id) => s10.has(id))).toBe(true);
  });
  it("returns all when size >= n, rejects bad size", () => {
    expect(sampleTasks(mk(3), 10)).toHaveLength(3);
    expect(() => sampleTasks(mk(3), -1)).toThrow();
  });
  it("stratifies proportionally and stays nested", () => {
    const t = mk(90); // 30 py, 60 js
    const s = sampleTasks(t, 9, { stratify: (x) => x.lang });
    expect(s.filter((x) => x.lang === "py")).toHaveLength(3);
    const s18 = new Set(sampleTasks(t, 18, { stratify: (x) => x.lang }).map((x) => x.id));
    expect(s.every((x) => s18.has(x.id))).toBe(true);
  });
});
