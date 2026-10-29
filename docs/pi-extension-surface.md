# pi extension surface: every knob the climber can turn

Checked against `@earendil-works/pi-coding-agent@1.4.0` (npm tarball; requires Node >= 22.19).
Refs: `docs/*.md` = files in the npm package (also at github.com/earendil-works/pi/tree/main/packages/coding-agent/docs),
`types.d.ts` = `dist/core/extensions/types.d.ts` (source: `packages/coding-agent/src/core/extensions/types.ts`).

RSI column: **High** = core search dimension, **Med** = useful secondary, **Low** = rarely matters for benchmarks,
**No** = irrelevant headless / must stay fixed for fair comparison.

## 1. Running pi headless (how agent-climb drives it)

| Mode | How | Ref |
|---|---|---|
| print | `pi -p "..."` final text to stdout | docs/cli.md#modes |
| JSON event stream | `pi --mode json "..."` → JSONL: `session`, `agent_start`, `turn_*`, `message_*` (assistant `message_end.message.usage` has tokens + `cost.total` USD), `tool_execution_*`, `compaction_*`, `agent_settled` | docs/json.md |
| RPC | `pi --mode rpc`, JSONL commands on stdin | docs/rpc.md, docs/rpc-commands.md, examples/rpc-client.ts |
| SDK | in-process `createAgentSession(...)`, subscribe to events | docs/sdk.md, examples/sdk/ |

agent-climb uses **JSON mode** (process isolation, per-task cwd, trivial to mock). Isolation flags:
`--no-session`, `--offline`, `-a` (trust project files), `PI_CODING_AGENT_DIR=<candidate dir>` (docs/environment-variables.md) so the
user's `~/.pi` is never read or written. `-ne -ns -np -nc --no-mcp` disable *discovered* resources while explicit `-e/--skill` still load (docs/cli.md#resource-options).

## 2. Knobs

