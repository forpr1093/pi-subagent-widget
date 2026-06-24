// The stacked per-agent widget rendered above the editor (compact live status).
//
// Reads from SubState.events (the single source of truth shared with the
// inspector): derives tool count + last activity line. Returns the component
// factory that setWidget expects; index.ts iterates the live agents and wires
// each with buildSubagentWidget(state) / undefined.
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import type { SubState } from "./types.ts";

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
              : "error";
        const statusIcon =
          state.status === "running"
            ? "●"
            : state.status === "done"
              ? "✓"
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
