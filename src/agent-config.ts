import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * AgentConfig = a directory that pi can load through its extension layer only.
 *
 *   <config>/
 *     agent.json          manifest (model, thinking, tool selection, compaction, lineage)
 *     SYSTEM.md           optional: replaces pi's system prompt        (--system-prompt)
 *     APPEND_SYSTEM.md    optional: appended to the system prompt      (--append-system-prompt)
 *     AGENTS.md           optional: context file, loaded from agent dir
 *     skills/<name>/SKILL.md (+ any bundled files)                     (--skill)
 *     extensions/<x>.ts | extensions/<x>/index.ts                      (-e)
 *         new tools, merged/composite tools, tool_call/tool_result hooks,
 *         context / compaction strategies, settle-time self-checks
 *
 * The climber mutates any of these; see docs/pi-extension-surface.md for the knob catalogue.
 */
export interface AgentManifest {
  name: string;
  description?: string;
  /** pi model pattern, e.g. "deepseek/deepseek-flash". Usually fixed per experiment for fairness. */
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** pi `--tools` list, e.g. ["read","bash","edit_and_test"] or ["+codemode","-write"]. Omit = pi default. */
  tools?: string[];
  excludeTools?: string[];
  /** Merged into the generated settings.json (compaction, codemode, shellCommandPrefix, retry...). */
  settings?: Record<string, unknown>;
  /** Lineage for the climb report. */
  parent?: string;
  mutation?: string;
}

export interface SkillSpec { description: string; body: string; files?: Record<string, string> }

export interface AgentConfig {
  manifest: AgentManifest;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  agentsMd?: string;
  skills: Record<string, SkillSpec>;
  /** filename (e.g. "edit-and-test.ts") -> source. */
  extensions: Record<string, string>;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function validateAgentConfig(c: AgentConfig): string[] {
  const errs: string[] = [];
  if (!c.manifest?.name) errs.push("manifest.name is required");
  for (const n of Object.keys(c.skills)) {
    if (!NAME_RE.test(n)) errs.push(`bad skill name: ${n}`);
    if (!c.skills[n]!.description?.trim()) errs.push(`skill ${n} needs a description`);
  }
  for (const f of Object.keys(c.extensions)) {
    if (!/^[a-z0-9][a-z0-9._-]*\.(ts|js|mjs)$/.test(f)) errs.push(`bad extension filename: ${f}`);
  }
  return errs;
}

const opt = async (p: string) => readFile(p, "utf8").catch(() => undefined);

async function readTree(root: string, base = root, out: Record<string, string> = {}) {
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) await readTree(p, base, out);
    else out[p.slice(base.length + 1)] = await readFile(p, "utf8");
  }
  return out;
}

function parseSkill(md: string): { description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  if (!m) return { description: "", body: md };
  const desc = /^description:\s*(.*)$/m.exec(m[1]!)?.[1]?.trim() ?? "";
  return { description: desc.replace(/^["']|["']$/g, ""), body: m[2]!.replace(/^\n/, "") };
}

export async function loadAgentConfig(dir: string): Promise<AgentConfig> {
  const manifest = JSON.parse(await readFile(join(dir, "agent.json"), "utf8")) as AgentManifest;
  const cfg: AgentConfig = {
    manifest,
    systemPrompt: await opt(join(dir, "SYSTEM.md")),
    appendSystemPrompt: await opt(join(dir, "APPEND_SYSTEM.md")),
    agentsMd: await opt(join(dir, "AGENTS.md")),
    skills: {},
    extensions: {},
  };
  const sd = join(dir, "skills");
  if (await stat(sd).catch(() => null)) {
    for (const e of await readdir(sd, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const files = await readTree(join(sd, e.name));
      const { description, body } = parseSkill(files["SKILL.md"] ?? "");
      delete files["SKILL.md"];
      cfg.skills[e.name] = { description, body, ...(Object.keys(files).length ? { files } : {}) };
    }
  }
  const ed = join(dir, "extensions");
  if (await stat(ed).catch(() => null)) {
    for (const e of await readdir(ed, { withFileTypes: true })) {
      if (e.isFile()) cfg.extensions[e.name] = await readFile(join(ed, e.name), "utf8");
    }
  }
  return cfg;
}

async function put(root: string, rel: string, content: string) {
  const p = resolve(root, rel);
  if (!p.startsWith(resolve(root) + sep)) throw new Error(`path escapes config dir: ${rel}`);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, content);
}

export async function writeAgentConfig(dir: string, c: AgentConfig): Promise<void> {
  const errs = validateAgentConfig(c);
  if (errs.length) throw new Error(`invalid AgentConfig: ${errs.join("; ")}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await put(dir, "agent.json", JSON.stringify(c.manifest, null, 2) + "\n");
  if (c.systemPrompt !== undefined) await put(dir, "SYSTEM.md", c.systemPrompt);
  if (c.appendSystemPrompt !== undefined) await put(dir, "APPEND_SYSTEM.md", c.appendSystemPrompt);
  if (c.agentsMd !== undefined) await put(dir, "AGENTS.md", c.agentsMd);
  for (const [n, s] of Object.entries(c.skills)) {
    await put(dir, `skills/${n}/SKILL.md`, `---\nname: ${n}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}`);
    for (const [f, v] of Object.entries(s.files ?? {})) await put(dir, `skills/${n}/${f}`, v);
  }
  for (const [f, src] of Object.entries(c.extensions)) await put(dir, `extensions/${f}`, src);
}

/**
 * Turn a config dir into a ready-to-use pi agent dir (PI_CODING_AGENT_DIR) + CLI args.
 * Everything is passed explicitly and discovery is disabled, so the run sees only this candidate.
 */
export async function materialize(configDir: string, agentDir: string): Promise<{ args: string[]; env: Record<string, string> }> {
  const cfg = await loadAgentConfig(configDir);
  await cp(configDir, agentDir, { recursive: true });
  const settings = { quietStartup: true, enableInstallTelemetry: false, ...(cfg.manifest.settings ?? {}) };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  const args = ["--offline", "--mode", "json", "--no-session", "-a", "-ne", "-ns", "-np", "--no-mcp", "--no-themes"];
  const m = cfg.manifest;
  if (m.model) args.push("--model", m.model);
  if (m.thinking) args.push("--thinking", m.thinking);
  if (m.tools?.length) args.push("--tools", m.tools.join(","));
  if (m.excludeTools?.length) args.push("--exclude-tools", m.excludeTools.join(","));
  if (cfg.systemPrompt !== undefined) args.push("--system-prompt", join(agentDir, "SYSTEM.md"));
  if (cfg.appendSystemPrompt !== undefined) args.push("--append-system-prompt", join(agentDir, "APPEND_SYSTEM.md"));
  for (const n of Object.keys(cfg.skills).sort()) args.push("--skill", join(agentDir, "skills", n));
  for (const f of Object.keys(cfg.extensions).sort()) args.push("-e", join(agentDir, "extensions", f));
  return { args, env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
}
