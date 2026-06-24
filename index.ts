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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import type { InspectorEvent, SubState, SubagentOrigin } from "./types.ts";
import {
  appendText,
  cap,
  openInspector,
  stringifyVal,
} from "./inspector.ts";
import { deleteSessionFile, makeSessionFile } from "./session.ts";
import { loadLiteExtensions } from "./config.ts";
import { resolveFullModeExtArgs } from "./disallow.ts";
import { buildSubagentWidget } from "./widget.ts";

export default function (pi: ExtensionAPI) {
  const agents: Map<number, SubState> = new Map();
  let nextId = 1;
  let widgetCtx: any;

  // ── Widget rendering ─────────────────────────────────────────────────────
  function updateWidgets() {
    if (!widgetCtx) return;
    for (const [id, state] of Array.from(agents.entries())) {
      widgetCtx.ui.setWidget(`sub-${id}`, buildSubagentWidget(state));
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
          if (ev.kind === "tool") ev.partial = cap(stringifyVal(event.partialResult));
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
  ): Promise<void> {
    // Base args shared by both modes: default model (no --model), --session for resumption.
    const args: string[] = ["--mode", "json", "-p", "--session", state.sessionFile];

    if (lite) {
      // Lite: disable discovery, then load only the extensions listed in
      // config.json. Restricted toolset, thinking off.
      const entries = loadLiteExtensions();
      args.push("--no-extensions", "--no-skills");
      for (const e of entries) args.push("-e", e);
      args.push("--tools", "read,bash,grep,find,ls", "--thinking", "off");
    } else {
      // Full mode: let pi discover all extensions unless the disallow list
      // (config.json `disallowedExt`) actually matches — then sandbox to the
      // survivors via --no-extensions -e. No match (empty/stale list) → no
      // flags, normal discovery (criterion b, see disallow.ts).
      const extArgs = resolveFullModeExtArgs(process.cwd());
      if (extArgs) {
        args.push("--no-extensions");
        for (const e of extArgs) args.push("-e", e);
      }
    }

    args.push(prompt);

    return new Promise((resolve) => {
      const proc = spawn("pi", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      state.proc = proc;
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
        const tools = state.events.filter(
          (e) => e.kind === "tool",
        ) as Extract<InspectorEvent, { kind: "tool" }>[];
        let toolSummary = "";
        if (tools.length > 0) {
          const counts: Record<string, number> = {};
          for (const t of tools) counts[t.toolName] = (counts[t.toolName] ?? 0) + 1;
          toolSummary = `Tools called (${tools.length}): ${Object.entries(counts)
            .map(([n, c]) => `${n} ×${c}`)
            .join(", ")}\n\n`;
        }
        const textResult = state.events
          .filter((e) => e.kind === "text")
          .map((e) => (e as Extract<InspectorEvent, { kind: "text" }>).text)
          .join("")
          .trim();
        const result = toolSummary + (textResult || "(no text output)");
        ctx.ui.notify(
          `Subagent #${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
          state.status === "done" ? "success" : "error",
        );
        pi.sendMessage(
          {
            customType: "subagent-result",
            content: `Subagent #${state.id}${state.lite ? " (⚡lite)" : ""}${state.origin === "user" ? " (User Spawned)" : ""}${state.turnCount > 1 ? ` (Turn ${state.turnCount})` : ""} finished "${prompt}" in ${Math.round(state.elapsed / 1000)}s.\n\nResult:\n${result.slice(0, 8000)}${result.length > 8000 ? "\n\n... [truncated]" : ""}`,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
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
    description: `Spawn a background subagent to perform a task without disrupting the main conversation & process. Returns the subagent ID immediately while it runs in the background. Results will be delivered as a follow-up message when finished.

Modes (via the 'lite' parameter):
- lite=false (default): full subagent. Extensions enabled, unrestricted tools, default thinking level, default model. Use for complex tasks that benefit from extensions and reasoning.
- lite=true: lite subagent. Only the extensions listed in config.json (sibling of this file) load; restricted tools (read,bash,grep,find,ls), thinking off. Faster and cheaper — use for simple, well-scoped tasks that need only those tools. If the task needs any other tool (e.g. web fetch/search, browser, context7), use lite=false instead.`,
    parameters: Type.Object({
      task: Type.String({
        description: "The complete task description for the subagent to perform",
      }),
      lite: Type.Boolean({
        description:
          "If true, run in lite mode: no extensions, restricted tools (read,bash,grep,find,ls), thinking off. If false (default), run in full mode with extensions and the default toolset/thinking/model. If the task needs any tool not in the lite set (e.g. web fetch/search, browser, context7), use lite=false.",
        default: false,
      }),
    }),
    execute: async (callId, args, _signal, _onUpdate, ctx) => {
      widgetCtx = ctx;
      const lite = args.lite ?? false;
      const id = nextId++;
      const state: SubState = {
        id,
        status: "running",
        task: args.task,
        events: [],
        toolIndex: new Map(),
        elapsed: 0,
        sessionFile: makeSessionFile(id),
        turnCount: 1,
        lite,
        origin: "agent",
      };
      agents.set(id, state);
      updateWidgets();
      // Fire-and-forget
      spawnAgent(state, args.task, ctx, lite);
      return {
        content: [
          {
            type: "text",
            text: `Subagent #${id} spawned${lite ? " (lite)" : ""} and running in background.`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "subagent_continue",
    description:
      "Continue an existing subagent's conversation. Use this to give further instructions to a finished subagent. Returns immediately while it runs in the background. The subagent's original lite/full mode is preserved on continuation.",
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
      spawnAgent(state, args.prompt, ctx, state.lite);
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
      "Remove a specific subagent. Kills it if it's currently running.",
    parameters: Type.Object({
      id: Type.Number({ description: "The ID of the subagent to remove" }),
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
      if (state.proc && state.status === "running") {
        state.proc.kill("SIGTERM");
      }
      ctx.ui.setWidget(`sub-${args.id}`, undefined);
      deleteSessionFile(state);
      agents.delete(args.id);
      return {
        content: [
          { type: "text", text: `Subagent #${args.id} removed successfully.` },
        ],
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    description:
      "List all active and finished subagents, showing their IDs, tasks, mode, and status.",
    parameters: Type.Object({}),
    execute: async () => {
      if (agents.size === 0) {
        return { content: [{ type: "text", text: "No active subagents." }] };
      }
      const list = Array.from(agents.values())
        .map(
          (s) =>
            `#${s.id} [${s.status.toUpperCase()}]${s.lite ? " (lite)" : ""} (Turn ${s.turnCount}) - ${s.task}`,
        )
        .join("\n");
      return { content: [{ type: "text", text: `Subagents:\n${list}` }] };
    },
  });

  pi.registerTool({
    name: "subagent_inspect",
    description:
      "Open a read-only floating inspector that monitors a subagent's live activity for the current turn — assistant text interleaved with tool calls (name, args, capped results). Read-only; closes with q/Esc. Requires TUI mode. Use to review how a subagent got its result.",
    parameters: Type.Object({
      id: Type.Number({ description: "The subagent ID to inspect" }),
    }),
    execute: async (_callId, args, _signal, _onUpdate, ctx) => {
      const state = agents.get(args.id);
      if (!state) {
        return {
          content: [
            { type: "text", text: `Error: No subagent #${args.id} found.` },
          ],
        };
      }
      if ((ctx as any).mode !== "tui") {
        return {
          content: [
            {
              type: "text",
              text: `Inspector requires TUI mode (current: ${(ctx as any).mode}).`,
            },
          ],
        };
      }
      widgetCtx = ctx;
      await openInspector(ctx as any, state);
      return {
        content: [
          { type: "text", text: `Inspector closed for subagent #${args.id}.` },
        ],
      };
    },
  });

  // ── /sub ───────────────────────────────────────────────────────────
  pi.registerCommand("sub", {
    description:
      "Spawn a full subagent (extensions on, default tools/thinking/model) with live widget: /sub <task>",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const task = args?.trim();
      if (!task) {
        ctx.ui.notify("Usage: /sub <task>", "error");
        return;
      }
      const id = nextId++;
      const state: SubState = {
        id,
        status: "running",
        task,
        events: [],
        toolIndex: new Map(),
        elapsed: 0,
        sessionFile: makeSessionFile(id),
        turnCount: 1,
        lite: false,
        origin: "user",
      };
      agents.set(id, state);
      updateWidgets();
      spawnAgent(state, task, ctx, false);
    },
  });

  // ── /sublite ─────────────────────────────────────────────────────────────
  pi.registerCommand("sublite", {
    description:
      "Spawn a lite subagent (no extensions, restricted tools, thinking off) with live widget: /sublite <task>",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const task = args?.trim();
      if (!task) {
        ctx.ui.notify("Usage: /sublite <task>", "error");
        return;
      }
      const id = nextId++;
      const state: SubState = {
        id,
        status: "running",
        task,
        events: [],
        toolIndex: new Map(),
        elapsed: 0,
        sessionFile: makeSessionFile(id),
        turnCount: 1,
        lite: true,
        origin: "user",
      };
      agents.set(id, state);
      updateWidgets();
      spawnAgent(state, task, ctx, true);
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
      spawnAgent(state, prompt, ctx, state.lite);
    },
  });

  // ── /subrm ───────────────────────────────────────────────────────
  pi.registerCommand("subrm", {
    description: "Remove a specific subagent widget: /subrm <id>",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const num = parseInt(args?.trim() ?? "", 10);
      if (isNaN(num)) {
        ctx.ui.notify("Usage: /subrm <id>", "error");
        return;
      }
      const state = agents.get(num);
      if (!state) {
        ctx.ui.notify(`No subagent #${num} found.`, "error");
        return;
      }
      if (state.proc && state.status === "running") {
        state.proc.kill("SIGTERM");
        ctx.ui.notify(`Subagent #${num} killed and removed.`, "warning");
      } else {
        ctx.ui.notify(`Subagent #${num} removed.`, "info");
      }
      ctx.ui.setWidget(`sub-${num}`, undefined);
      deleteSessionFile(state);
      agents.delete(num);
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
          state.proc.kill("SIGTERM");
          killed++;
        }
        ctx.ui.setWidget(`sub-${id}`, undefined);
        deleteSessionFile(state);
      }
      const total = agents.size;
      agents.clear();
      nextId = 1;
      const msg =
        total === 0
          ? "No subagents to clear."
          : `Cleared ${total} subagent${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
      ctx.ui.notify(msg, total === 0 ? "info" : "success");
    },
  });

  // ── /subinspect ─────────────────────────────────────────────────────────
  pi.registerCommand("subinspect", {
    description:
      "Inspect a subagent's live activity in a floating read-only overlay: /subinspect [id]",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const arg = args?.trim() ?? "";
      let id: number | undefined;
      if (arg) {
        id = parseInt(arg, 10);
        if (isNaN(id)) {
          ctx.ui.notify("Usage: /subinspect [id]", "error");
          return;
        }
      }
      if (id === undefined) {
        if (agents.size === 0) {
          ctx.ui.notify(
            "No subagents to inspect. Use /sub or /sublite first.",
            "info",
          );
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /subinspect <id> (picker needs UI)", "info");
          return;
        }
        const options = Array.from(agents.values()).map(
          (s) =>
            `#${s.id} ${s.status === "running" ? "●" : s.status === "done" ? "✓" : "✗"}${s.lite ? " ⚡" : ""} · ${
              s.task.length > 40 ? s.task.slice(0, 37) + "…" : s.task
            }`,
        );
        const choice = await ctx.ui.select("Inspect which subagent?", options);
        if (choice === undefined) return;
        id = parseInt(choice.slice(1), 10);
      }
      const state = id !== undefined ? agents.get(id) : undefined;
      if (!state) {
        ctx.ui.notify(`No subagent #${id} found.`, "error");
        return;
      }
      await openInspector(ctx as any, state);
    },
  });

  // ── Session lifecycle ─────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    for (const [id, state] of Array.from(agents.entries())) {
      if (state.proc && state.status === "running") {
        state.proc.kill("SIGTERM");
      }
      ctx.ui.setWidget(`sub-${id}`, undefined);
      deleteSessionFile(state);
    }
    agents.clear();
    nextId = 1;
    widgetCtx = ctx;
  });
}
