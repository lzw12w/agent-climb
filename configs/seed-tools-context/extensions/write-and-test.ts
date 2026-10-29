// Merged tool: write a file, then run a command (tests), return a compact result. Saves one round trip per iteration.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "write_and_test",
    label: "write+test",
    description: "Write `content` to `path`, then run `command` (e.g. `python3 -c ...` or a test runner; use python3, not python) in the working directory. Returns exit code and the last 60 lines of output.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to write (relative to cwd)" },
        content: { type: "string", description: "Full file contents" },
        command: { type: "string", description: "Shell command to run afterwards" },
      },
      required: ["path", "content", "command"],
    } as any,
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      await ctx.executeTool("write", { path: params.path, content: params.content });
      const r: any = await ctx.executeTool("bash", { command: params.command });
      const out = r?.result ?? r; // AgentToolCallOutcome wraps the tool result
      const text = (out?.content ?? []).map((c: any) => c.text ?? "").join("\n");
      const tail = text.split("\n").slice(-60).join("\n");
      return { content: [{ type: "text", text: `${r?.isError ? "COMMAND FAILED\n" : ""}wrote ${params.path}\n$ ${params.command}\n${tail}` }], details: undefined };
    },
  } as any);
}
