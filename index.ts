/**
 * Subagent Widget — /sub, /sublite, /subcont, /subrm, /subclear, /subinspect
 * commands with stacking live widgets + a floating read-only inspector.
 *
 * Each /sub (or /sublite) spawns a background Pi subagent with its own persistent
 * session, enabling conversation continuations via /subcont. The stacked widgets
 * show compact live status; /subinspect opens a floating overlay with the full
 * streamed transcript + tool calls for one subagent.
 *
 * Location: ~/.pi/agent/extensions/subagent-widget/  (auto-discovered via index.ts)
 * Layout (see README.md): this file is the orchestration center; pure modules are
 *   types.ts        — SubState / InspectorEvent
 *   agents.ts      — named-agent discovery + spawn-flag overlay (orchestration §3)
 *   inspector.ts   — floating inspector overlay + event shaping helpers
 *   widget.ts      — compact stacked per-agent widget factory
 *   session.ts     — JSONL session-file make/delete
 *   config.ts      — lite-extension allow-list (config.json sibling)
 *
 * Loaded via pi's global auto-discovery for extension subdirectories (index.ts).
 *
 * Then:
 *   /sub list files and summarize      — spawn a full subagent (extensions on)
 *   /sublite list files and summarize  — spawn a lite subagent (config.json exts only)
 *   /subcont 1 now write tests for it   — continue subagent #1's conversation
 *   /subrm 2 — remove subagent #2 widget
 *   /subclear — clear all subagent widgets
 *   /subinspect [id] — open the floating inspector for one subagent
 *
 * Key behaviors:
 *   - spawnAgent(state, prompt, ctx, lite):
 *       lite=true  → --no-extensions + -e for each entry in config.json, restricted
 *                     tools (read,bash,grep,find,ls), --thinking off
 *       lite=false → extensions enabled by default (no tool/thinking restriction)
 *   - SubState.events is the single source of truth for the current turn; the
 *     widget (tool count, last line) and the inspector both read from it.
 *   - Lite extensions are configured in config.json, read fresh on each spawn.
 *   - JSONL session files are deleted when a subagent is removed — no orphans.
 */
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChainState,
  InspectorEvent,
  SubState,
  SubagentOrigin,
} from "./types.ts";
import { appendText, cap, openInspector, stringifyVal, transcriptText } from "./inspector.ts";
import { makeSessionFile } from "./session.ts";
import {
  createRunDir,
  readMeta,
  removeRunDir,
  runDirPath,
  RUNS_DIR,
  setRunPid,
  writePromptFile,
  writeResultFile,
  type RunMeta,
} from "./rundir.ts";
import { loadDisallowedExtensions, loadLiteExtensions, loadWorktreeMode, NEURALWATT_PROVIDER } from "./config.ts";
import { effectiveDisallowedExtensions, normalizeForMatch, resolveFullModeExtArgs } from "./disallow.ts";
import { buildChainWidget, buildSubagentWidget } from "./widget.ts";
import {
  agentConfigFlags,
  discoverAgents,
  type AgentConfig,
} from "./agents.ts";
import {
  discoverChains,
  type ChainStepDef,
  type ChainTemplate,
} from "./chains.ts";
import {
  createWorktree,
  gitRepoRoot,
  isGitRepo,
  removeWorktree,
  type Worktree,
} from "./worktree.ts";

/** R6: deliver full subagent/chain results without lossy truncation. If the
 *  text fits the inline budget (8000 chars), return it verbatim. Otherwise spill
 *  the FULL text to result.txt INSIDE the run dir (Q2 — was orphaned in $TMPDIR,
 *  now reaped with the run) and return an 8000-char prefix + a pointer, so the
 *  orchestrator can `read` the rest on demand instead of working with a
 *  truncated tail (this is what bit the reviewer subagents). */
const RESULT_INLINE_BUDGET = 8000;
function spillResult(text: string, runDir: string): string {
  if (text.length <= RESULT_INLINE_BUDGET) return text;
  try {
    const filePath = writeResultFile(runDir, text);
    return (
      text.slice(0, RESULT_INLINE_BUDGET) +
      `\n\n... [full result (${text.length} chars) written to: ${filePath} — read it for the complete output]`
    );
  } catch {
    // Spill failed (disk full / perms): fall back to the lossy cap rather than
    // swallow the result entirely. (Matches the pre-R6 behavior.)
    return (
      text.slice(0, RESULT_INLINE_BUDGET) +
      "\n\n... [truncated — full-result spill failed]"
    );
  }
}

/** Parse a target ID shared by the remove/inspect tools + slash commands (spec
 *  §5.1/§6.2). Accepts: a number (`2` → subagent #2), `"2"`/`"#2"` (subagent),
 *  `"C1"`/`"c2"` (whole chain), `"C1@3"` (chain step 3, 1-based). */
type TargetId =
  | { kind: "subagent"; id: number }
  | { kind: "chain"; chainId: number; step?: number }
  | { kind: "invalid"; reason: string };
function parseTargetId(raw: string | number): TargetId {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0)
      return { kind: "invalid", reason: "invalid id" };
    return { kind: "subagent", id: raw };
  }
  const s = raw.trim();
  if (!s) return { kind: "invalid", reason: "empty id" };
  const cm = s.match(/^c(\d+)(?:@(\d+))?$/i);
  if (cm)
    return {
      kind: "chain",
      chainId: parseInt(cm[1], 10),
      step: cm[2] ? parseInt(cm[2], 10) : undefined,
    };
  const sm = s.match(/^#?(\d+)$/);
  if (sm) return { kind: "subagent", id: parseInt(sm[1], 10) };
  return { kind: "invalid", reason: `"${raw}" is not a #N or CN id` };
}

/** Q3: kill a subagent's whole process group (graceful SIGTERM -> forced SIGKILL
 *  after ~5s). The child was spawned detached:true so it (and every process it
 *  spawned) share one process group rooted at its pid; a negative pid kills the
 *  entire group at once, so grandchildren (git, npm, dev servers) die with the
 *  worker instead of orphaning (holding file locks + worktrees). Mirrors pi's
 *  own exec.js graceful->forced. On Windows (no setsid) falls back to a direct
 *  pid kill. Best-effort: a kill failure must never crash the extension. */
function killProcessGroupByPid(pid: number) {
  const win32 = process.platform === "win32";
  const killOne = (sig: NodeJS.Signals) => {
    try { process.kill(pid, sig); } catch {}
  };
  const killGroup = (sig: NodeJS.Signals) => {
    if (win32) { killOne(sig); return; }
    try {
      process.kill(-pid, sig);
    } catch {
      // ESRCH = group already gone (normal if it closed); fall back to direct.
      killOne(sig);
    }
  };
  killGroup("SIGTERM");
  const guard = setTimeout(() => {
    if (win32) killOne("SIGKILL");
    else { try { process.kill(-pid, "SIGKILL"); } catch {} }
  }, 5000);
  guard.unref?.();
}

function terminateProcessGroup(proc: any) {
  if (!proc || proc.pid === undefined) return;
  killProcessGroupByPid(proc.pid);
}

/** Is a pid still alive? (process.kill with signal 0 probes liveness.) */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Q9: sweep stale RunDirs whose spawning pi (meta.parentPid) is no longer
 *  alive. Single reap condition (no age / no status checks — every run the
 *  sweep should NOT touch is already excluded by "parentPid alive"). Reap =
 *  process-group kill the orphaned worker if its pid is known + alive, then
 *  rm -rf the run dir. Returns the reaped run ids (for /sub doctor reporting).
 *  In-session zombies (worker exited, parent still alive) are intentionally
 *  NOT reaped here — those are a /sub doctor diagnostic, not a sweep rule. */
function sweepRuns(): string[] {
  const reaped: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(RUNS_DIR);
  } catch {
    return reaped; // no runs dir yet — nothing to sweep
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue; // only numeric run ids (this session's)
    const dir = path.join(RUNS_DIR, name);
    const meta = readMeta(dir);
    if (!meta) continue; // corrupt/incomplete — leave for /sub doctor
    if (isPidAlive(meta.parentPid)) continue; // parent alive -> not reapable
    // Orphan: parent pi is gone. Kill the live worker process-group (a
    // detached worker may still be running — esp. a blocked one idle between
    // turns), then remove the run dir.
    if (meta.pid && isPidAlive(meta.pid)) killProcessGroupByPid(meta.pid);
    removeRunDir(dir);
    reaped.push(name);
  }
  return reaped;
}

