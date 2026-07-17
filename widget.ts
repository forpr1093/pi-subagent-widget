// The stacked per-agent widget rendered above the editor (compact live status).
//
// Reads from SubState.events (the single source of truth shared with the
// inspector): derives tool count + last activity line. Returns the component
// factory that setWidget expects; index.ts iterates the live agents and wires
// each with buildSubagentWidget(state) / undefined.
//
// buildChainWidget renders ONE bordered box per running chain (step rows live
// inside it), so chains are visually grouped + labeled C1/C2 instead of
// stacking as N indistinguishable per-step boxes. index.ts skips per-step
// `sub-${id}` widgets for any SubState carrying a chainId and registers a
// `chain-${id}` widget per ChainState instead.
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import type { ChainState, SubState } from "./types.ts";

/** Latest non-empty assistant text line, or `▸ <toolName>` if a tool call is
 *  the most recent event. Shared by the standalone widget + the chain widget's
 *  active-step row so they show identical "last activity" content. */
function lastActivityLine(state: SubState): string {
  let lastLine = "";
  for (let i = state.events.length - 1; i >= 0; i--) {
    const ev = state.events[i];
    if (ev.kind === "text") {
      const textLines = ev.text
        .split("\n")
        .filter((l: string) => l.trim());
      lastLine = textLines[textLines.length - 1] ?? "";
      if (lastLine) break;
    } else {
      if (!lastLine) lastLine = `▸ ${ev.toolName}`;
      break;
    }
  }
  return lastLine;
}

