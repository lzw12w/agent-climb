// Settle-time self-check: if the agent never ran any command, ask it once to execute its code before stopping.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let ran = false, nudged = false;
  pi.on("tool_execution_start", async (e: any) => { if (e.toolName === "bash" || e.toolName === "write_and_test") ran = true; });
  pi.on("agent_before_settle", async () => {
    if (ran || nudged) return;
    nudged = true;
    pi.sendUserMessage("You have not executed your code yet. Run it against the examples (and a couple of edge cases), fix any failure, then stop.");
  });
}
