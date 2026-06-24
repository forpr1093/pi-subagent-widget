// Subagent inspector: floating, read-only, live-updating overlay that monitors
// a subagent's activity for the current turn — assistant text interleaved with
// structured tool calls (name, args, partial + final result).
//
// Pure with respect to process state: it operates on a SubState passed in; the
// orchestration (spawning, the agents map, the /subinspect command) lives in
// index.ts. See SPEC-inspector.md for the locked decisions (grilling Q1–Q9).
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { SubState } from "./types.ts";

// Cap on stored args/result per tool call. Generous so practically all tool
// output is shown in full; protects memory against a single pathological
// multi-megabyte output (the current turn's events reset on /subcont, and
// removed agents are GC'd). Complete content always remains on disk in the
// subagent's JSONL session file.
export const MAX_TOOL_FIELD = 20000;
// Display cap for tool fields (args/result/partial): a huge tool output (e.g. a
// directory listing of hundreds of files) would otherwise fill the dialog and
// drown out the agent's own text. Truncated to this many chars for display,
// with a marker showing how much was omitted. Agent text is NOT capped — it
// wraps fully so you never lose the subagent's reasoning.
export const MAX_DISPLAY_TOOL_FIELD = 400;
export const POLL_INTERVAL_MS = 300;

// Truncate a tool field for display, appending a [+N chars omitted] marker so
// dropped context is visible. Applied BEFORE wrapLine; the marker may wrap.
export function truncateField(s: string, n: number = MAX_DISPLAY_TOOL_FIELD): string {
  if (!s) return s;
  if (s.length <= n) return s;
  return s.slice(0, n) + ` … [+${s.length - n} chars omitted]`;
}

// Flatten newlines to a visible ⏎ marker so multi-line tool output (directory
// listings, code) becomes a single dense stream: this keeps the inspector's box
// borders intact (an embedded \n would break per-line padding) AND pairs with
// truncation to bound the block's height. Agent text is NOT flattened — it keeps
// real line breaks (handled separately per-line in buildInspectorLines).
export function displayField(s: string): string {
  return truncateField(s.replace(/\n/g, " ⏎ "));
}

// ── Event shaping (used by index.ts processLine) ────────────────────────────

// Truncate a stored tool field so the *visible* width stays <= n (including the
// " …" marker). Applied to plain strings only (tool args/results stringify'd).
export function cap(s: string, n: number = MAX_TOOL_FIELD): string {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 2)) + " …";
}

// Stringify an arbitrary tool arg/result value into a single-line preview.
export function stringifyVal(v: any): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Coalesce a streaming text delta onto the last text entry, or open a new one.
// Consecutive deltas merge into one paragraph-shaped entry so the events array
// stays small and renders as a single block.
export function appendText(state: SubState, delta: string): void {
  if (!delta) return;
  const last = state.events[state.events.length - 1];
  if (last && last.kind === "text") last.text += delta;
  else state.events.push({ kind: "text", text: delta });
}

// ── Rendering ───────────────────────────────────────────────────────────────

// Wrap a single (newline-free) plain string to `width` visible columns.
// Hard-breaks at width; inputs are plain (colorization happens after, in push),
// so there are no ANSI codes to split badly. Replaces the old per-line truncate,
// so the inspector shows full content (scrolling vertically) instead of cutting
// it off at the terminal width.
export function wrapLine(s: string, width: number): string[] {
  if (width <= 1) return [s];
  if (visibleWidth(s) <= width) return [s];
  const lines: string[] = [];
  let chunk = "";
  let w = 0;
  for (const ch of s) {
    const cw = visibleWidth(ch);
    if (w + cw > width && chunk) {
      lines.push(chunk);
      chunk = "";
      w = 0;
    }
    chunk += ch;
    w += cw;
  }
  if (chunk) lines.push(chunk);
  return lines.length ? lines : [s];
}

// Build the full ordered list of styled body lines for the inspector viewport.
// Interleaves assistant text (wrapped) with tool-call blocks in arrival order.
export function buildInspectorLines(
  state: SubState,
  innerW: number,
  theme: any,
): string[] {
  const out: string[] = [];
  const push = (s: string, color?: string) =>
    out.push(color ? theme.fg(color, s) : s);
  for (const ev of state.events) {
    if (ev.kind === "text") {
      let prevBlank = false;
      for (const raw of ev.text.split("\n")) {
        if (raw.trim() === "") {
          if (!prevBlank) push("");
          prevBlank = true;
          continue;
        }
        prevBlank = false;
        for (const wl of wrapLine(raw, innerW)) push(wl, "muted");
      }
      push("");
    } else {
      const statusColor = ev.done ? (ev.isError ? "error" : "success") : "accent";
      for (const l of wrapLine(
        `▸ ${ev.toolName}${ev.done ? "" : " …"}`,
        innerW,
      ))
        push(l, statusColor);
      if (ev.args)
        for (const l of wrapLine(`  args: ${displayField(ev.args)}`, innerW))
          push(l, "dim");
      if (ev.done && ev.result) {
        for (const l of wrapLine(`  → ${displayField(ev.result)}`, innerW))
          push(l, ev.isError ? "error" : "dim");
      } else if (!ev.done && ev.partial) {
        for (const l of wrapLine(`  ⋯ ${displayField(ev.partial)}`, innerW))
          push(l, "dim");
      }
      push("");
    }
  }
  return out;
}

