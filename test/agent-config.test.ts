import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentConfig, materialize, validateAgentConfig, writeAgentConfig, type AgentConfig } from "../src/agent-config.js";

const cfg: AgentConfig = {
  manifest: { name: "c1", model: "p/m", thinking: "low", tools: ["read", "my_tool"], settings: { compaction: { keepRecentTokens: 1 } } },
  appendSystemPrompt: "be brief",
  skills: { "s-one": { description: "use when x", body: "do y\n", files: { "ref/a.md": "A" } } },
  extensions: { "my-tool.ts": "export default () => {}\n" },
};

describe("AgentConfig", () => {
  it("round-trips through a directory", async () => {
    const d = join(await mkdtemp(join(tmpdir(), "cfg-")), "c");
    await writeAgentConfig(d, cfg);
    expect(await loadAgentConfig(d)).toEqual(cfg);
  });
  it("validates names", () => {
    expect(validateAgentConfig({ ...cfg, skills: { "Bad Name": { description: "", body: "" } }, extensions: { "../x.ts": "" } })).toHaveLength(3);
  });
  it("materializes pi args with discovery disabled and explicit resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfg-"));
    await writeAgentConfig(join(root, "c"), cfg);
    const { args, env } = await materialize(join(root, "c"), join(root, "agent"));
    expect(env.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
    expect(args).toEqual(expect.arrayContaining(["--mode", "json", "--no-session", "-ne", "-ns", "--model", "p/m", "--tools", "read,my_tool"]));
    expect(args).toContain(join(root, "agent", "extensions", "my-tool.ts"));
    expect(args).toContain(join(root, "agent", "skills", "s-one"));
    expect(args).not.toContain("--system-prompt");
  });
  it("bundled seed configs load and validate", async () => {
    for (const n of ["baseline", "seed-tools-context"]) {
      const c = await loadAgentConfig(join(__dirname, "..", "configs", n));
      expect(validateAgentConfig(c)).toEqual([]);
    }
  });
});