export default function (pi: ExtensionAPI) {
  const agents: Map<number, SubState> = new Map();
  let nextId = 1;
  let widgetCtx: any;
  const chains: Map<number, ChainState> = new Map(); // C-id → running chain coordinator
  let nextChainId = 1;

  // ── Widget rendering ─────────────────────────────────────────────────────
  function updateWidgets() {
    if (!widgetCtx) return;
    try {
      // Standalone subagents render one `sub-${id}` box each. Chain-step
      // SubStates (chainId set) skip the per-step box — they render as rows
      // inside their chain's composite `chain-${id}` widget below, so a chain
      // shows as ONE grouped, labeled box instead of N look-alike step boxes.
      for (const [id, state] of Array.from(agents.entries())) {
        if (state.chainId !== undefined) continue;
        widgetCtx.ui.setWidget(`sub-${id}`, buildSubagentWidget(state));
      }
      for (const chain of Array.from(chains.values())) {
        widgetCtx.ui.setWidget(
          `chain-${chain.id}`,
          buildChainWidget(chain, (sid) => agents.get(sid)),
        );
      }
    } catch {
      // widgetCtx can go stale across session boundaries (e.g. a triggerTurn
      // follow-up in -p/non-TUI mode) while a background subprocess + this
      // widget-refresh timer keep running. A stale refresh must never crash the
      // extension; the next valid ctx (or session_start reset) picks back up.
    }
  }

  // ── Streaming helpers ─────────────────────────────────────────────────────
  // Parse one --mode json line into state.events (text deltas coalesced; tool
  // calls opened by toolCallId and patched in place on update/end). Authoritative
  // event vocabulary from pi docs/json.md.
  function processLine(state: SubState, line: string) {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const type = event.type;
      if (type === "message_update") {
        const delta = event.assistantMessageEvent;
        if (delta?.type === "text_delta") {
          appendText(state, delta.delta || "");
          updateWidgets();
        }
      } else if (type === "tool_execution_start") {
        const idx = state.events.length;
        state.events.push({
          kind: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: cap(stringifyVal(event.args)),
          done: false,
        });
        state.toolIndex.set(event.toolCallId, idx);
        updateWidgets();
      } else if (type === "tool_execution_update") {
        const idx = state.toolIndex.get(event.toolCallId);
        if (idx !== undefined) {
          const ev = state.events[idx];
          if (ev.kind === "tool")
            ev.partial = cap(stringifyVal(event.partialResult));
        }
        updateWidgets();
      } else if (type === "tool_execution_end") {
        const idx = state.toolIndex.get(event.toolCallId);
        if (idx !== undefined) {
          const ev = state.events[idx];
          if (ev.kind === "tool") {
            ev.result = cap(stringifyVal(event.result));
            ev.isError = !!event.isError;
            ev.done = true;
          }
        }
        updateWidgets();
      }
    } catch {}
  }

  function spawnAgent(
    state: SubState,
    prompt: string,
    ctx: any,
    lite: boolean,
    agentConfig?: AgentConfig,
    cwd?: string,
    chainContext?: string,
  ): Promise<void> {
    // §12: when isolated in a worktree, the child's cwd is the worktree path;
    // inject --no-approve so the fresh (untrusted) worktree path can't prompt /
    // pollute the trust store. M1: survivors are resolved against the MAIN repo
    // (process.cwd()), not childCwd — so an untrusted worktree's .pi/extensions
    // + packages can't be auto-loaded via explicit -e into the "isolated" child
    // (explicit -e bypasses trust). Neuralwatt survives via global packages + -e.
    const childCwd = cwd ?? process.cwd();
    const isolated = !!cwd && cwd !== process.cwd();
    // Base args shared by both modes: default model (no --model), --session for resumption.
    const args: string[] = [
      "--mode",
      "json",
      "-p",
      "--session",
      state.sessionFile,
    ];
    if (isolated) args.push("--no-approve");

    if (lite) {
      // Lite: disable discovery, then load only the extensions listed in
      // config.json. Restricted toolset, thinking off. Agent-def overlays
      // (skills/tools) replace the lite defaults when present (spec §3.3).
      const entries = loadLiteExtensions();
      args.push("--no-extensions");
      if (!agentConfig?.skills?.length) args.push("--no-skills");
      for (const e of entries) args.push("-e", e);
      if (!agentConfig?.tools?.length)
        args.push("--tools", "read,bash,grep,find,ls");
      args.push("--thinking", "off");
    } else {
      // Full mode: let pi discover all extensions unless the disallow list
      // (config.json `disallowedExt`) actually matches — then sandbox to the
      // survivors via --no-extensions -e. No match (empty/stale list) → no
      // flags, normal discovery (criterion b, see disallow.ts). M1: resolved
      // against process.cwd() (the trusted MAIN repo), never the worktree's
      // childCwd — so an isolated worktree's .pi/extensions + packages can't
      // reach the child via explicit -e (which bypasses the trust gate).
      const extArgs = resolveFullModeExtArgs(process.cwd());
      if (extArgs) {
        // R4 (8.1): §3.4 promises neuralwatt survives by construction in every
        // mode. The sandboxed survivor list comes from disallow.ts enumeration,
        // which may not mirror pi's own discovery — so guarantee the provider
        // explicitly, unless the user disallowed it (their opt-out).
        const disallowKeys = effectiveDisallowedExtensions(loadDisallowedExtensions()).map(normalizeForMatch);
        const nwKey = normalizeForMatch(NEURALWATT_PROVIDER);
        if (!extArgs.some((e) => normalizeForMatch(e) === nwKey) && !disallowKeys.includes(nwKey)) {
          extArgs.push(NEURALWATT_PROVIDER);
        }
        args.push("--no-extensions");
        for (const e of extArgs) args.push("-e", e);
      }
    }

    // Agent-def overlay (additive over the mode base; spec §3.3). extensions/
    // skills only ever ADD; tools allowlist-restricts; disallowedTools deny-first;
    // model overrides. System prompt → temp file + --append-system-prompt.
    //
    // Subagent identity injection: a spawned child is a fresh `pi` process
    // with no inherent notion it's a subagent — inject a short operational
    // frame so it knows it's a background agent, who spawned it (user via a
    // slash command vs the main agent via a tool), and that its output is
    // returned automatically (work autonomously, don't await user input).
    // Merged into the one --append-system-prompt file: pi keeps only the
    // FIRST flag, so agent identity + subagent context + chain position must
    // all land in a single file here.
    const originLabel = state.origin === "user"
      ? "the user (via a slash command)"
      : "the main agent (via a tool call)";
    const subagentContext =
      `[Subagent context]\n` +
      `You are a subagent — a background agent spawned by ${originLabel} to perform a delegated task. You are not the main agent and do not interact with the user directly. Work autonomously on the task; when finished, your final output is returned to ${originLabel} automatically.`;
    let promptPath: string | null = null;
    if (agentConfig) {
      for (const f of agentConfigFlags(agentConfig)) args.push(f);
    }
    // Assemble body: agent role (if any) → subagent context → chain position (if any).
    const bodyParts: string[] = [];
    if (agentConfig?.systemPrompt.trim())
      bodyParts.push(agentConfig.systemPrompt.trim());
    bodyParts.push(subagentContext);
    if (chainContext?.trim()) bodyParts.push(chainContext.trim());
    const body = bodyParts.join("\n\n");
    // Q2: the --append-system-prompt body lives as prompt.md inside the run dir
    // (was a mkdtemp temp file that leaked on crash). Reaped with the run.
    if (body.trim()) {
      promptPath = writePromptFile(state.runDir, body);
      args.push("--append-system-prompt", promptPath);
    }

    // B2/R2: the prompt is the final positional arg. pi's argv parser eats a
    // leading-`@` token as a file to read into context (exfil via the 8KB-capped
    // followup) and treats a leading-`-` token as a flag invocation — value-less
    // built-in flags (--no-session, --no-tools, …) AND extension-registered
    // flags (--<extflag>) land in unknownFlags, which pi consumes as
    // extensionFlagValues → child behavior togglable from an untrusted chain
    // `task`. R2 broadens the earlier KNOWN_FLAGS approach: prepend a space to
    // ANY prompt whose trimmed form starts with @ or -, so pi never re-parses
    // it as a flag/file. (A genuinely-`@`/`-`-prefixed instruction is rare.)
    const trimmed = prompt.trim();
    const safePrompt =
      trimmed.startsWith("@") || trimmed.startsWith("-") ? " " + prompt : prompt;
    args.push(safePrompt);

    return new Promise((resolve) => {
      // Q3: detached:true → child calls setsid() and becomes a process-group
      // leader (every process it spawns joins that group). Lets us kill the
      // WHOLE tree via process.kill(-pid) instead of orphaning grandchildren
      // (git, npm, tsx, dev servers) that hold file locks + worktrees. Skipped
      // on Windows (no setsid; process.kill(-pid) semantics differ) — falls
      // back to the direct SIGTERM there. We do NOT unref(): we still read
      // stdout + await close in this process.
      const proc = spawn("pi", args, {
        cwd: childCwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        shell: process.platform === "win32",
        detached: process.platform !== "win32",
      });
      state.proc = proc;
      // Q9: persist the worker pid into meta.json so the reaper can process-
      // group-kill an orphaned worker whose parent pi died (meta was written
      // before the child existed; patch it now that pid is known).
      setRunPid(state.runDir, proc.pid!);
      const startTime = Date.now();
      const timer = setInterval(() => {
        state.elapsed = Date.now() - startTime;
        updateWidgets();
      }, 1000);

      let buffer = "";
      proc.stdout!.setEncoding("utf-8");
      proc.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(state, line);
      });
      proc.stderr!.setEncoding("utf-8");
      proc.stderr!.on("data", (chunk: string) => {
        if (chunk.trim()) {
          appendText(state, chunk);
          updateWidgets();
        }
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(state, buffer);
        clearInterval(timer);
        state.elapsed = Date.now() - startTime;
        state.status = code === 0 ? "done" : "error";
        state.proc = undefined;
        updateWidgets();
        // Result body: a tool-name-only summary (how it got the result) followed
        // by the assistant's text output. Full per-call args/results live only in
        // the inspector; nothing detailed leaks into the main conversation.
        const tools = state.events.filter((e) => e.kind === "tool") as Extract<
          InspectorEvent,
          { kind: "tool" }
        >[];
        let toolSummary = "";
        if (tools.length > 0) {
          const counts: Record<string, number> = {};
          for (const t of tools)
            counts[t.toolName] = (counts[t.toolName] ?? 0) + 1;
          toolSummary = `Tools called (${tools.length}): ${Object.entries(
            counts,
          )
            .map(([n, c]) => `${n} ×${c}`)
            .join(", ")}\n\n`;
        }
        const textResult = state.events
          .filter((e) => e.kind === "text")
          .map((e) => (e as Extract<InspectorEvent, { kind: "text" }>).text)
          .join("")
          .trim();
        const result = toolSummary + (textResult || "(no text output)");
        try {
          ctx.ui.notify(
            `Subagent #${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
            state.status === "done" ? "success" : "error",
          );
        } catch {
          // ctx may be stale if this step closes across a follow-up turn boundary
          // in -p/non-TUI mode; the follow-up itself is delivered via pi.sendMessage below.
        }
        if (state.chainId === undefined) {
          // 7.2: suppress the spurious "done/error" followUp when this subagent
          // was explicitly removed (/subrm #N, /subclear, session_start) while
          // running — those delete it from the map, so agents.has is false. A
          // naturally-completed sub stays in the map (for /sublist) → fires.
          if (agents.has(state.id)) {
            pi.sendMessage(
              {
                customType: "subagent-result",
                content: `${state.origin === "user" ? " (This agent was created by User)\n\n" : ""}Subagent #${state.id}${state.lite ? " (⚡lite)" : ""}${state.turnCount > 1 ? ` (Turn ${state.turnCount})` : ""} finished "${prompt}" in ${Math.round(state.elapsed / 1000)}s.\n\nResult:\n${spillResult(result, state.runDir)}`,
                display: true,
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          }
        } else {
          // Chain step: suppress the per-step followUp; the coordinator emits the
          // aggregate (complete/failed/aborted) followUp + auto-advances (spec §7.3).
          onChainStepClose(state, ctx);
        }
        // Q2: prompt.md lives inside state.runDir — reaped with the run, no
        // separate temp cleanup needed.
        resolve();
      });
      proc.on("error", (err) => {
        clearInterval(timer);
        state.status = "error";
        state.proc = undefined;
        appendText(state, `Error: ${err.message}`);
        updateWidgets();
        resolve();
      });
    });
  }

  // ── Tools for the Main Agent ──────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_create",
    description: `Spawn a background subagent to perform a task without disrupting the main conversation & process. Returns the subagent ID immediately while it runs in the background; the subagent pings back with its result as a follow-up message when it finishes, so you can continue other work or stop your turn in the meantime.

Optional \`agent\` (named agent from the \`subagent_catalog\` tool, e.g. "scout"): run the subagent under that agent's role — its system prompt, tools, skills, model, and extensions are applied over the base mode. Use this for single-task agent-driven work without the overhead of the \`orchestrate\` multi-step chain tool. Not supported with lite=true (an agent's extensions would bypass lite's --no-extensions sandbox); combine \`agent\` with \`lite: false\` instead.

Modes (via the 'lite' parameter):
- lite=false (default): full subagent. Extensions enabled, unrestricted tools, default thinking level, default model. Use for complex tasks that benefit from extensions and reasoning.
- lite=true: lite subagent. Only the extensions listed in config.json (sibling of this file) load; restricted tools (read,bash,grep,find,ls), thinking off. Faster and cheaper — use for simple, well-scoped tasks that need only those tools. If the task needs any other tool (e.g. web fetch/search, browser, context7), use lite=false instead. To discover defined agents/templates use the \`subagent_catalog\` tool; to orchestrate multi-step agent workflows use the \`orchestrate\` tool.`,
    parameters: Type.Object({
      task: Type.String({
        description:
          "The complete task description for the subagent to perform",
      }),
      agent: Type.Optional(
        Type.String({
          description:
            'Optional: name of a defined agent (from subagent_catalog, e.g. "scout") whose role to run under — applies its system prompt, tools, skills, model, and extensions over the base mode. Not supported with lite=true. Omit for a bare subagent (no role overlay).',
        }),
      ),
      lite: Type.Boolean({
        description:
          "If true, run in lite mode: no extensions, restricted tools (read,bash,grep,find,ls), thinking off. If false (default), run in full mode with extensions and the default toolset/thinking/model. If the task needs any tool not in the lite set (e.g. web fetch/search, browser, context7), use lite=false. Not supported with `agent` — use lite=false when spawning a named agent.",
        default: false,
      }),
    }),
    execute: async (callId, args, _signal, _onUpdate, ctx) => {
      widgetCtx = ctx;
      const lite = args.lite ?? false;
      // Resolve optional named-agent overlay. Same path /sub <agent> and chain
      // steps use: discoverAgents("both") → agentConfigFlags emits the agent's
      // tools/skills/extensions/model, spawnAgent writes its systemPrompt to a
      // temp file via --append-system-prompt. Lite + agent is hard-blocked: an
      // agent's extensions would be emitted as explicit -e, bypassing lite's
      // --no-extensions sandbox (mirrors the /sublite named-agent block).
      let agentConfig: AgentConfig | undefined;
      if (args.agent) {
        if (lite) {
          return {
            content: [
              {
                type: "text",
                text: `Error: named agent "${args.agent}" can't be used in lite mode (an agent may require extensions/skills that lite restricts). Spawn with lite=false instead, or use orchestrate for multi-step lite chains if you really need that combination.`,
              },
            ],
          };
        }
        const found = discoverAgents(ctx.cwd, "both").agents.find(
          (a) => a.name === args.agent,
        );
        if (!found) {
          return {
            content: [
              {
                type: "text",
                text: `Error: no named agent "${args.agent}". Call subagent_catalog to list available agents.`,
              },
            ],
          };
        }
        agentConfig = found;
      }
      const id = nextId++;
      const wt = maybeCreateWorktree(ctx, "pi-sub", id);
      const runDir = createRunDir(id, {
        id,
        origin: "agent",
        agent: agentConfig?.name,
        lite,
        spawnTime: Date.now(),
        parentPid: process.pid,
      });
      const state: SubState = {
        id,
        status: "running",
        task: args.task,
        events: [],
        toolIndex: new Map(),
        elapsed: 0,
        runDir,
        sessionFile: makeSessionFile(runDir),
        turnCount: 1,
        lite,
        origin: "agent",
        worktree: wt,
      };
      agents.set(id, state);
      updateWidgets();
      // Fire-and-forget
      spawnAgent(state, args.task, ctx, lite, agentConfig, wt?.path);
      return {
        content: [
          {
            type: "text",
            text: `Subagent #${id} spawned${lite ? " (lite)" : ""}${agentConfig ? ` as agent "${agentConfig.name}"` : ""} and running in background.`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "subagent_continue",
    description:
      "Continue an existing subagent's conversation. Use this to give further instructions to a finished subagent. Returns immediately while it runs in the background; the subagent pings back with its result as a follow-up message when it finishes, so you can continue other work or stop your turn in the meantime. The subagent's original lite/full mode is preserved on continuation.\n P.S. User is able to create a subagent in background too.",
    parameters: Type.Object({
      id: Type.Number({ description: "The ID of the subagent to continue" }),
      prompt: Type.String({
        description: "The follow-up prompt or new instructions",
      }),
    }),
    execute: async (callId, args, _signal, _onUpdate, ctx) => {
      widgetCtx = ctx;
      const state = agents.get(args.id);
      if (!state) {
        return {
          content: [
            { type: "text", text: `Error: No subagent #${args.id} found.` },
          ],
        };
      }
      if (state.status === "running") {
        return {
          content: [
            {
              type: "text",
              text: `Error: Subagent #${args.id} is still running.`,
            },
          ],
        };
      }
      // New turn: drop the in-memory event log (full history kept on disk in
      // the session file). Preserves lite/full mode from the original spawn.
      // B3: resume in the persisted worktree (state.worktree?.path), not the
      // shared tree — §12's headline rationale.
      // B4: if this is a chain-step SubState (chainId set), DETACH it so the close
      // handler emits a normal subagent-result follow-up (otherwise it routes
      // to the dead onChainStepClose→finalizeChain no-op for an already-terminal
      // chain, and the result is silently lost). The chain's own follow-up was
      // already emitted when it finalized; a /subcont continuation is a fresh
      // standalone turn on that step's session. B3: a chain step's worktree lives
      // on the ChainState (shared across steps), not on the SubState — adopt it
      // onto the step before detaching so the continuation runs in-tree. Only
      // adopt if the dir still exists: a clean-finalized chain's worktree is
      // removed on finalize (edits are on the branch), so /subcont then falls
      // back to the main repo. A dirty-finalized chain's tree is kept →
      // /subcont resumes in it (the persisted-tree case).
      if (state.chainId !== undefined) {
        const ch = chains.get(state.chainId);
        if (ch?.worktree && fs.existsSync(ch.worktree.path) && !state.worktree)
          state.worktree = ch.worktree;
        ch.worktree = undefined; // R3 (7.3): transfer ownership — the chain is
        // terminal; nulling ch.worktree prevents /subrm C1, /subclear, or
        // session_start from force-removing the dir this continuation runs in.
      }
      state.chainId = undefined;
      state.status = "running";
      state.task = args.prompt;
      state.events = [];
      state.toolIndex = new Map();
      state.elapsed = 0;
      state.turnCount++;
      updateWidgets();
      ctx.ui.notify(
        `Continuing Subagent #${args.id} (Turn ${state.turnCount})${state.lite ? " (lite)" : ""}…`,
        "info",
      );
      spawnAgent(state, args.prompt, ctx, state.lite, undefined, state.worktree?.path);
      return {
        content: [
          {
            type: "text",
            text: `Subagent #${args.id} continuing conversation in background.`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "subagent_remove",
    description:
      "Remove a subagent (`#N` or bare `N`) or a whole chain (`CN`). Kills the running step if active. `CN` removes the entire chain (one aborted summary). `#N` belonging to a still-running chain is guarded — remove the whole chain via its `C` id instead.",
    parameters: Type.Object({
      id: Type.Union(
        [Type.Number(), Type.String()],
        {
          description: "Target id: a subagent `#N` (or bare `N`), or a chain `CN`.",
        },
      ),
    }),
    execute: async (callId, args, _signal, _onUpdate, ctx) => {
      widgetCtx = ctx;
      const res = removeTarget(ctx, args.id);
      return {
        content: [
          { type: "text", text: res.isError ? `Error: ${res.msg}` : res.msg },
        ],
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    description:
      "List all active and finished subagents (IDs, tasks, mode, status) and running chains (C-id, step progress).",
    parameters: Type.Object({}),
    execute: async (_callId, _args, _signal, _onUpdate, ctx) => {
      return { content: [{ type: "text", text: buildList(ctx) }] };
    },
  });

  pi.registerTool({
    name: "subagent_inspect",
    description:
      "Return a plain-text transcript of a subagent's run (the prompt it received + the assistant text + tool calls with args/results) so the agent can review how a subagent got its result. `#N` (or bare `N`) for one subagent; `CN` for all steps of a chain concatenated; `CN@step` for one step. The /subinspect COMMAND opens the live TUI panel for the user instead; this tool is text-only and works in any mode.",
    parameters: Type.Object({
      id: Type.Union(
        [Type.Number(), Type.String()],
        {
          description: "Target id: a subagent `#N` (or bare `N`), a chain `CN`, or a step `CN@step`.",
        },
      ),
    }),
    execute: async (_callId, args, _signal, _onUpdate, ctx) => {
      widgetCtx = ctx;
      const target = parseTargetId(args.id);
      if (target.kind === "invalid") {
        return { content: [{ type: "text", text: `Error: ${target.reason}` }] };
      }
      if (target.kind === "chain") {
        const chain = chains.get(target.chainId);
        if (!chain) {
          return { content: [{ type: "text", text: `Error: No chain C${target.chainId} found.` }] };
        }
        // CN@step → one step's transcript; CN → all steps concatenated.
        if (target.step !== undefined) {
          const sid = chain.subagentIds[target.step - 1];
          const st = sid !== undefined ? agents.get(sid) : undefined;
          if (!st) {
            return { content: [{ type: "text", text: `Error: Step C${target.chainId}@${target.step} has no subagent record.` }] };
          }
          return { content: [{ type: "text", text: transcriptText(st) }] };
        }
        if (chain.steps.length === 0 || chain.subagentIds.length === 0) {
          return { content: [{ type: "text", text: `Chain C${chain.id} has no spawned steps.` }] };
        }
        const parts: string[] = [
          `chain C${chain.id} "${chain.name}" [${chain.status}] · ${chain.subagentIds.length}/${chain.steps.length} steps${chain.aborted ? " · aborted" : ""}`,
          "",
        ];
        for (let i = 0; i < chain.subagentIds.length; i++) {
          const sid = chain.subagentIds[i];
          const st = agents.get(sid);
          parts.push(`━━━ step ${i + 1}/${chain.steps.length}: ${chain.steps[i].agent} (#${sid}) ━━━`);
          parts.push(st ? transcriptText(st) : "(no subagent record)");
          parts.push("");
        }
        return { content: [{ type: "text", text: parts.join("\n") }] };
      }
      const id = target.id;
      const state = agents.get(id);
      if (!state) {
        return { content: [{ type: "text", text: `Error: No subagent #${id} found.` }] };
      }
      return { content: [{ type: "text", text: transcriptText(state) }] };
    },
  });

  // ── subagent_catalog (orchestration discovery, spec §5.3) ───────────
  pi.registerTool({
    name: "subagent_catalog",
    description:
      "Discover named agents (~/.pi/agent/agents/*.md) AND chain templates (~/.pi/agent/chains/*.yaml). Returns each agent's name + one-line description, and each chain's name + description + agent sequence. Read fresh on every call (edits take effect immediately). Call this before orchestrating multi-agent workflows so you know which named agents and chains exist. Does NOT return system prompts, tools, or step task text.",
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union(
          [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
          {
            description:
              'Which directories to search (agents + chains). "user" = ~/.pi/agent/ only (default). "project" = nearest .pi/ only. "both" = user + project (project overrides same-name).',
          },
        ),
      ),
    }),
    execute: async (_callId, args, _signal, _onUpdate, ctx) => {
      const requested = (args.scope ?? "user") as "user" | "project" | "both";
      // R5 (8.2/6.4): gate project scope before discovery — listing ≠ running,
      // but project agent/chain names+descriptions are repo-controlled metadata
      // that shouldn't surface to the model without the user's trust confirm.
      // Gate is repo-scoped (covers both agents + chains in one prompt); non-TUI
      // programmatic calls collapse to "user" (deny by default).
      const scope = await gateProjectScope(ctx, requested);
      const { agents } = discoverAgents(ctx.cwd, scope);
      const { chains } = discoverChains(ctx.cwd, scope);
      const sections: string[] = [];
      if (agents.length > 0) {
        sections.push(
          `## Agents (${scope})\n${agents
            .map((a) => `- ${a.name} (${a.source}): ${a.description}`)
            .join("\n")}`,
        );
      }
      if (chains.length > 0) {
        sections.push(
          `## Chains (${scope})\n${chains
            .map(
              (c) =>
                `- ${c.name} (${c.source}): ${c.description} [${c.steps
                  .map((s) => s.agent)
                  .join(" → ")}]`,
            )
            .join("\n")}`,
        );
      }
      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No agents or chains found (scope: ${scope}). Define agents as markdown files under ~/.pi/agent/agents/ (frontmatter: name + description required; optional: tools, disallowedTools, model, extensions, skills; body = system prompt), and chains as YAML under ~/.pi/agent/chains/ (frontmatter: name + description + steps:[{agent,task}]).`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
      };
    },
  });

  // ── subagent_build (agent authoring, spec §5.4) ─────────────────────
  // Build (or overwrite) a named agent file at ~/.pi/agent/agents/<name>.md.
  // Lets the orchestrating model scaffold a reusable agent when the user asks,
  // instead of hand-writing the file via raw `write`. Writing a file is inert
  // until a trusted user run EXECUTES it — so this needs no trust gate (project
  // execution gates already cover the threat; building ≠ spawning, so there's
  // no recursion vector either — and subagent-widget is excluded from children
  // by DEFAULT_DISALLOWED_EXT, so a subagent can't reach this tool anyway).
  // Self-verifies: re-discovers the written file + confirms the round-trip.
  pi.registerTool({
    name: "subagent_build",
    description:
      "Write (or overwrite with force) a named agent definition to ~/.pi/agent/agents/<name>.md so it becomes discoverable via subagent_catalog and spawnable via /sub <name> or as a chain step. Use this when the user asks to build/create/make a new agent. Validated: name must match ^[a-z0-9][a-z0-9-]*$ (lowercase, hyphens, alphanumerics). Required: name, description, systemPrompt (the body — the agent's role/prompt). Optional overlay fields: tools (allowlist), disallowedTools (denylist), model, extensions (additive -e), skills (additive --skill), worktree (force git isolation). After writing, verifies the file parses + is discoverable.",
    parameters: Type.Object({
      name: Type.String({
        description: "Agent name. Must match ^[a-z0-9][a-z0-9-]*$ (lowercase, hyphens, alphanumerics; e.g. 'scout', 'api-reviewer'). Becomes the filename `<name>.md`.",
      }),
      description: Type.String({
        description: "One-line description shown in subagent_catalog + /subchain picker. Keep it short + specific.",
      }),
      systemPrompt: Type.String({
        description: "The agent's system prompt (body of the .md file). Define the role, mindset, constraints. Multi-line is fine.",
      }),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional tool allowlist → --tools (e.g. ['read','grep','ls']). When omitted, the mode's default toolset applies.",
        }),
      ),
      disallowedTools: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional tool denylist → --exclude-tools (applied after `tools` allowlist).",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Optional model override (supports provider/id:thinking form, e.g. 'neuralwatt/glm-5.2-short').",
        }),
      ),
      extensions: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional additive extensions → -e (e.g. ['npm:pi-neuralwatt-provider']). Never drops the neuralwatt provider; can't re-load subagent-widget (recursion guard).",
        }),
      ),
      skills: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional additive skills → --skill (paths or names).",
        }),
      ),
      worktree: Type.Optional(
        Type.Boolean({
          description: "If true, force git-worktree isolation for this agent even when config worktree is 'off'. Applies to chain steps (standalone spawns are anonymous).",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Overwrite if an agent with this name already exists. Default false (refuse + report the existing agent's description).",
        }),
      ),
    }),
    execute: async (_callId, args, _signal, _onUpdate, ctx) => {
      const name = (args.name ?? "").trim();
      const description = (args.description ?? "").trim();
      const systemPrompt = args.systemPrompt ?? "";
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        return { content: [{ type: "text", text: `Error: name "${name || "(empty)"}" is invalid. Must match ^[a-z0-9][a-z0-9-]*$ (lowercase, hyphens, alphanumerics; must start alnum).` }] };
      }
      if (!description) return { content: [{ type: "text", text: "Error: description is required (one-line, shown in catalog)." }] };
      if (!systemPrompt.trim()) return { content: [{ type: "text", text: "Error: systemPrompt is required (the agent's role/prompt)." }] };

      const agentDir = path.join(getAgentDir(), "agents");
      const filePath = path.join(agentDir, `${name}.md`);

      // Overwrite safety: refuse unless force opt-in (mirrors /subrm's force
      // pattern — neither silent clobber nor a forced re-prompt).
      if (fs.existsSync(filePath)) {
        if (!args.force) {
          const existing = discoverAgents(ctx.cwd, "user").agents.find((a) => a.name === name);
          return { content: [{ type: "text", text: `Error: agent "${name}" already exists at ${filePath}.${existing ? ` Description: "${existing.description}".` : ""} Pass force: true to overwrite.` }] };
        }
      }

      // Build frontmatter — only emit provided fields. List fields comma-
      // separated (matches parseListField + the scout.md canonical form).
      const fm: string[] = [`name: ${name}`, `description: ${description}`];
      if (args.tools?.length) fm.push(`tools: ${args.tools.join(", ")}`);
      if (args.disallowedTools?.length) fm.push(`disallowedTools: ${args.disallowedTools.join(", ")}`);
      if (args.model) fm.push(`model: ${args.model}`);
      if (args.extensions?.length) fm.push(`extensions: ${args.extensions.join(", ")}`);
      if (args.skills?.length) fm.push(`skills: ${args.skills.join(", ")}`);
      if (args.worktree) fm.push(`worktree: true`);
      const body = `---\n${fm.join("\n")}\n---\n${systemPrompt.replace(/\n$/, "")}\n`;

      try {
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(filePath, body, { encoding: "utf-8", mode: 0o600 });
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error writing ${filePath}: ${err?.message ?? err}` }] };
      }

      // Self-verify: re-discover + confirm the file parses + round-trips.
      const verified = discoverAgents(ctx.cwd, "user").agents.find((a) => a.name === name);
      if (!verified) {
        return { content: [{ type: "text", text: `Error: wrote ${filePath} but it did NOT parse / was not discovered. Check the frontmatter syntax.` }] };
      }
      const overlay: string[] = [];
      if (verified.tools?.length) overlay.push(`tools=[${verified.tools.join(",")}]`);
      if (verified.disallowedTools?.length) overlay.push(`disallowedTools=[${verified.disallowedTools.join(",")}]`);
      if (verified.model) overlay.push(`model=${verified.model}`);
      if (verified.extensions?.length) overlay.push(`extensions=[${verified.extensions.join(",")}]`);
      if (verified.skills?.length) overlay.push(`skills=[${verified.skills.join(",")}]`);
      if (verified.worktree) overlay.push(`worktree=true`);
      return { content: [{ type: "text", text: `✓ Agent "${name}" ${fs.existsSync(filePath) && args.force ? "(overwrote)" : ""}written to ${filePath}.\nDiscoverable via subagent_catalog; spawn via /sub ${name} <task> or as a chain step (agent: ${name}).\nParsed back as: description="${verified.description}"${overlay.length ? " · " + overlay.join(" ") : ""}.` }] };
    },
  });

  // ── orchestrate tool (orchestration, spec §5.2 — Mode 2 LLM trigger) ──
  pi.registerTool({
    name: "orchestrate",
    description:
      "Run a multi-agent chain in the background (auto-advance, fire-and-forget). The final result is delivered as a follow-up message when the chain completes or halts, so you can continue other work or stop your turn in the meantime. Pass exactly one of: `template` (named chain from ~/.pi/agent/chains/), `steps` (inline LLM-authored step list referencing named agents), or `chains` (run multiple). `template` wins over `steps` if both set. Agents & templates are discoverable via the `subagent_catalog` tool — call it before authoring `steps` or using `template`.",
    parameters: Type.Object({
      template: Type.Optional(
        Type.String({
          description: "Name of a chain template to resolve from ~/.pi/agent/chains/ (or project .pi/chains/).",
        }),
      ),
      steps: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String({
              description: "Name of a defined agent (reference only — discovered via subagent_catalog).",
            }),
            task: Type.String({
              description: "Task for this step. Use {previous} for the prior step's output and {input} for the chain input.",
            }),
          }),
          { description: "Inline step list (LLM-authored). Each step references a named agent." },
        ),
      ),
      chains: Type.Optional(
        Type.Array(
          Type.Object({
            template: Type.Optional(Type.String()),
            steps: Type.Optional(
              Type.Array(
                Type.Object({
                  agent: Type.String(),
                  task: Type.String(),
                }),
              ),
            ),
          }),
          { description: "Multiple chains to run (each resolves via template or steps)." },
        ),
      ),
      input: Type.Optional(
        Type.String({
          description: 'Value substituted for {input} placeholders in step tasks.',
        }),
      ),
      lite: Type.Optional(
        Type.Boolean({
          description: "If true, run every step in lite mode (no extensions, restricted tools, thinking off). Default false.",
          default: false,
        }),
      ),
    }),
    execute: async (_callId, args, _signal, _onUpdate, ctx) => {
      widgetCtx = ctx;
      const lite = args.lite ?? false;
      const input = args.input ?? "";
      const knownAgents = discoverAgents(ctx.cwd, "both").agents;
      const knownChains = discoverChains(ctx.cwd, "both").chains;
      // R5 (8.2): validation reads "both" (so a valid project agent reaches
      // spawnChain's gate, which prompts), but the "Available" error list uses
      // USER scope only — project names must not leak into the error string
      // before the gate has a chance to run/deny.
      const userAgents = discoverAgents(ctx.cwd, "user").agents;
      const userChains = discoverChains(ctx.cwd, "user").chains;
      const agentNames = (s: string) => knownAgents.find((a) => a.name === s);
      const availableAgents =
        userAgents.map((a) => a.name).join(", ") || "none";

      // Resolve ONE inline (template|steps) spec → validated ChainStepDef[].
      const resolveSpec = (
        c: { template?: string; steps?: { agent: string; task: string }[] },
      ): { name: string; steps: ChainStepDef[] } | { error: string } => {
        if (c.template) {
          const tmpl = knownChains.find((t) => t.name === c.template);
          if (!tmpl)
            return {
              error: `Unknown chain template "${c.template}". Available (user): ${userChains.map((t) => t.name).join(", ") || "none"}.`,
            };
          return { name: tmpl.name, steps: tmpl.steps };
        }
        if (c.steps && c.steps.length > 0) {
          const unknown = c.steps
            .map((s) => s.agent)
            .filter((n) => !agentNames(n));
          if (unknown.length > 0)
            return {
              error: `Unknown agent(s): ${[...new Set(unknown)].join(", ")}. Available agents: ${availableAgents}.`,
            };
          return {
            name: "inline",
            steps: c.steps.map((s) => ({ agent: s.agent, task: s.task })),
          };
        }
        return { error: "each chain needs a `template` or non-empty `steps`." };
      };

      // exactly-one precedence (spec §5.2): template > steps; chains is exclusive.
      const hasTemplate = args.template !== undefined;
      const hasSteps = args.steps !== undefined && args.steps.length > 0;
      const hasChains = args.chains !== undefined && args.chains.length > 0;
      if (hasChains && (hasTemplate || hasSteps)) {
        return {
          content: [{ type: "text", text: "Error: cannot combine `chains` with `template`/`steps`. Pick one mode." }],
        };
      }

      // M7: two-pass — validate ALL chains first, then spawn. Avoids orphans when
      // a later entry is invalid after earlier ones already started running.
      const ids: number[] = [];
      if (hasChains) {
        const resolved: { name: string; steps: ChainStepDef[] }[] = [];
        for (const c of args.chains!) {
          const r = resolveSpec(c);
          if ("error" in r)
            return { content: [{ type: "text", text: `Error: ${r.error}` }] };
          resolved.push(r);
        }
        for (const r of resolved) ids.push(await spawnChain(r.name, r.steps, input, lite, ctx));
      } else if (hasTemplate || hasSteps) {
        const r = resolveSpec({ template: args.template, steps: args.steps });
        if ("error" in r)
          return { content: [{ type: "text", text: `Error: ${r.error}` }] };
        ids.push(await spawnChain(r.name, r.steps, input, lite, ctx));
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Error: provide exactly one of `template`, `steps`, or `chains`.",
            },
          ],
        };
      }

      const lines = ids.map((cid) => {
        const ch = chains.get(cid)!;
        return `Chain C${cid} "${ch.name}" spawned (${ch.steps.length} steps)${lite ? " (lite)" : ""}.`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // ── Coordinator (orchestration core, spec §7) ────────────────────
  // Thin: stored in `chains` (C-id → ChainState). Each step is an ordinary
  // SubState that renders itself; steps stack in the widget. No composite
  // session. The step→coordinator dispatch lives in spawnAgent's close handler
  // (chainId gate → onChainStepClose). Function declarations so spawnAgent
  // (defined above) can call them despite textual ordering.

  function getStepFinalText(state: SubState): string {
    return state.events
      .filter(
        (e): e is Extract<InspectorEvent, { kind: "text" }> => e.kind === "text",
      )
      .map((e) => e.text)
      .join("")
      .trim();
  }

  /** §3.1/§4.1 B1 trust gate: mirrors the stock example's confirmProjectAgents.
   *  Returns the scope the caller should actually use ("user" if project denied
   *  or non-TUI, else the requested scope). Project-local agents/chains are
   *  repo-controlled prompts with bash/file access — deny by default unless the
   *  user confirms for this repo. R5: probes BOTH agents and chains in one pass
   *  (the trust decision is repo-scoped, not kind-scoped) so a single prompt
   *  covers both, and project chains can't leak when only project agents exist. */
  async function gateProjectScope(
    ctx: any,
    requested: "user" | "project" | "both",
  ): Promise<"user" | "project" | "both"> {
    if (requested === "user") return "user";
    const aProbe = discoverAgents(ctx.cwd, requested);
    const cProbe = discoverChains(ctx.cwd, requested);
    const projDir = aProbe.projectAgentsDir ?? cProbe.projectChainsDir;
    if (!projDir) return "user"; // no project dir → nothing to gate, behaves as user
    const hasProject =
      aProbe.agents.some((x) => x.source === "project") ||
      cProbe.chains.some((x) => x.source === "project");
    if (!hasProject) return requested; // trust gate only fires when project results exist
    if (!ctx.hasUI) return "user"; // non-TUI: deny silently (no way to confirm)
    const ok = await ctx.ui.confirm(
      `Run project-local agents/chains?`,
      `Source: ${projDir}\n\nProject agents/chains are repo-controlled prompts that can instruct bash/file access. Only continue for trusted repositories.`,
    );
    return ok ? requested : "user";
  }

  function resolveAgent(name: string, ctx: any): AgentConfig | undefined {
    // resolveAgent is sync (called from spawnStep); project-scope trust is gated
    // at the chain-spawn entry points (spawnChain/orchestrate/subchain) via
    // gateProjectScope BEFORE reaching here. User agents always resolve here.
    // (A project agent that was gated out simply won't be found → failChain.)
    const { agents: discovered } = discoverAgents(ctx.cwd, "both");
    return discovered.find((a) => a.name === name);
  }

  /** §12 worktree resolver. Creates a worktree when isolation is on (config
   *  `worktree: "always"`, or the agent-def sets `worktree: true`) AND the cwd is
   *  a git repo. Returns null → shared-tree fallback (never blocks spawn). */
  function maybeCreateWorktree(
    ctx: any,
    prefix: string,
    id: number,
    force?: boolean,
  ): Worktree | undefined {
    const repoRoot = gitRepoRoot(ctx.cwd ?? process.cwd());
    if (!repoRoot || !isGitRepo(ctx.cwd ?? process.cwd())) return undefined;
    const mode = loadWorktreeMode();
    if (mode !== "always" && !force) return undefined;
    return createWorktree(repoRoot, prefix, id) ?? undefined;
  }

  /** Cleanup helper: remove a worktree dir (keep branch). Called from finalize /
   *  /subrm / removeChain / session_start for standalone subagents + chains. */
  function cleanupWorktree(wt: Worktree | undefined, force = false) {
    if (wt) removeWorktree(wt, force);
  }

  async function spawnChain(
    name: string,
    steps: ChainStepDef[],
    input: string,
    lite: boolean,
    ctx: any,
  ): Promise<number> {
    // B1: if any referenced agent resolves to a project-scope source, gate it
    // behind an interactive confirm (mirror confirmProjectAgents). Denied → fail
    // fast with a clear error rather than spawn a chain that can't resolve steps.
    const scope = await gateProjectScope(ctx, "both");
    if (scope === "user") {
      const projNames = steps
        .map((s) => s.agent)
        .filter((n) =>
          discoverAgents(ctx.cwd, "both").agents.find(
            (a) => a.name === n && a.source === "project",
          ),
        );
      if (projNames.length > 0) {
        // Gated out: synthesize a chain that fails at step 0 with a clear msg.
        const id = nextChainId++;
        const chain: ChainState = {
          id,
          name,
          steps,
          input,
          currentIndex: -1,
          status: "error",
          lite,
          aborted: false,
          subagentIds: [],
        };
        chains.set(id, chain);
        pi.sendMessage(
          {
            customType: "chain-result",
            content: `Chain C${id} "${name}" not started: project-local agent(s) ${projNames.join(", ")} not approved. Use scope=user only, or approve the project repo.`,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        return id;
      }
    }
    const id = nextChainId++;
    const chain: ChainState = {
      id,
      name,
      steps,
      input,
      currentIndex: -1,
      status: "running",
      lite,
      aborted: false,
      subagentIds: [],
    };
    // §12: ONE worktree shared across the chain's linear steps (a worker step
    // sees the planner step's edits). Created here so all steps share it.
    // M4: per-agent worktree:true override forces isolation even when config off.
    const forceWorktree = steps.some((s) =>
      discoverAgents(ctx.cwd, "both").agents.find(
        (a) => a.name === s.agent && a.worktree,
      ),
    );
    chain.worktree = maybeCreateWorktree(ctx, "pi-chain-C", id, forceWorktree);
    chains.set(id, chain);
    spawnStep(chain, 0, ctx);
    return id;
  }

  function spawnStep(chain: ChainState, i: number, ctx: any) {
    if (chain.aborted) return; // Q19 guard
    if (i >= chain.steps.length) return; // defensive — finalize handled on close
    chain.currentIndex = i;
    const step = chain.steps[i];
    const agent = resolveAgent(step.agent, ctx);
    if (!agent) {
      // 8.5: include the Available (user) list so the LLM can self-correct —
      // validated against user scope only (project names don't leak pre-gate).
      const avail =
        discoverAgents(ctx.cwd, "user").agents.map((a) => a.name).join(", ") ||
        "none";
      failChain(chain, `Unknown agent "${step.agent}". Available (user): ${avail}.`);
      return;
    }
    let task = step.task;
    if (i > 0) {
      const prevId = chain.subagentIds[i - 1];
      const prevStep = prevId !== undefined ? agents.get(prevId) : undefined;
      const prevFinal = prevStep ? getStepFinalText(prevStep) : "";
      const prevAgentName = chain.steps[i - 1].agent;
      // B (role fact): chain position lives in the system prompt (chainContext,
      // above) — so the handoff envelope must NOT also label the recipient's
      // position (it caused a contradiction: recipient's system prompt said
      // "step 2", envelope said "step 2", but the envelope is ABOUT the source).
      // Label the SOURCE step (the previous agent whose output this is),
      // matching "{prevAgentName}" in the line above.
      const handoff = `[Handoff from agent: ${prevAgentName}]
[Source: step ${i} of ${chain.steps.length} in chain "${chain.name}"]\n\n${prevFinal}`;
      // Explicit {previous} token → substitute in place (template chains).
      // Absent token (common in inline /subchain composition: `agent "respond" |
      // agent "echo it"`) → auto-prepend the handoff so the step both knows it's
      // in a chain AND receives the prior output. Without this, replaceAll is a
      // no-op and the step gets the bare task with zero prior context.
      if (task.includes("{previous}")) {
        task = task.replaceAll("{previous}", handoff);
      } else {
        task = `${handoff}\n\n${task}`;
      }
    }
    task = task.replaceAll("{input}", chain.input);
    const id = nextId++;
    const stepAgent = agent.name;
    const runDir = createRunDir(id, {
      id,
      origin: "agent",
      agent: stepAgent,
      lite: chain.lite,
      spawnTime: Date.now(),
      parentPid: process.pid,
    });
    const stepState: SubState = {
      id,
      status: "running",
      task,
      events: [],
      toolIndex: new Map(),
      elapsed: 0,
      runDir,
      sessionFile: makeSessionFile(runDir),
      turnCount: 1,
      lite: chain.lite,
      origin: "agent",
      chainId: chain.id,
    };
    agents.set(id, stepState);
    chain.subagentIds.push(id);
    updateWidgets();
    const prevAgent = i > 0 ? chain.steps[i - 1].agent : undefined;
    const nextAgent =
      i + 1 < chain.steps.length ? chain.steps[i + 1].agent : undefined;
    const chainContext =
      `[Chain context — your role in this run]\n` +
      `You are step ${i + 1} of ${chain.steps.length} in chain "${chain.name}".\n` +
      `Previous agent: ${prevAgent ?? "none — you are the first step"}.\n` +
      `Next agent: ${nextAgent ?? "none — you are the final step"}.`;
    spawnAgent(
      stepState,
      task,
      ctx,
      chain.lite,
      agent,
      chain.worktree?.path,
      chainContext,
    );
  }

  function onChainStepClose(state: SubState, ctx: any) {
    const chain =
      state.chainId !== undefined ? chains.get(state.chainId) : undefined;
    if (!chain) return; // chain already cleared (removed / session reset)
    if (chain.aborted) return; // Q19: abortChain already emitted the summary
    // M5: a step closing on an already-terminal chain (done/error/aborted) must
    // NOT re-enter the advance/finalize path. This happens when a step is
    // /subcont'd after finalize (B4 detaches chainId first, but guard anyway in
    // case a stale step slips through) — without this, finalizeChain's
    // early-return swallows the step's result silently (drop on the floor).
    if (chain.status !== "running") return;
    if (state.status === "error") {
      const toolErr = state.events
        .filter(
          (e): e is Extract<InspectorEvent, { kind: "tool" }> =>
            e.kind === "tool" && e.isError,
        )
        .map((e) => e.result)
        .join("; ")
        .trim();
      const errText =
        getStepFinalText(state) ||
        toolErr ||
        `(step exited with status "${state.status}")`;
      failChain(chain, errText);
      return;
    }
    if (chain.currentIndex >= chain.steps.length - 1) {
      finalizeChain(chain);
      return;
    }
    spawnStep(chain, chain.currentIndex + 1, ctx);
  }

  function finalizeChain(chain: ChainState) {
    if (chain.status !== "running") return;
    chain.status = "done";
    const lastSid = chain.subagentIds[chain.subagentIds.length - 1];
    const lastState = lastSid !== undefined ? agents.get(lastSid) : undefined;
    const finalText = lastState ? getStepFinalText(lastState) : "(no output)";
    // 8.6: per-step summary WITH tool counts (spec §7.2 format).
    const perStepWithTools = chain.subagentIds
      .map((sid, idx) => {
        const s = agents.get(sid);
        const secs = s ? Math.round(s.elapsed / 1000) : 0;
        const tools = s ? s.events.filter((e) => e.kind === "tool").length : 0;
        return `${chain.steps[idx]?.agent ?? "?"} ${s?.status === "done" ? "✓" : "✗"} (${secs}s, ${tools} tool${tools === 1 ? "" : "s"})`;
      })
      .join(", ");
    const lastAgent = chain.steps[chain.steps.length - 1]?.agent ?? "?";
    pi.sendMessage(
      {
        customType: "chain-result",
        content: `Chain C${chain.id} "${chain.name}" complete (${chain.steps.length}/${chain.steps.length} steps).\nFinal result (${lastAgent}):\n${spillResult(finalText, lastState?.runDir ?? runDirPath(chain.subagentIds[chain.subagentIds.length - 1] ?? -1))}\n${perStepWithTools}.${chain.worktree ? `\nWorktree: ${chain.worktree.path} (branch ${chain.worktree.branch}).` : ""}`,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    // §12: a completed chain released its branch — remove the dir (keep branch).
    // Dirty trees are kept (the worker's uncommitted edits survive for merge).
    cleanupWorktree(chain.worktree);
    // The step's close handler ran updateWidgets() BEFORE the coordinator
    // flipped the chain to terminal — so the chain header would otherwise
    // freeze on ⏳. Refresh so the box now reads ✓/✗/⊘.
    updateWidgets();
  }

  function failChain(chain: ChainState, errorText: string) {
    if (chain.status !== "running") return; // already terminal
    chain.status = "error";
    const i = chain.currentIndex;
    const failedAgent = chain.steps[i]?.agent ?? "?";
    const doneNames = chain.subagentIds
      .map((sid, idx) =>
        idx < i && agents.get(sid)?.status === "done"
          ? `${chain.steps[idx]?.agent ?? "?"} ✓`
          : null,
      )
      .filter(Boolean)
      .join(", ");
    const failedSid = chain.subagentIds[i];
    pi.sendMessage(
      {
        customType: "chain-result",
        content: `Chain C${chain.id} "${chain.name}" failed at step ${i + 1} (${failedAgent}): ${errorText}${doneNames ? `\nCompleted: ${doneNames}.` : ""}${failedSid !== undefined ? `\nSteps persist for inspection (/subinspect #${failedSid}).` : ""}${chain.worktree ? `\nWorktree: ${chain.worktree.path} (branch ${chain.worktree.branch}).` : ""}`,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    cleanupWorktree(chain.worktree); // §12: failed chain removes its worktree dir too
    updateWidgets(); // flip header from ⏳ to ✗ (see finalizeChain for why)
  }

  function abortChain(chain: ChainState, force = false) {
    if (chain.status !== "running") return;
    chain.aborted = true; // Q19: set BEFORE killing so the close handler won't advance
    chain.status = "aborted";
    for (const sid of chain.subagentIds) {
      const s = agents.get(sid);
      if (s?.proc && s.status === "running") terminateProcessGroup(s.proc);
    }
    const doneNames = chain.subagentIds
      .map((sid, idx) =>
        agents.get(sid)?.status === "done"
          ? `${chain.steps[idx]?.agent ?? "?"} ✓`
          : null,
      )
      .filter(Boolean)
      .join(", ");
    const haltAgent =
      chain.currentIndex >= 0 ? chain.steps[chain.currentIndex]?.agent : undefined;
    pi.sendMessage(
      {
        customType: "chain-result",
        content: `Chain C${chain.id} "${chain.name}" aborted.${doneNames ? ` Completed: ${doneNames}.` : ""}${haltAgent ? ` Halted at: ${haltAgent}.` : ""}`,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    cleanupWorktree(chain.worktree, force); // §12: aborted chain removes its worktree dir
    updateWidgets(); // flip header from ⏳ to ⊘ (see finalizeChain for why)
  }

  // Remove a whole chain: abort (one summary) + prune its step SubStates +
  // sessions/widgets + delete the chain (spec §16).
  function removeChain(chain: ChainState, ctx: any) {
    abortChain(chain, true);
    // §12: force-clean the worktree AFTER abortChain. abortChain early-returns
    // (skipping its own cleanup) when the chain is already terminal (done/error),
    // so explicit removal must not depend on chain status. Idempotent if abort already cleaned.
    cleanupWorktree(chain.worktree, true);
    for (const sid of chain.subagentIds) {
      ctx.ui.setWidget(`sub-${sid}`, undefined);
      const s = agents.get(sid);
      if (s) removeRunDir(s.runDir);
      agents.delete(sid);
    }
    ctx.ui.setWidget(`chain-${chain.id}`, undefined);
    chains.delete(chain.id);
  }

  /** Shared remove logic for the `subagent_remove` tool + `/subrm` command
   *  (spec §5.1/§6.2/§8.2). Accepts `#N`/`N` (subagent), `CN` (whole chain), or
   *  `CN@step` (one step, only if the chain is done — guarded if live). Returns a
   *  status message; caller picks notify-vs-text by isError. */
  function removeTarget(
    ctx: any,
    raw: string | number,
  ): { msg: string; isError: boolean } {
    const target = parseTargetId(raw);
    if (target.kind === "invalid")
      return { msg: target.reason, isError: true };
    if (target.kind === "chain") {
      const chain = chains.get(target.chainId);
      if (!chain)
        return { msg: `No chain C${target.chainId} found.`, isError: true };
      if (target.step !== undefined) {
        if (chain.status === "running")
          return {
            msg: `Step C${target.chainId}@${target.step} is in a live chain — remove the whole chain via C${target.chainId} instead.`,
            isError: true,
          };
        const sid = chain.subagentIds[target.step - 1];
        if (sid === undefined)
          return { msg: `Chain C${target.chainId} has no step ${target.step}.`, isError: true };
        const s = agents.get(sid);
        if (s) {
          ctx.ui.setWidget(`sub-${sid}`, undefined);
          removeRunDir(s.runDir);
          agents.delete(sid);
        }
        updateWidgets(); // refresh the chain box so the removed step row disappears
        return { msg: `Step C${target.chainId}@${target.step} removed.`, isError: false };
      }
      const n = chain.subagentIds.length;
      removeChain(chain, ctx);
      return { msg: `Chain C${target.chainId} removed (${n} steps pruned).`, isError: false };
    }
    const id = target.id;
    const state = agents.get(id);
    if (!state) return { msg: `No subagent #${id} found.`, isError: true };
    if (state.chainId !== undefined) {
      const chain = chains.get(state.chainId);
      if (chain && chain.status === "running")
        return {
          msg: `Subagent #${id} is a step of live chain C${state.chainId} — remove the whole chain via C${state.chainId} instead.`,
          isError: true,
        };
    }
    const wasRunning = !!(state.proc && state.status === "running");
    if (wasRunning) terminateProcessGroup(state.proc);
    ctx.ui.setWidget(`sub-${id}`, undefined);
    removeRunDir(state.runDir);
    cleanupWorktree(state.worktree, true); // §12: explicit /subrm #N force-removes a dirty standalone tree
    agents.delete(id);
    updateWidgets(); // if this was a step of a finished chain, refresh that box
    return {
      msg: `Subagent #${id}${wasRunning ? " killed and" : ""} removed.`,
      isError: false,
    };
  }

  // Parse `/subchain agent "task" | agent "task" | …` into steps. Splits on
  // top-level | (not inside double quotes); each segment: name + quoted task.
  function parseCliCompose(
    input: string,
  ): ChainStepDef[] | { error: string } {
    const segments: string[] = [];
    let buf = "";
    let inQuote = false;
    for (const ch of input) {
      if (ch === '"') {
        inQuote = !inQuote;
        buf += ch;
      } else if (ch === "|" && !inQuote) {
        segments.push(buf);
        buf = "";
      } else buf += ch;
    }
    segments.push(buf);
    const steps: ChainStepDef[] = [];
    for (const seg of segments) {
      const s = seg.trim();
      if (!s) continue;
      const m = s.match(/^(\S+)\s+(.*)$/s);
      if (!m) return { error: `Bad segment "${s}". Expected: agent "task"` };
      let task = m[2].trim();
      if (task.startsWith('"') && task.endsWith('"') && task.length >= 2)
        task = task.slice(1, -1);
      if (!task) return { error: `Bad segment "${s}". Expected: agent "task"` };
      steps.push({ agent: m[1], task });
    }
    if (steps.length === 0)
      return {
        error: 'No steps. Usage: /subchain agent "task" | agent "task"',
      };
    return steps;
  }

  /** Combined subagent + chain listing, shared by the `subagent_list` tool and
   *  `/sublist` command (spec §5.1/§6.2). Extends the existing subagent rows with
   *  a `(chain Ck)` tag + a Chains section: `Ck "name" · step i/N · agent` +
   *  running/done/error icon. */
  function buildList(ctx: any): string {
    const sections: string[] = [];
    if (agents.size > 0) {
      const list = Array.from(agents.values())
        .map((s) => {
          // Q11: blocked shows "blocked: <pending-question preview>" instead of
          // the task preview; the [BLOCKED] tag + ⧗ icon both carry the state.
          if (s.status === "blocked" && s.pendingRequest) {
            const q = s.pendingRequest.question;
            const qprev = q.length > 50 ? q.slice(0, 47) + "..." : q;
            return `#${s.id} [BLOCKED]${s.lite ? " (lite)" : ""}${s.chainId !== undefined ? ` (chain C${s.chainId})` : ""} (Turn ${s.turnCount}) - ${qprev}`;
          }
          return `#${s.id} [${s.status.toUpperCase()}]${s.lite ? " (lite)" : ""}${s.chainId !== undefined ? ` (chain C${s.chainId})` : ""} (Turn ${s.turnCount}) - ${s.task.length > 60 ? s.task.slice(0, 57) + "..." : s.task}`;
        })
        .join("\n");
      sections.push(`Subagents:\n${list}`);
    }
    if (chains.size > 0) {
      const clist = Array.from(chains.values())
        .map((c) => {
          const i = c.currentIndex;
          const curAgent =
            i >= 0 && i < c.steps.length ? c.steps[i].agent : "?";
          const icon =
            c.status === "running"
              ? "⏳"
              : c.status === "done"
                ? "✓"
                : c.status === "aborted"
                  ? "⊘"
                  : "✗";
          const stepLabel =
            c.status === "done"
              ? `${c.steps.length}/${c.steps.length}`
              : `${Math.min(i + 1, c.steps.length)}/${c.steps.length}`;
          return `C${c.id} "${c.name}" ${icon} · step ${stepLabel} · ${curAgent}`;
        })
        .join("\n");
      sections.push(`Chains:\n${clist}`);
    }
    if (sections.length === 0) return "No active subagents or chains.";
    return sections.join("\n\n");
  }

  /** Chain inspector (spec §5.1/§6.2): list C-chain's steps in a picker, then
   *  drill into the chosen step's existing per-step inspector. TUI-only. */
  async function openChainInspector(
    ctx: any,
    chain: ChainState,
  ): Promise<string> {
    if ((ctx as any).mode !== "tui")
      return `Inspector requires TUI mode (current: ${(ctx as any).mode}).`;
    widgetCtx = ctx;
    if (chain.steps.length === 0 || chain.subagentIds.length === 0)
      return `Chain C${chain.id} has no spawned steps.`;
    const options = chain.steps.map((s, i) => {
      const sid = chain.subagentIds[i];
      const st = sid !== undefined ? agents.get(sid) : undefined;
      const icon = !st
        ? "○"
        : st.status === "running"
          ? "●"
          : st.status === "done"
            ? "✓"
            : st.status === "blocked"
              ? "⧗"
              : "✗";
      const task = s.task.length > 40 ? s.task.slice(0, 37) + "…" : s.task;
      return `${icon} Step ${i + 1}: ${s.agent} · ${task}`;
    });
    const choice = await ctx.ui.select(
      `Inspect which step of chain C${chain.id} (${chain.name})?`,
      options,
    );
    if (choice === undefined) return "Cancelled.";
    const idx = options.indexOf(choice);
    const sid = chain.subagentIds[idx];
    const st = sid !== undefined ? agents.get(sid) : undefined;
    if (!st)
      return `Step ${idx + 1} of C${chain.id} has no subagent record.`;
    await openInspector(ctx as any, st);
    return `Inspector closed for step C${chain.id}@${idx + 1} (#${sid}).`;
  }

  // ── /sub ───────────────────────────────────────────────────────────
  pi.registerCommand("sub", {
    description:
      "Spawn a full subagent with live widget: /sub <task> | /sub <agent> <task>. Named agent applies its tools/extensions/skills/model+system prompt.",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const raw = args?.trim();
      if (!raw) {
        ctx.ui.notify("Usage: /sub <task>  |  /sub <agent> <task>", "error");
        return;
      }
      // First-token-if-matches: if the first word is a known named agent
      // (user+project, matching subagent_catalog), treat it as the agent-def
      // and the remainder as the task. Otherwise the whole string is a bare
      // task (backward compatible). lite is blocked from named agents: an
      // agent's extensions would bypass --no-extensions via explicit -e,
      // defeating lite's sandbox (see /sublite handler).
      const sp = raw.indexOf(" ");
      const first = sp === -1 ? raw : raw.slice(0, sp);
      const known = discoverAgents(ctx.cwd, "both").agents.find(
        (a) => a.name === first,
      );
      let agentConfig: AgentConfig | undefined;
      let task = raw;
      if (known && sp !== -1) {
        agentConfig = known;
        task = raw.slice(sp + 1).trim();
        if (!task) {
          ctx.ui.notify(
            `Usage: /sub ${known.name} <task>  (agent "${known.name}" needs a task)`,
            "error",
          );
          return;
        }
      }
      const id = nextId++;
      const wt = maybeCreateWorktree(ctx, "pi-sub", id);
      const runDir = createRunDir(id, {
        id,
        origin: "user",
        agent: agentConfig?.name,
        lite: false,
        spawnTime: Date.now(),
        parentPid: process.pid,
      });
      const state: SubState = {
        id,
        status: "running",
        task,
        events: [],
        toolIndex: new Map(),
        elapsed: 0,
        runDir,
        sessionFile: makeSessionFile(runDir),
        turnCount: 1,
        lite: false,
        origin: "user",
        worktree: wt,
      };
      agents.set(id, state);
      updateWidgets();
      spawnAgent(state, task, ctx, false, agentConfig, wt?.path);
    },
  });

  // ── /sublite ─────────────────────────────────────────────────────────────
  pi.registerCommand("sublite", {
    description:
      "Spawn a lite subagent (no extensions, restricted tools, thinking off) with live widget: /sublite <task>. Named agents are not supported here.",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const raw = args?.trim();
      if (!raw) {
        ctx.ui.notify("Usage: /sublite <task>", "error");
        return;
      }
      // Hard block named-agent form: an agent's extensions would be emitted
      // as explicit -e, which bypasses --no-extensions and would re-enable
      // heavy extensions in lite. Lite subagents are bare-task only.
      const sp = raw.indexOf(" ");
      const first = sp === -1 ? raw : raw.slice(0, sp);
      if (sp !== -1 &&
        discoverAgents(ctx.cwd, "both").agents.some((a) => a.name === first)) {
        ctx.ui.notify(
          `Named agent "${first}" can't be used in lite mode (agents may require extensions/skills that lite restricts). Use /sub ${first} <task> instead.`,
          "error",
        );
        return;
      }
      const task = raw;
      const id = nextId++;
      const wt = maybeCreateWorktree(ctx, "pi-sub", id);
      const runDir = createRunDir(id, {
        id,
        origin: "user",
        lite: true,
        spawnTime: Date.now(),
        parentPid: process.pid,
      });
      const state: SubState = {
        id,
        status: "running",
        task,
        events: [],
        toolIndex: new Map(),
        elapsed: 0,
        runDir,
        sessionFile: makeSessionFile(runDir),
        turnCount: 1,
        lite: true,
        origin: "user",
        worktree: wt,
      };
      agents.set(id, state);
      updateWidgets();
      spawnAgent(state, task, ctx, true, undefined, wt?.path);
    },
  });

  // ── /subcont ────────────────────────────────────────────────────
  pi.registerCommand("subcont", {
    description:
      "Continue an existing subagent's conversation (preserving its lite/full mode): /subcont <id> <prompt>",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const trimmed = args?.trim() ?? "";
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) {
        ctx.ui.notify("Usage: /subcont <id> <prompt>", "error");
        return;
      }
      const num = parseInt(trimmed.slice(0, spaceIdx), 10);
      const prompt = trimmed.slice(spaceIdx + 1).trim();
      if (isNaN(num) || !prompt) {
        ctx.ui.notify("Usage: /subcont <id> <prompt>", "error");
        return;
      }
      const state = agents.get(num);
      if (!state) {
        ctx.ui.notify(
          `No subagent #${num} found. Use /sub or /sublite to create one.`,
          "error",
        );
        return;
      }
      if (state.status === "running") {
        ctx.ui.notify(
          `Subagent #${num} is still running — wait for it to finish first.`,
          "warning",
        );
        return;
      }
      // New turn: drop the in-memory event log (full history remains on disk).
      // B3+B4 (see subagent_continue tool): resume in state.worktree + detach
      // a chain-step SubState so a normal follow-up is emitted. B3: a chain
      // step's worktree lives on ChainState — adopt it before detaching, but
      // only if the dir still exists (clean-finalize removes it; edits are on
      // the branch). Dirty-kept trees persist → /subcont resumes in them.
      if (state.chainId !== undefined) {
        const ch = chains.get(state.chainId);
        if (ch?.worktree && fs.existsSync(ch.worktree.path) && !state.worktree)
          state.worktree = ch.worktree;
        ch.worktree = undefined; // R3 (7.3): transfer ownership — the chain is
        // terminal; nulling ch.worktree prevents /subrm C1, /subclear, or
        // session_start from force-removing the dir this continuation runs in.
      }
      state.chainId = undefined;
      state.status = "running";
      state.task = prompt;
      state.events = [];
      state.toolIndex = new Map();
      state.elapsed = 0;
      state.turnCount++;
      updateWidgets();
      ctx.ui.notify(
        `Continuing Subagent #${num} (Turn ${state.turnCount})${state.lite ? " (lite)" : ""}…`,
        "info",
      );
      spawnAgent(state, prompt, ctx, state.lite, undefined, state.worktree?.path);
    },
  });

  // ── /subrm ───────────────────────────────────────────────────────
  pi.registerCommand("subrm", {
    description:
      "Remove a subagent (#N) or whole chain (CN): /subrm <#N|CN|CN@step>",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const raw = args?.trim() ?? "";
      if (!raw) {
        ctx.ui.notify("Usage: /subrm <#N|CN|CN@step>", "error");
        return;
      }
      const res = removeTarget(ctx, raw);
      ctx.ui.notify(
        res.msg,
        res.isError
          ? "error"
          : res.msg.includes("killed")
            ? "warning"
            : "info",
      );
    },
  });

  // ── /subclear ─────────────────────────────────────────────────────────────
  pi.registerCommand("subclear", {
    description: "Clear all subagent widgets",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      let killed = 0;
      for (const [id, state] of Array.from(agents.entries())) {
        if (state.proc && state.status === "running") {
          terminateProcessGroup(state.proc);
          killed++;
        }
        ctx.ui.setWidget(`sub-${id}`, undefined);
        removeRunDir(state.runDir);
        cleanupWorktree(state.worktree); // R3: clean-only — keep dirty + warn
      }
      for (const chain of Array.from(chains.values())) {
        for (const sid of chain.subagentIds) {
          ctx.ui.setWidget(`sub-${sid}`, undefined);
        }
        ctx.ui.setWidget(`chain-${chain.id}`, undefined);
        cleanupWorktree(chain.worktree);
      }
      const total = agents.size;
      const chainTotal = chains.size;
      agents.clear();
      nextId = 1;
      chains.clear();
      nextChainId = 1;
      const all = total + chainTotal;
      const msg =
        all === 0
          ? "No subagents or chains to clear."
          : `Cleared ${total} subagent${total !== 1 ? "s" : ""}${chainTotal > 0 ? ` + ${chainTotal} chain${chainTotal !== 1 ? "s" : ""}` : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
      ctx.ui.notify(msg, all === 0 ? "info" : "success");
    },
  });

  // ── /subinspect ─────────────────────────────────────────────────────────
  pi.registerCommand("subinspect", {
    description:
      "Inspect a subagent (#N), a chain (CN → step picker), or step CN@2: /subinspect [#N|CN|CN@2]",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const arg = args?.trim() ?? "";
      if (arg) {
        const target = parseTargetId(arg);
        if (target.kind === "invalid") {
          ctx.ui.notify("Usage: /subinspect [#N|CN|CN@2]", "error");
          return;
        }
        if (target.kind === "chain") {
          const chain = chains.get(target.chainId);
          if (!chain) {
            ctx.ui.notify(`No chain C${target.chainId} found.`, "error");
            return;
          }
          if (target.step !== undefined) {
            const sid = chain.subagentIds[target.step - 1];
            const st = sid !== undefined ? agents.get(sid) : undefined;
            if (!st) {
              ctx.ui.notify(`Step C${target.chainId}@${target.step} has no subagent record.`, "error");
              return;
            }
            await openInspector(ctx as any, st);
            return;
          }
          const msg = await openChainInspector(ctx as any, chain);
          ctx.ui.notify(msg, msg.startsWith("Inspector requires") ? "error" : "info");
          return;
        }
        // #N
        const id = target.id;
        const state = agents.get(id);
        if (!state) {
          ctx.ui.notify(`No subagent #${id} found.`, "error");
          return;
        }
        await openInspector(ctx as any, state);
        return;
      }
      // no-arg picker (subagents only — chains via /subinspect C1)
      if (agents.size === 0) {
        ctx.ui.notify("No subagents to inspect. Use /sub or /sublite first.", "info");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Usage: /subinspect <id> (picker needs UI)", "info");
        return;
      }
      const options = Array.from(agents.values()).map(
        (s) =>
          `#${s.id} ${s.status === "running" ? "●" : s.status === "done" ? "✓" : s.status === "blocked" ? "⧗" : "✗"}${s.lite ? " ⚡" : ""} · ${
            s.task.length > 40 ? s.task.slice(0, 37) + "…" : s.task
          }`,
      );
      const choice = await ctx.ui.select("Inspect which subagent?", options);
      if (choice === undefined) return;
      const pickedId = parseInt(choice.slice(1), 10);
      const state = agents.get(pickedId);
      if (!state) {
        ctx.ui.notify(`No subagent #${pickedId} found.`, "error");
        return;
      }
      await openInspector(ctx as any, state);
    },
  });

  // ── /sublist (orchestration, spec §6.2) ────────────────────────────────
  pi.registerCommand("sublist", {
    description: "List all subagents (#N) and chains (Ck): /sublist",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      ctx.ui.notify(buildList(ctx), "info");
    },
  });

  // ── /subchain (orchestration, spec §6.2) ──────────────────────────────
  pi.registerCommand("subchain", {
    description:
      'Run a multi-agent chain: /subchain <template> [input]  |  /subchain agent "task" | agent "task"  |  /subchain (picker)',
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const arg = args?.trim() ?? "";
      // No args → picker of saved templates (TUI only).
      if (!arg) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            'Usage: /subchain <template> [input]  |  /subchain agent "task" | agent "task"',
            "info",
          );
          return;
        }
        const { chains: list } = discoverChains(ctx.cwd, "user");
        if (list.length === 0) {
          ctx.ui.notify(
            "No chain templates found in ~/.pi/agent/chains/*.yaml.",
            "info",
          );
          return;
        }
        const options = list.map(
          (c) =>
            `${c.name} — ${c.description} [${c.steps.map((s) => s.agent).join(" → ")}]`,
        );
        const choice = await ctx.ui.select("Run which chain?", options);
        if (choice === undefined) return;
        const idx = options.indexOf(choice);
        const tmpl = idx >= 0 ? list[idx] : undefined;
        if (!tmpl) return;
        const id = await spawnChain(tmpl.name, tmpl.steps, "", false, ctx);
        ctx.ui.notify(
          `Chain C${id} "${tmpl.name}" started (${tmpl.steps.length} steps).`,
          "info",
        );
        return;
      }
      // CLI-compose (contains a top-level |).
      if (arg.includes("|")) {
        const parsed = parseCliCompose(arg);
        if ("error" in parsed) {
          ctx.ui.notify(parsed.error, "error");
          return;
        }
        const id = await spawnChain("inline", parsed, "", false, ctx);
        ctx.ui.notify(
          `Chain C${id} (inline) started (${parsed.length} steps).`,
          "info",
        );
        return;
      }
      // Template run: /subchain <name> [input]
      const sp = arg.indexOf(" ");
      const name = sp === -1 ? arg : arg.slice(0, sp);
      let input = sp === -1 ? "" : arg.slice(sp + 1).trim();
      if (input.startsWith('"') && input.endsWith('"') && input.length >= 2)
        input = input.slice(1, -1);
      const { chains: list } = discoverChains(ctx.cwd, "user");
      const tmpl = list.find((c) => c.name === name);
      if (!tmpl) {
        ctx.ui.notify(
          `No chain template "${name}". Available: ${list.map((c) => c.name).join(", ") || "none"}.`,
          "error",
        );
        return;
      }
      const id = await spawnChain(tmpl.name, tmpl.steps, input, false, ctx);
      ctx.ui.notify(
        `Chain C${id} "${tmpl.name}" started (${tmpl.steps.length} steps).`,
        "info",
      );
    },
  });

  // ── /subchain-doctor (read-only diagnostics, spec §6.2/§9 item 9) ────────
  pi.registerCommand("subchain-doctor", {
    description:
      "Read-only diagnostics: resolved agent/chain dirs, discovery counts, sample agent, extensions survival",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      const agentRoot = getAgentDir();
      const agentDir = path.join(agentRoot, "agents");
      const chainDir = path.join(agentRoot, "chains");
      const agBoth = discoverAgents(ctx.cwd, "both");
      const chBoth = discoverChains(ctx.cwd, "both");
      const userAgents = agBoth.agents.filter((a) => a.source === "user");
      const projAgents = agBoth.agents.filter((a) => a.source === "project");
      const userChains = chBoth.chains.filter((c) => c.source === "user");
      const projChains = chBoth.chains.filter((c) => c.source === "project");
      const lines: string[] = ["Subagent-widget doctor"];
      lines.push(`Agent dir:        ${agentDir} (${userAgents.length} user)`);
      if (agBoth.projectAgentsDir)
        lines.push(`Project agent dir: ${agBoth.projectAgentsDir} (${projAgents.length} project)`);
      lines.push(`Chain dir:        ${chainDir} (${userChains.length} user)`);
      if (chBoth.projectChainsDir)
        lines.push(`Project chain dir: ${chBoth.projectChainsDir} (${projChains.length} project)`);
      const sample = agBoth.agents[0];
      if (sample) {
        lines.push(`Sample agent:     ${sample.name} — ${sample.description}`);
        const modelDisplay = !sample.model || sample.model === "default" ? "(default)" : sample.model;
        lines.push(`  tools=${sample.tools?.join(",") ?? "(default)"} model=${modelDisplay}`);
        lines.push(`  extensions=${sample.extensions?.join(",") ?? "(none additive)"} skills=${sample.skills?.join(",") ?? "(none)"} disallowedTools=${sample.disallowedTools?.join(",") ?? "(none)"}`);
      } else {
        lines.push("Sample agent:     (none defined — create *.md in the agent dir)");
      }
      const liteExts = loadLiteExtensions();
      lines.push(`Lite spawn:       --no-extensions ${liteExts.map((e) => `-e ${e}`).join(" ") || "(empty!)"}`);
      const disallow = loadDisallowedExtensions();
      const survivors = resolveFullModeExtArgs(ctx.cwd);
      if (survivors === null) {
        lines.push(`Full spawn:       discovery unrestricted (disallowedExt ${disallow.length ? `[${disallow.join(",")}] matched nothing` : "empty"})`);
      } else {
        const target = normalizeForMatch("npm:pi-neuralwatt-provider");
        const hasNeuralwatt = survivors.some((s) => normalizeForMatch(s) === target);
        lines.push(`Full spawn:       --no-extensions -e [${survivors.length} survivors] — neuralwatt ${hasNeuralwatt ? "✓ present" : "✗ MISSING"}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Session lifecycle ─────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    for (const [id, state] of Array.from(agents.entries())) {
      if (state.proc && state.status === "running") {
        terminateProcessGroup(state.proc);
      }
      ctx.ui.setWidget(`sub-${id}`, undefined);
      removeRunDir(state.runDir);
      cleanupWorktree(state.worktree); // R3: clean slate for widgets/id — but clean-only so a dirty tree is KEPT + warned, not force-destroyed (force is for /subrm)
    }
    for (const chain of Array.from(chains.values())) {
      ctx.ui.setWidget(`chain-${chain.id}`, undefined);
      cleanupWorktree(chain.worktree);
    }
    agents.clear();
    nextId = 1;
    chains.clear();
    nextChainId = 1;
    widgetCtx = ctx;
    // Q9: reap runs orphaned by a prior-session pi (crash, kill, abandoned
    // blocked). Fires at the natural lifecycle boundary (restart = new
    // session_start) so orphans are swept immediately, not "one session later".
    // Silent — a count is reported on demand via /sub doctor (step 7).
    sweepRuns();
  });
}
