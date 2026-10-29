import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { climb, validateCandidate, writeReport, type Evaluator, type Proposal, type Proposer, type ProposerInput, loadAgentConfig } from "../src/index.js";

const seedDir = join(__dirname, "..", "configs", "baseline");
const bench = { name: "synth", version: "1", scorer: { score: async () => ({ taskId: "", score: 0, passed: false }) },
  loadTasks: async () => Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, prompt: `synthetic task number ${i} with a long unique prompt body for leak checks ${i}`, input: {} })) };
const opts = (runDir: string, extra = {}) => ({ runDir, seedConfigDir: seedDir, budgetUsd: 10, maxIterations: 5, patience: 5, screenSize: 4, optSize: 10, heldOutSize: 6, ...extra });

/** Mock pi: behaviour is keyed off the candidate's APPEND_SYSTEM.md. Seed fails every task whose number is divisible by 3. */
const mockEval = (calls: { dir: string; ids: string[] }[], heldOut: () => Set<string>): Evaluator => async ({ configDir, tasks }) => {
  calls.push({ dir: configDir, ids: tasks.map((t) => t.id) });
  const c = await loadAgentConfig(configDir);
  const mode = c.appendSystemPrompt ?? "";
  return tasks.map((t) => {
    const n = Number(t.id.slice(1));
    let passed = n % 3 !== 0;
    if (mode.includes("GOOD")) passed = true;
    if (mode.includes("OVERFIT")) passed = !heldOut().has(t.id) ? true : n % 2 === 0 && n % 3 !== 0;
    if (mode.includes("BAD")) passed = false;
    const cost = mode.includes("CHEAP") ? 0.001 : 0.01;
    return { taskId: t.id, passed, score: passed ? 1 : 0, costUsd: cost, turns: 3, toolCalls: 2, feedback: passed ? "" : "AssertionError" };
  });
};
const scripted = (ps: Partial<Proposal>[], seen: ProposerInput[] = []): Proposer => async (i) => {
  seen.push(i);
  const p = ps[Math.min(seen.length - 1, ps.length - 1)]!;
  return { mutationType: "append_prompt", rationale: "r", files: {}, costUsd: 0.05, ...p };
};
const tmp = () => mkdtemp(join(tmpdir(), "climb-"));
const state = async (d: string) => JSON.parse(await readFile(join(d, "state.json"), "utf8"));

describe("validateCandidate", () => {
  const base = { manifest: { name: "x", tools: ["read", "bash"] }, skills: {}, extensions: {} as Record<string, string> };
  it("accepts a well-formed tool extension", async () => {
    const r = await validateCandidate({ ...base, manifest: { name: "x", tools: ["read", "my_tool"] }, extensions: { "t.ts": `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) { pi.registerTool({ name: "my_tool", label: "m", description: "d", parameters: { type: "object", properties: {} }, async execute() { return { content: [] }; } }); pi.on("context", async () => undefined); }` } });
    expect(r.errors).toEqual([]); expect(r.registeredTools).toEqual(["my_tool"]); expect(r.events).toEqual(["context"]);
  });
  it("rejects syntax errors, throwing factories and unknown tools", async () => {
    expect((await validateCandidate({ ...base, extensions: { "a.ts": "export default function (pi) { pi.on(" } })).errors[0]).toMatch(/does not compile/);
    expect((await validateCandidate({ ...base, extensions: { "a.ts": "export default function () { throw new Error('x') }" } })).errors[0]).toMatch(/throws on load/);
    expect((await validateCandidate({ ...base, manifest: { name: "x", tools: ["ghost"] } })).errors[0]).toMatch(/ghost/);
    expect((await validateCandidate({ ...base, extensions: { "a.ts": "export default (pi: any) => pi.registerTool({ name: 'Bad Name' })" } })).ok).toBe(false);
  });
  it("accepts the bundled seed extensions", async () => {
    expect((await validateCandidate(await loadAgentConfig(join(__dirname, "..", "configs", "seed-tools-context")))).errors).toEqual([]);
  });
});