| # | Knob | Mechanism | Ref | RSI |
|---|---|---|---|---|
| 1 | Replace system prompt | `--system-prompt <text\|file>`, `<agent-dir>/SYSTEM.md`, `.pi/SYSTEM.md` | docs/cli.md#prompt-and-display-options, docs/configuration.md | High |
| 2 | Append to system prompt | `--append-system-prompt` (repeatable), `APPEND_SYSTEM.md` | same | High |
| 3 | Per-turn system prompt rewrite | `before_agent_start` → `{ systemPrompt }`, or inject a custom `message` | types.d.ts `BeforeAgentStartEventResult` | High (dynamic prompts, task-type routing) |
| 4 | Context files | `AGENTS.md` / `CLAUDE.md` / `AGENTS.override.md` in agent dir + cwd ancestors; `-nc` disables | docs/configuration.md | Med (≈ appended prompt; keep benchmark cwd clean) |
| 5 | Skills | dir with `SKILL.md` (frontmatter `name`, `description`, `disable-model-invocation`); only name+desc+path go in prompt, body loaded on demand; `--skill`, `skills` setting | docs/skills.md | High (progressive disclosure = cheap context) |
| 6 | Prompt templates | `--prompt-template`, `/name` expansion | docs/prompt-templates.md | Low (headless prompts are ours) |
| 7 | Built-in tool selection | `--tools a,b` / `+x,-y`, `-xt`, `-nbt`, `-nt`, `defaultTools`; built-ins read, bash, edit, write, grep, find, ls | docs/cli.md#tool-options | High (removal also a knob) |
| 8 | Custom tools | `pi.registerTool({name, description, parameters (TypeBox/JSON schema), execute, outputSchema?, terminate?})` | docs/extensions.md#tools, examples/extensions/truncated-tool.ts | **High** – new tools |
| 9 | Composite / merged tools | inside `execute`, `ctx.executeTool(name,args)` calls other tools through normal validation + hooks; nested usage aggregated | docs/extensions.md#tools | **High** – e.g. `edit_and_test`, `write_and_run` |
| 10 | Override built-ins | register an extension tool with the same name (documented for `codemode`/`tool_search`; for others unverified) or disable built-in + register replacement under new name | docs/mcp.md L268 | High |
| 11 | Dynamic tool activation | `pi.setActiveTools()`, `getActiveTools()`, `getAllTools()`; exposure modes | docs/extensions.md#activate-tools-dynamically, #tool-exposure | Med (phase-based tool sets) |
| 12 | codemode | built-in extension tool: model writes JS calling tools in QuickJS, only script output reaches model; `codemode.mode`, `codemode.inlineBudget` | docs/codemode.md, docs/settings.md#tools | **High** (token saver) |
| 13 | tool_search | defer tool declarations, load on demand | docs/cli.md | Med |
| 14 | Tool-call gate / arg rewrite | `tool_call` → `{block, reason, terminate}`; mutate `event.input` | types.d.ts `ToolCallEventResult` | High (guardrails, auto-fix args) |
| 15 | Tool-result rewrite | `tool_result` → `{content, details, structuredContent, isError}` | types.d.ts `ToolResultEventResult` | **High** (truncate/summarize noisy output) |
| 16 | Context filtering per LLM call | `context` → `{messages}`; `context_with_system` full transcript incl. system | types.d.ts `ContextEvent` | **High** (custom context management: drop stale tool output, keep last N reads, etc.) |
| 17 | Compaction settings | `compaction.enabled/reserveTokens/keepRecentTokens/modelOverrides` | docs/compaction.md#settings, docs/settings.md | High |
| 18 | Custom compaction | `session_before_compact` → cancel or supply own `summary`; `session_compact(_failed)` | docs/compaction.md#custom-summarization-via-extensions, examples/extensions/custom-compaction.ts | **High** |
| 19 | Branch summary | `branchSummary.*`, `session_before_tree` | docs/compaction.md | Low (interactive trees) |
| 20 | Final-check / continuation | `agent_before_settle` (append entries or request one more continuation), `turn_end` boundary result | docs/extensions.md#choose-an-event-by-intent | **High** (e.g. "tests not run yet → continue") |
| 21 | Inject messages | `pi.sendMessage(custom, {triggerTurn})`, `pi.sendUserMessage()`, `appendEntry()` | types.d.ts L1258–1272 | Med (reflection / plan reminders) |
| 22 | Input transform | `input` event | docs/extensions.md | Med (rewrite task prompt) |
| 23 | Provider payload | `before_provider_request` / `_headers`, `after_provider_response`, `provider_stream_event` | docs/extensions.md | Low (careful: can break fairness) |
| 24 | Message rewrite | `message_end` → replace finalized message | types.d.ts `MessageEndEventResult` | Low |
| 25 | Model + thinking | `--model`, `--thinking off..max`, `defaultThinkingLevel`, `thinkingBudgets`, `pi.setModel/setThinkingLevel` at runtime | docs/cli.md#model-options, docs/settings.md | Med – **usually fixed** for fair comparison; cost knob; runtime escalation (cheap model, escalate on failure) is a High-value strategy |
| 26 | Custom providers / virtual models | `pi.registerProvider`, models.json, virtual-models | docs/custom-provider.md, docs/virtual-models.md | Low (routing experiments only) |
| 27 | Retry | `retry.*` | docs/settings.md#network-and-retries | Low (robustness, not quality) |
| 28 | Shell | `shellPath`, `shellCommandPrefix` (e.g. `timeout 30`) | docs/settings.md#shell | Med |
| 29 | MCP servers | `pi.registerMcpServer`, mcp.json | docs/mcp.md | Low for offline benchmarks |
| 30 | State / events bus | `appendEntry`, `pi.events` | docs/extensions.md#state | Med (scratchpad / memory tool) |
| 31 | Flags / commands / shortcuts | `registerFlag`, `registerCommand`, `registerShortcut` | types.d.ts | No (interactive) |
| 32 | UI: themes, widgets, header/footer, renderers, editor, TUI settings | `registerToolRenderer`, `registerMessageRenderer`, themes, `tui*`/`terminal.*` settings | docs/themes.md, docs/tui.md | **No** (irrelevant headless) |
| 33 | Packages | `pi install`, `packages` setting | docs/packages.md | No (we ship a dir instead) |
| 34 | Project trust, telemetry, updates | `defaultProjectTrust`, `enableInstallTelemetry`, … | docs/security.md | No (fix for reproducibility) |
| 35 | Images | `images.*` | docs/settings.md | No for text benchmarks |

## 3. Out of bounds (pi core)
Agent loop, built-in tool implementations, compaction algorithm internals, session format. The climber may wrap or
replace them **via extensions** (#8–#18) but never patches `node_modules/@earendil-works/*`.

## 4. Verified in a smoke run (pi 1.4.0, deepseek/deepseek-flash)

- Extensions loaded via `-e` from a materialized agent dir with type-only imports and plain JSON-schema `parameters`; no typebox resolution was needed.
- `ctx.executeTool(name, args)` resolves to an `AgentToolCallOutcome` shaped as `{ result: { content, structuredContent? }, isError }`, not a bare tool result. Composite tools must read `.result.content`.
- Nested calls show up in the JSON event stream with `parentToolCallId`, so traces still contain the inner bash/write calls.
