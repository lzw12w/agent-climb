import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClimbState } from "./climb.js";

const bar = (x: number, w = 20) => "█".repeat(Math.round(x * w)).padEnd(w, "·");

export function diffDirs(a: string, b: string): string {
  try { return execFileSync("diff", ["-ruN", a, b], { encoding: "utf8" }); }
  catch (e: any) { return e.stdout ?? String(e); } // diff exits 1 when files differ
}

export async function writeReport(runDir: string, s: ClimbState): Promise<string> {
  const cands = Object.values(s.candidates);
  const best = s.candidates[s.bestId]!;
  const seed = s.candidates["c000"]!;
  const total = s.spent.proposer + s.spent.eval;
  const L: string[] = [];
  L.push(`# agent-climb report: ${s.benchmark}`, "");
  L.push(`- Stopped: ${s.done ?? "(running)"}`, `- Iterations: ${s.iteration}; candidates: ${cands.length}`);
  L.push(`- Split: opt ${s.split.opt.length} (subset ${s.split.optSubset.length}, screen ${s.split.screen.length}), held-out ${s.split.heldOut.length} (subset ${s.split.heldOutSubset.length})`);
  L.push(`- Seed: opt ${seed.opt?.score.toFixed(3)} / held-out ${seed.heldOut?.score.toFixed(3)} @ $${seed.opt?.costPerTask.toFixed(5)}/task`);
  L.push(`- Best: **${best.id}** opt ${best.opt?.score.toFixed(3)} / held-out ${best.heldOut?.score.toFixed(3)} @ $${best.opt?.costPerTask.toFixed(5)}/task`);
  L.push(`- Cost: total $${total.toFixed(4)} (proposer $${s.spent.proposer.toFixed(4)}, eval $${s.spent.eval.toFixed(4)})`, "");
  L.push("## Score curve (best so far)", "", "| iter | best | opt | held-out | spent $ |", "|---|---|---|---|---|");
  for (const p of s.curve) L.push(`| ${p.iteration} | ${p.bestId} | ${bar(p.opt)} ${p.opt.toFixed(3)} | ${bar(p.heldOut)} ${p.heldOut.toFixed(3)} | ${p.spentUsd.toFixed(4)} |`);
  L.push("", "## Candidates", "", "| id | parent | mutation | status | screen (cand vs parent) | opt | held-out | proposer $ | flags |", "|---|---|---|---|---|---|---|---|---|");
  for (const c of cands) {
    const sc = c.screen ? `${c.screen.score.toFixed(2)}@${c.screen.costPerTask.toFixed(5)} vs ${c.screen.parent.score.toFixed(2)}@${c.screen.parent.costPerTask.toFixed(5)}` : "";
    L.push(`| ${c.id} | ${c.parent ?? ""} | ${c.mutationType} | ${c.status} | ${sc} | ${c.opt ? `${c.opt.score.toFixed(3)}@${c.opt.costPerTask.toFixed(5)}` : ""} | ${c.heldOut ? `${c.heldOut.score.toFixed(3)}@${c.heldOut.costPerTask.toFixed(5)}` : ""} | ${c.proposerCostUsd.toFixed(4)} | ${c.overfit ? "⚠ overfit: " + c.overfit : ""}${c.errors ? " errors: " + c.errors.join("; ").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 200) : ""} |`);
  }
  L.push("", "## Lineage of best", "");
  const chain: string[] = [];
  for (let id: string | undefined = best.id; id; id = s.candidates[id]?.parent) chain.unshift(id);
  L.push(chain.join(" → "), "");
  L.push("## Rationales", "");
  for (const c of cands.filter((c) => c.parent)) L.push(`- **${c.id}** [${c.mutationType}] (${c.status}): ${c.rationale.replace(/\n/g, " ")}`);
  L.push("", "## Diffs of accepted mutations", "");
  const acc = cands.filter((c) => c.status === "accepted");
  if (!acc.length) L.push("_No mutation was accepted._");
  for (const c of acc) {
    const d = diffDirs(join(runDir, "candidates", c.parent!, "config"), join(runDir, "candidates", c.id, "config"));
    L.push(`### ${c.parent} → ${c.id} (${c.mutationType})`, "", "```diff", d.replaceAll(runDir + "/", ""), "```", "");
  }
  const md = L.join("\n") + "\n";
  await writeFile(join(runDir, "report.md"), md);
  return md;
}
