import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { validateAgentConfig, type AgentConfig } from "../agent-config.js";

/** pi 1.4.0 built-in tool names (`--tools` accepts these plus extension-registered tools). */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface ValidationResult { ok: boolean; errors: string[]; registeredTools: string[]; events: string[] }

/**
 * Cheap pre-eval gate (no model calls): structural checks, then every extension is transpiled with esbuild and
 * its default export is invoked against a recording fake ExtensionAPI. Catches syntax errors, bad imports,
 * throwing factories, tools without names/schemas, and manifest tools that nobody provides.
 */
export async function validateCandidate(c: AgentConfig, opts: { timeoutMs?: number } = {}): Promise<ValidationResult> {
  const errors = validateAgentConfig(c);
  const registeredTools: string[] = [], events: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "agent-climb-validate-"));
  try {
    for (const [name, src] of Object.entries(c.extensions)) {
      let code: string;
      try { code = (await transform(src, { loader: "ts", format: "esm", target: "node22" })).code; }
      catch (e) { errors.push(`extension ${name}: does not compile: ${String((e as Error).message).slice(0, 500)}`); continue; }
      if (/from\s+["']@sinclair\/typebox|from\s+["']typebox/.test(code)) errors.push(`extension ${name}: runtime typebox import; use plain JSON schema`);
      const file = join(dir, name.replace(/\.ts$/, ".mjs"));
      // Type-only pi imports are erased; any remaining runtime import of pi gets a stub.
      await writeFile(file, code.replace(/from\s+["']@earendil-works\/pi-coding-agent["']/g, `from "data:text/javascript,export default {}"`));
      const api = fakeApi(registeredTools, events, (m) => errors.push(`extension ${name}: ${m}`));
      try {
        const mod = await withTimeout(import(pathToFileURL(file).href), opts.timeoutMs ?? 5000);
        if (typeof mod.default !== "function") { errors.push(`extension ${name}: no default export function`); continue; }
        await withTimeout(Promise.resolve(mod.default(api)), opts.timeoutMs ?? 5000);
      } catch (e) { errors.push(`extension ${name}: throws on load: ${String(e).slice(0, 500)}`); }
    }
    for (const t of c.manifest.tools ?? []) if (!BUILTIN_TOOLS.includes(t) && !registeredTools.includes(t)) errors.push(`manifest tool "${t}" is neither built-in nor registered by an extension`);
  } finally { await rm(dir, { recursive: true, force: true }); }
  return { ok: errors.length === 0, errors, registeredTools, events };
}

function fakeApi(tools: string[], events: string[], err: (m: string) => void): any {
  const known: Record<string, (...a: any[]) => unknown> = {
    registerTool: (t: any) => {
      if (!t || typeof t.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(t.name)) return err(`registerTool: bad name ${t?.name}`);
      if (typeof t.execute !== "function") err(`tool ${t.name}: execute is not a function`);
      if (!t.parameters || t.parameters.type !== "object") err(`tool ${t.name}: parameters must be a JSON schema object`);
      if (typeof t.description !== "string" || !t.description) err(`tool ${t.name}: missing description`);
      tools.push(t.name);
    },
    on: (ev: string, h: unknown) => { if (typeof h !== "function") err(`on(${ev}): handler not a function`); events.push(ev); },
  };
  return new Proxy({}, { get: (_t, p: string) => known[p] ?? (() => undefined) });
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms).unref())]);
