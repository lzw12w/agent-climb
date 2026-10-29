import type { AgentConfig } from "../agent-config.js";

export const MUTATION_TYPES = [
  "system_prompt", "append_prompt", "agents_md", "skill", "new_tool", "merged_tool", "tool_selection",
  "tool_interception", "context_hook", "compaction", "settle_check", "model_thinking", "composite",
] as const;
export type MutationType = (typeof MUTATION_TYPES)[number];

export interface FailureExample { taskId: string; prompt: string; feedback: string; trace: string }
export interface HistoryItem { id: string; mutationType: string; rationale: string; outcome: string }

/** Everything the proposer sees. Built ONLY from optimization-set runs (enforced in climb.ts). */
export interface ProposerInput {
  parentId: string;
  parent: AgentConfig;
  scores: { optScore: number; optCostPerTask: number; screenScore?: number };
  failures: FailureExample[];
  /** Short summaries of passing runs (cost/turns), useful for efficiency mutations. */
  passingStats: string;
  history: HistoryItem[];
  surfaceDoc: string;
}

/** Edits are whole-file writes relative to the config dir; null deletes the file. */
export interface Proposal { mutationType: MutationType | string; rationale: string; files: Record<string, string | null>; costUsd: number }
export type Proposer = (input: ProposerInput) => Promise<Proposal>;

export function configToFiles(c: AgentConfig): Record<string, string> {
  const f: Record<string, string> = { "agent.json": JSON.stringify(c.manifest, null, 2) + "\n" };
  if (c.systemPrompt !== undefined) f["SYSTEM.md"] = c.systemPrompt;
  if (c.appendSystemPrompt !== undefined) f["APPEND_SYSTEM.md"] = c.appendSystemPrompt;
  if (c.agentsMd !== undefined) f["AGENTS.md"] = c.agentsMd;
  for (const [n, s] of Object.entries(c.extensions)) f[`extensions/${n}`] = s;
  for (const [n, s] of Object.entries(c.skills)) {
    f[`skills/${n}/SKILL.md`] = `---\nname: ${n}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}`;
    for (const [p, v] of Object.entries(s.files ?? {})) f[`skills/${n}/${p}`] = v;
  }
  return f;
}

const SYSTEM = `You improve a coding agent built on the "pi" coding agent by editing ONLY its AgentConfig directory (never pi core).
Directory layout: agent.json (manifest: name, model, thinking, tools[], settings{} e.g. compaction), SYSTEM.md (replaces system prompt), APPEND_SYSTEM.md, AGENTS.md (project context), skills/<kebab-name>/SKILL.md (frontmatter name+description, body), extensions/<name>.ts (pi extensions).
Extension rules: \`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\` type-only; \`export default function (pi: ExtensionAPI) {...}\`; tool parameters are PLAIN JSON schema objects (no typebox); a tool's execute(id, params, signal, onUpdate, ctx) returns {content:[{type:"text",text}], details: undefined}; ctx.executeTool(name,args) resolves to {result:{content}, isError}. Any tool you register and want visible must be listed in agent.json "tools". Use python3 (not python).
Mutation space (be inventive, do not only tweak prompts): ${MUTATION_TYPES.join(", ")}. Optimize pass rate first, then cost per task (tokens/turns). Avoid repeating mutation ideas that already failed in history. Keep changes small and causal: one idea per proposal.
Reply with ONLY a JSON object: {"mutation_type": string, "rationale": string (why, citing failures/stats), "files": {"<relative path>": "<full new content>" | null}}. Include only changed files. Always rewrite agent.json with "mutation" and "parent" left to the harness (they are overwritten).`;

export function buildProposerMessages(i: ProposerInput): { system: string; user: string } {
  const files = configToFiles(i.parent);
  const user = [
    `# pi extension surface (reference)\n${i.surfaceDoc}`,
    `# Current config (${i.parentId}) files`,
    ...Object.entries(files).map(([p, c]) => `## ${p}\n\`\`\`\n${c}\n\`\`\``),
    `# Scores on optimization set\npass rate ${i.scores.optScore.toFixed(3)}, mean cost/task $${i.scores.optCostPerTask.toFixed(5)}`,
    `# Passing-run stats\n${i.passingStats}`,
    `# Failing optimization tasks (${i.failures.length})`,
    ...i.failures.map((f) => `## ${f.taskId}\nTask: ${f.prompt.slice(0, 1200)}\nScorer feedback:\n${f.feedback.slice(0, 1500)}\nTrace (condensed):\n${f.trace}`),
    `# History of tried mutations\n${i.history.map((h) => `- ${h.id} [${h.mutationType}] ${h.outcome}: ${h.rationale.slice(0, 200)}`).join("\n") || "(none)"}`,
  ].join("\n\n");
  return { system: SYSTEM, user };
}

/** Condense a pi JSON-mode trace to tool calls + truncated results + final text. */
export function condenseTrace(jsonl: string, maxChars = 4000): string {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.parentToolCallId) continue;
    if (e.type === "tool_execution_start") out.push(`> ${e.toolName} ${JSON.stringify(e.args ?? {}).slice(0, 300)}`);
    else if (e.type === "tool_execution_end") out.push(`< ${e.isError ? "ERR " : ""}${(e.result?.content ?? []).map((c: any) => c.text ?? "").join("").slice(0, 300)}`);
    else if (e.type === "message_end" && e.message?.role === "assistant") {
      const t = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      if (t) out.push(`assistant: ${t.slice(0, 300)}`);
    }
  }
  const s = out.join("\n");
  return s.length > maxChars ? s.slice(0, maxChars / 2) + "\n…\n" + s.slice(-maxChars / 2) : s;
}

/** OpenAI-compatible chat proposer (DeepSeek by default). Key is read from env and never logged. */
export function openAiCompatProposer(o: { baseUrl?: string; model?: string; apiKeyEnv?: string; priceIn?: number; priceOut?: number; priceCached?: number; fetchImpl?: typeof fetch } = {}): Proposer {
  const baseUrl = o.baseUrl ?? "https://api.deepseek.com", model = o.model ?? "deepseek-v4-pro", keyEnv = o.apiKeyEnv ?? "DEEPSEEK_API_KEY";
  const [pin, pout, pc] = [o.priceIn ?? 1.32, o.priceOut ?? 3.96, o.priceCached ?? 0.044]; // $/Mtok, from pi's model catalog
  const f = o.fetchImpl ?? fetch;
  return async (input) => {
    const key = process.env[keyEnv];
    if (!key) throw new Error(`${keyEnv} not set`);
    const { system, user } = buildProposerMessages(input);
    const res = await f(`${baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_object" }, max_tokens: 16000 }),
    });
    if (!res.ok) throw new Error(`proposer HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j: any = await res.json();
    const u = j.usage ?? {};
    const cached = u.prompt_cache_hit_tokens ?? 0;
    const costUsd = (((u.prompt_tokens ?? 0) - cached) * pin + cached * pc + (u.completion_tokens ?? 0) * pout) / 1e6;
    return { ...parseProposal(j.choices?.[0]?.message?.content ?? ""), costUsd };
  };
}

export function parseProposal(text: string): Omit<Proposal, "costUsd"> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("proposer returned no JSON");
  const p = JSON.parse(m[0]);
  if (typeof p.files !== "object" || !p.files) throw new Error("proposal has no files");
  return { mutationType: String(p.mutation_type ?? "unknown"), rationale: String(p.rationale ?? ""), files: p.files };
}