export function buildSubagentWidget(
  state: SubState,
): (_tui: any, theme: any) => {
  render(width: number): string[];
  invalidate(): void;
} {
  return (_tui: any, theme: any) => {
    const container = new Container();
    const borderFn = (s: string) => theme.fg("dim", s);
    container.addChild(new Text("", 0, 0)); // top margin
    container.addChild(new DynamicBorder(borderFn));
    const content = new Text("", 1, 0);
    container.addChild(content);
    container.addChild(new DynamicBorder(borderFn));
    return {
      render(width: number): string[] {
        const lines: string[] = [];
        const statusColor =
          state.status === "running"
            ? "accent"
            : state.status === "done"
              ? "success"
              : state.status === "blocked"
                ? "warning"
                : "error";
        const statusIcon =
          state.status === "running"
            ? "●"
            : state.status === "done"
              ? "✓"
              : state.status === "blocked"
                ? "⧗"
                : "✗";
        const taskPreview =
          state.task.length > 40 ? state.task.slice(0, 37) + "..." : state.task;
        // Lite subagents get a high-visibility yellow ⚡ badge so they stand out
        // from the dim status/turn labels of full-mode agents.
        const modeLabel = state.lite ? theme.fg("warning", " ⚡lite") : "";
        const turnLabel =
          state.turnCount > 1
            ? theme.fg("dim", ` · Turn ${state.turnCount}`)
            : "";
        lines.push(
          theme.fg(statusColor, `${statusIcon} Subagent #${state.id}`) +
            modeLabel +
            turnLabel +
            theme.fg("dim", ` ${taskPreview}`) +
            theme.fg("dim", ` (${Math.round(state.elapsed / 1000)}s)`) +
            theme.fg(
              "dim",
              ` | Tools: ${
                state.events.filter((e) => e.kind === "tool").length
              }`,
            ),
        );
        // Last activity: latest non-empty assistant text line, or the most
        // recent tool name if the agent is mid-tool-call.
        const lastLine = lastActivityLine(state);
        if (lastLine) {
          const trimmed =
            lastLine.length > width - 10
              ? lastLine.slice(0, width - 13) + "..."
              : lastLine;
          lines.push(theme.fg("muted", ` ${trimmed}`));
        }
        content.setText(lines.join("\n"));
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
    };
  };
}

/** One bordered box per running chain. Renders the ChainState header (C-id,
 *  name, phase, aggregate elapsed/tools, lite badge) plus one row per step so
 *  membership + ordering is visible at a glance. The currently-running step
 *  also shows a live `▸ last activity` line, mirroring the standalone widget.
 *
 *  `resolveStep` reads the live `agents` map from index.ts (closures over the
 *  mutable ChainState + the live map) so each render() sees fresh step status —
 *  the factory itself is called once by pi and kept, exactly like the
 *  standalone widget. */
export function buildChainWidget(
  chain: ChainState,
  resolveStep: (sid: number | undefined) => SubState | undefined,
): (_tui: any, theme: any) => {
  render(width: number): string[];
  invalidate(): void;
} {
  return (_tui: any, theme: any) => {
    const container = new Container();
    const borderFn = (s: string) => theme.fg("dim", s);
    container.addChild(new Text("", 0, 0)); // top margin
    container.addChild(new DynamicBorder(borderFn));
    const content = new Text("", 1, 0);
    container.addChild(content);
    container.addChild(new DynamicBorder(borderFn));
    const toolCount = (st: SubState) =>
      st.events.filter((e) => e.kind === "tool").length;
    return {
      render(width: number): string[] {
        const lines: string[] = [];
        const total = chain.steps.length;
        const i = chain.currentIndex; // 0-based; -1 = not started
        const curAgent = i >= 0 && i < total ? chain.steps[i].agent : "?";
        const cIcon =
          chain.status === "running"
            ? "⏳"
            : chain.status === "done"
              ? "✓"
              : chain.status === "aborted"
                ? "⊘"
                : "✗";
        const cColor =
          chain.status === "running"
            ? "accent"
            : chain.status === "done"
              ? "success"
              : chain.status === "aborted"
                ? "warning"
                : "error";
        const phase =
          chain.status === "done"
            ? `done (${total}/${total})`
            : chain.status === "error"
              ? `failed step ${Math.min(i + 1, total)}/${total} · ${curAgent}`
              : chain.status === "aborted"
                ? `aborted at step ${Math.min(i + 1, total)}/${total} · ${curAgent}`
                : `step ${Math.min(i + 1, total)}/${total} · ${curAgent}`;
        // Aggregate elapsed + tools across spawned steps (pending steps
        // contribute 0 — haven't started yet).
        let aggSecs = 0;
        let aggTools = 0;
        for (const sid of chain.subagentIds) {
          const st = resolveStep(sid);
          if (!st) continue;
          aggSecs += Math.round(st.elapsed / 1000);
          aggTools += toolCount(st);
        }
        const name =
          chain.name.length > 24
            ? chain.name.slice(0, 21) + "..."
            : chain.name;
        const liteLabel = chain.lite ? theme.fg("warning", " ⚡lite") : "";
        lines.push(
          theme.fg(cColor, `${cIcon} ⛓ C${chain.id}`) +
            theme.fg("accent", ` "${name}"`) +
            theme.fg("dim", ` · ${phase}`) +
            liteLabel +
            theme.fg(
              "dim",
              ` · (${aggSecs}s, ${aggTools} tool${aggTools === 1 ? "" : "s"})`,
            ),
        );
        // One row per step (defined step → pending; spawned → live status).
        for (let s = 0; s < total; s++) {
          const sid = chain.subagentIds[s];
          const st = resolveStep(sid);
          const agentName = chain.steps[s].agent;
          if (!st) {
            lines.push(theme.fg("dim", `  ○ ${agentName} · pending`));
            continue;
          }
          const secs = Math.round(st.elapsed / 1000);
          const tools = toolCount(st);
          const meta = theme.fg(
            "dim",
            ` #${st.id} ${agentName} · ${secs}s · ${tools} tool${tools === 1 ? "" : "s"}`,
          );
          if (st.status === "running") {
            lines.push(theme.fg("accent", "  ●") + meta);
          } else if (st.status === "done") {
            lines.push(theme.fg("success", "  ✓") + meta);
          } else if (st.status === "blocked") {
            lines.push(theme.fg("warning", "  ⧗") + meta);
          } else {
            lines.push(theme.fg("error", "  ✗") + meta);
          }
        }
        // Live activity line for the active (running) step only — keeps done
        // chains compact while a running chain shows what its worker is doing.
        const runningStep = chain.subagentIds
          .map((sid) => resolveStep(sid))
          .find((st) => st?.status === "running");
        if (runningStep) {
          const act = lastActivityLine(runningStep);
          if (act) {
            const trimmed =
              act.length > width - 8 ? act.slice(0, width - 11) + "..." : act;
            lines.push(theme.fg("muted", `    ▸ ${trimmed}`));
          }
        }
        content.setText(lines.join("\n"));
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
    };
  };
}