// Plain box-drawing line filler. Built from plain chars (no ANSI) so the
// caller wraps the whole result in theme.fg() safely.
function borderLine(left: string, right: string, label: string, innerW: number): string {
  let content = label + "─".repeat(Math.max(0, innerW - label.length));
  if (content.length > innerW) content = content.slice(0, innerW);
  return left + content + right;
}

function padTrailing(s: string, innerW: number): string {
  return " ".repeat(Math.max(0, innerW - visibleWidth(s)));
}

// ── Component ──────────────────────────────────────────────────────────────

export class InspectorComponent {
  // Component & Focusable contract (focused drives hardware cursor; we render none).
  focused = false;
  wantsKeyRelease = false;

  private offset = Number.MAX_SAFE_INTEGER; // top visible body line
  private autoFollow = true; // tail new content while at the bottom
  private pollTimer: any;
  private tui: any;
  private theme: any;
  private done: (result: null) => void;
  private state: SubState;
  // lastTotal is the body-line count at the most recent render. handleInput
  // needs a line count to compute scroll bounds, but receives no width; since
  // wrapping makes line count width-dependent, it reuses this snapshot.
  private lastTotal = 0;

  constructor(
    tui: any,
    theme: any,
    done: (result: null) => void,
    state: SubState,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.state = state;
    // Timer-poll for live updates: processLine mutates state.events in this
    // process; the poll reads it and repaints.
    this.pollTimer = setInterval(() => {
      this.tui?.requestRender?.();
    }, POLL_INTERVAL_MS);
  }

  dispose() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  invalidate() {}

  private termRows(): number {
    return this.tui?.terminal?.rows || 24;
  }

  // Usable body rows after top+bottom borders, within overlay margins (1 row each side).
  private bodyHeight(): number {
    return Math.max(3, this.termRows() - 2 - 2);
  }

  private maxOffset(total: number): number {
    return Math.max(0, total - this.bodyHeight());
  }

  // Re-attach auto-follow when the user scrolls back to the bottom.
  private maybeRefollow(total: number) {
    const max = this.maxOffset(total);
    if (this.offset >= max) {
      this.offset = max;
      this.autoFollow = true;
    }
  }

  handleInput(data: string): void {
    const m = (k: string) => matchesKey(data, k);
    if (m("escape") || data === "q" || data === "Q") {
      this.dispose();
      this.done(null);
      return;
    }
    const total = this.lastTotal;
    const page = this.bodyHeight();
    if (m("up") || data === "k" || data === "K") {
      this.autoFollow = false;
      this.offset = Math.max(0, this.offset - 1);
    } else if (m("down") || data === "j" || data === "J") {
      this.offset += 1;
      this.maybeRefollow(total);
    } else if (m("pageUp") || m("ctrl+b")) {
      this.autoFollow = false;
      this.offset = Math.max(0, this.offset - page);
    } else if (m("pageDown") || m("ctrl+f")) {
      this.offset += page;
      this.maybeRefollow(total);
    } else if (m("home") || data === "g") {
      this.autoFollow = false;
      this.offset = 0;
    } else if (m("end") || data === "G") {
      this.offset = Number.MAX_SAFE_INTEGER;
      this.autoFollow = true;
    }
    this.tui?.requestRender?.();
  }

  render(width: number): string[] {
    const T = this.theme;
    const innerW = Math.max(10, width - 2);
    const all = buildInspectorLines(this.state, innerW, T);
    this.lastTotal = all.length;
    const bodyH = this.bodyHeight();
    const maxOff = this.maxOffset(all.length);
    if (this.autoFollow) this.offset = maxOff;
    this.offset = Math.max(0, Math.min(this.offset, maxOff));

    const view = all.slice(this.offset, this.offset + bodyH);
    while (view.length < bodyH) view.push("");

    // Header: id · status · mode · turn · elapsed · tool count + scroll position.
    const sc =
      this.state.status === "running"
        ? "accent"
        : this.state.status === "done"
          ? "success"
          : "error";
    const si =
      this.state.status === "running"
        ? "●"
        : this.state.status === "done"
          ? "✓"
          : "✗";
    const toolCount = this.state.events.filter((e) => e.kind === "tool").length;
    const head =
      ` Subagent #${this.state.id}  ${si} ${this.state.status}` +
      (this.state.lite ? "  ⚡lite" : "") +
      (this.state.turnCount > 1 ? `  · Turn ${this.state.turnCount}` : "") +
      `  ${Math.round(this.state.elapsed / 1000)}s  Tools: ${toolCount} `;

    const pos = `${this.offset}/${maxOff}${
      this.autoFollow ? "" : "  [follow paused]"
    }`;
    const foot = ` k/j ↑/↓  ctrl-b/f PgUp/PgDn  g/G top/bottom  q quit  ·  ${pos} `;

    const lines: string[] = [];
    lines.push(T.fg("border", borderLine("╭", "╮", head, innerW)));
    for (const l of view) {
      lines.push(
        T.fg("border", "│") + l + padTrailing(l, innerW) + T.fg("border", "│"),
      );
    }
    lines.push(T.fg("border", borderLine("╰", "╯", foot, innerW)));
    return lines;
  }
}

// Open the inspector overlay for a subagent. Caller guarantees ctx.mode === "tui".
export async function openInspector(ctx: any, state: SubState): Promise<void> {
  await ctx.ui.custom<null>(
    (tui: any, theme: any, _kb: any, done: (r: null) => void) =>
      new InspectorComponent(tui, theme, done, state),
    { overlay: true, overlayOptions: { width: "85%", margin: 1 } },
  );
}
