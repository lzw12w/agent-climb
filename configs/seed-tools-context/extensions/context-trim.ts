// Context strategy: keep the 3 most recent tool results verbatim; older ones are cut to a head/tail excerpt.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEEP = 3, HEAD = 400, TAIL = 400;

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event: any) => {
    const msgs = event.messages as any[];
    const toolIdx = msgs.map((m, i) => (m.role === "toolResult" ? i : -1)).filter((i) => i >= 0);
    const old = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP)));
    return {
      messages: msgs.map((m, i) => {
        if (!old.has(i) || !Array.isArray(m.content)) return m;
        return { ...m, content: m.content.map((c: any) => c.type === "text" && c.text.length > HEAD + TAIL + 50
          ? { ...c, text: `${c.text.slice(0, HEAD)}\n…[${c.text.length - HEAD - TAIL} chars trimmed by context-trim]…\n${c.text.slice(-TAIL)}` } : c) };
      }),
    };
  });
}