describe("climb (mocked proposer + runner)", () => {
  it("rejects broken candidates before eval, accepts a real improvement, writes report with diff", async () => {
    const d = await tmp(); const calls: any[] = []; let ho = new Set<string>();
    const s = await climb(bench, scripted([
      { mutationType: "new_tool", files: { "extensions/x.ts": "export default function (pi) { pi.on(" } },
      { mutationType: "append_prompt", rationale: "fix div-by-3", files: { "APPEND_SYSTEM.md": "GOOD" } },
      { files: { "APPEND_SYSTEM.md": "BAD" } },
    ]), mockEval(calls, () => ho), { ...opts(d), maxIterations: 3 });
    ho = new Set(s.split.heldOut);
    expect(s.candidates.c001!.status).toBe("invalid");
    expect(calls.some((c) => c.dir.includes("c001"))).toBe(false);
    expect(s.candidates.c002!.status).toBe("accepted");
    expect(s.bestId).toBe("c002");
    expect(s.candidates.c003!.status).toBe("screen_reject");
    expect(s.candidates.c003!.parent).toBe("c002");
    const m = JSON.parse(await readFile(join(d, "candidates", "c002", "config", "agent.json"), "utf8"));
    expect(m).toMatchObject({ parent: "c000", name: "c002" }); expect(m.mutation).toMatch(/append_prompt: fix div-by-3/);
    // screening sample nested in opt subset, opt and held-out disjoint
    expect(s.split.screen.every((i: string) => s.split.optSubset.includes(i))).toBe(true);
    expect(s.split.opt.some((i: string) => s.split.heldOut.includes(i))).toBe(false);
    // screening reused parent's cached results: c000 evaluated only on optSubset + heldOutSubset, once each
    expect(calls.filter((c) => c.dir.includes("c000")).length).toBe(2);
    const md = await writeReport(d, s);
    expect(md).toMatch(/\+GOOD/); expect(md).toMatch(/c000 → c002/); expect(md).toMatch(/max iterations/);
  });

  it("proposer never sees held-out tasks", async () => {
    const d = await tmp(); const seen: ProposerInput[] = [];
    const s = await climb(bench, scripted([{ files: { "APPEND_SYSTEM.md": "BAD" } }], seen), mockEval([], () => new Set()), { ...opts(d), maxIterations: 2 });
    expect(seen.length).toBe(2);
    const blob = JSON.stringify(seen.map((x) => ({ ...x, surfaceDoc: "" })));
    for (const id of s.split.heldOut) expect(blob).not.toContain(`synthetic task number ${id.slice(1)} `);
    expect(seen[0]!.failures.length).toBeGreaterThan(0);
    expect(seen[0]!.failures.every((f) => s.split.opt.includes(f.taskId))).toBe(true);
  });

  it("flags overfitting and rejects on held-out", async () => {
    const d = await tmp(); let ho = new Set<string>();
    const ev = mockEval([], () => ho);
    const wrapped: Evaluator = async (o) => { ho = new Set((await state(d)).split.heldOut); return ev(o); };
    const s = await climb(bench, scripted([{ files: { "APPEND_SYSTEM.md": "OVERFIT" } }]), wrapped, { ...opts(d), maxIterations: 1 });
    expect(s.candidates.c001!.status).toBe("heldout_reject");
    expect(s.candidates.c001!.overfit).toMatch(/held-out|gap/);
    expect(s.bestId).toBe("c000");
  });

  it("accepts equal-score cheaper candidates (cost tiebreak)", async () => {
    const d = await tmp();
    const s = await climb(bench, scripted([{ files: { "APPEND_SYSTEM.md": "CHEAP" } }]), mockEval([], () => new Set()), { ...opts(d), maxIterations: 1 });
    expect(s.candidates.c001!.status).toBe("accepted");
  });

  it("stops on held-out plateau and on budget", async () => {
    const d1 = await tmp();
    const s1 = await climb(bench, scripted([{ files: { "APPEND_SYSTEM.md": "BAD" } }]), mockEval([], () => new Set()), { ...opts(d1), maxIterations: 10, patience: 2 });
    expect(s1.done).toMatch(/plateau/); expect(s1.iteration).toBe(2);
    const d2 = await tmp();
    // seed costs 16 tasks * 0.01 = 0.16; each proposal 0.05; budget 0.3
    const s2 = await climb(bench, scripted([{ files: { "APPEND_SYSTEM.md": "BAD" } }]), mockEval([], () => new Set()), { ...opts(d2), budgetUsd: 0.3, maxIterations: 50, patience: 50 });
    expect(s2.done).toMatch(/budget/);
    expect(s2.spent.proposer + s2.spent.eval).toBeLessThan(0.3 + 0.05 + 0.04 + 1e-9);
  });

  it("resumes from the run dir without re-evaluating cached tasks", async () => {
    const d = await tmp(); const calls: any[] = [];
    const p = scripted([{ files: { "APPEND_SYSTEM.md": "BAD" } }]);
    await climb(bench, p, mockEval(calls, () => new Set()), { ...opts(d), maxIterations: 1 });
    const n = calls.length;
    const s = await climb(bench, p, mockEval(calls, () => new Set()), { ...opts(d), maxIterations: 1 });
    expect(calls.length).toBe(n); expect(s.iteration).toBe(1);
    // raising the cap continues from iteration 1
    const st = await state(d); st.done = undefined; await (await import("node:fs/promises")).writeFile(join(d, "state.json"), JSON.stringify(st));
    const s3 = await climb(bench, p, mockEval(calls, () => new Set()), { ...opts(d), maxIterations: 2 });
    expect(s3.iteration).toBe(2); expect(Object.keys(s3.candidates)).toEqual(["c000", "c001", "c002"]);
    expect(calls.filter((c) => c.dir.includes("c000")).length).toBe(2);
  });

  it("records proposer errors and keeps going", async () => {
    const d = await tmp();
    let k = 0;
    const s = await climb(bench, async () => { if (k++ === 0) throw new Error("HTTP 500"); return { mutationType: "x", rationale: "", files: { "APPEND_SYSTEM.md": "GOOD" }, costUsd: 0 }; }, mockEval([], () => new Set()), { ...opts(d), maxIterations: 2 });
    expect(s.candidates.c001!.status).toBe("proposer_error"); expect(s.candidates.c002!.status).toBe("accepted");
  });
});
