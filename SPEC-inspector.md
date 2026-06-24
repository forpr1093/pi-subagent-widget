# Spec: Subagent Inspector (Feature 1)

A floating, read-only, live-updating dialog that lets the user monitor what a
specific subagent is doing — full streamed assistant text + structured tool
calls interleaved — addressing the "small widget only shows truncated messages"
weakness of the current per-agent widget.

## Problem

Today each subagent renders a one-line `setWidget` above the editor: status
icon, ID, lite badge, turn, truncated task, elapsed, tool count, and the *last
non-empty streamed line*. That is too compact to follow what the agent is
actually doing. Worse, `processLine` currently discards almost everything: it
captures only `message_update` text deltas and bumps a counter on
`tool_execution_start`, throwing away tool names, args, partial results, and
final results.

## Goals

- Open a floating, read-only dialog pinned to one subagent (running or done).
- Show the full live flow within the current turn: every assistant text delta
  and every tool call (name + args + partial + final result, capped).
- Live-update as events stream in; reviewable on a finished agent.
- Add a tool-name-only summary line to the follow-up "subagent-result"
  message, so the main conversation shows how the agent got its result.

## Non-goals (explicitly out of scope)

- No interruption / input / control of the running subagent (read-only).
- No cross-turn history in the live view (prior `/subcont` turns are dropped
  from memory; full history remains on disk in `state.sessionFile`).
- No per-call argument/result detail in the main-conversation follow-up
  message — that detail lives only in the inspector dialog.

## Locked decisions (from grilling Q1–Q9)

### Q1: Scope of "what it's doing"
**(b) Live full transcript including structured tool calls** — assistant
text deltas interleaved with tool-call events (name, args, results). Not (a)
text-only, not (c) static status panel.

### Q2: Tool-event capture depth
**(ii) Name + args + truncated result**, capped at ~1000 chars per tool
result, applied to args too (long prompts are rare but possible). Full,
untruncated content remains available via the on-disk session file.

### Q3: Cross-turn retention
**(i) Current turn only.** In-memory events reset on each `/subcont`. Old
turns' full transcripts stay on disk (pi appends to the same session file).

### Q4: Turn definition & reset contract
"Turn" = one invocation (one `/sub`/`/sublite` spawn, or one `/subcont`).
A turn internally contains many think→tool→think→tool→… steps; **all** of
those steps are shown live. `events` resets at:
- spawn  (`/sub`, `/sublite`, `subagent_create`) → fresh `[]`
- `/subcont` / `subagent_continue` → `events = []` (mirrors today's
  `state.textChunks = []`); session file keeps cross-turn history
- `/subrm` / `subclear` / `subagent_remove` → whole `SubState` deleted
- `session_start` → whole `agents` map cleared (existing behavior)

Single source of truth: `SubState` gains a unified ordered `events` array;
the existing widget derives tool count from it (`filter kind==="tool"`),
replacing the standalone `toolCount` counter.

### Q5: Data model + capture
**(i) Flat FIFO of typed entries.** Tool entries keyed by `toolCallId` and
patched in place on `update`/`end`, not appended on each event. Consecutive
`text_delta`s coalesce into one text entry to keep the array small and
render as paragraphs.

Entry shape (illustrative):
```ts
type Entry =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args: any;          // capped ~1000 chars when rendered/stored
      partial?: any;      // last tool_execution_update partialResult
      result?: any;        // tool_execution_end result, capped ~1000 chars
      isError?: boolean;
      done: boolean;       // false until tool_execution_end
    };
```
Helper: `toolCallId → array index` map for in-place patching.

Events to handle in `processLine` (authoritative, from pi `docs/json.md`):
- `message_update` → `assistantMessageEvent.text_delta` appends/coalesces text
- `tool_execution_start` → open new tool entry (`done:false`)
- `tool_execution_update` → patch `partial`
- `tool_execution_end` → patch `result`, `isError`, set `done:true`

### Q6: Result message tool summary
**(iii) Summary in follow-up + full detail in inspector.** The existing
`pi.sendMessage({ customType:"subagent-result", ... })` follow-up message
gains one **tool-name-only** summary line, e.g.
`Tools called (7): bash ×4, read ×2, edit ×1`.
No args, no results in the follow-up — those live only in the inspector.
The existing 8000-char overall cap on the follow-up body is retained.

And: finished agents (status `done`/`error`) that have not yet been
`/subcont`'d **retain `events`** so the inspector opens on a `✓`/`✗` agent
to review how it got its result. `events` is cleared only on the next
`/subcont` (or removal).

### Q7: Entry point + dialog lifecycle
**(iv) Both direct and picker.**
- `/subinspect <id>` → open inspector on that agent directly.
- `/subinspect` (no arg) → overlay `SelectList` picker of current agents;
  pick one → opens inspector.
- Matching tool `subagent_inspect` (so the main agent can open it too).
- Picker branch guarded by `ctx.hasUI` / `ctx.mode === "tui"`; in non-TUI
  (print/json) modes with no arg, fall back to "Usage: /subinspect <id>".
- Stale entries (removed during pick) are filtered/killed at open time.

Dialog is **live-updating**: stays open and streams new events until closed.

### Q8: Component + update mechanism
**(ii) `ui.custom` overlay modal** (`{ overlay:true }`), the documented
floating-modal path. Not `setWidget` (that is the limitation itself), not
full-screen (contradicts "floating"), not an external process (scope
explosion). Overlay keeps the main session visible alongside the inspector.

**(a) Timer-poll for live updates.** The overlay component polls
`state.events` on a timer (~250–500ms) and calls its own `invalidate()`.
No pushed invalidation / no callback entanglement with `processLine`.
Matches the existing 1s elapsed-timer idiom. Imperceptible render lag.

### Q9: Scroll behavior
**(a) Auto-follow-tail unless scrolled up.**
- If the viewport is at the bottom when new events arrive, scroll to keep
  the bottom visible (follow).
- If the user pressed Up/PgUp, detach auto-follow (freeze their position).
- Re-attach when the user scrolls back to the bottom.

Keys (vim-style):
- `k` / `↑` — line up
- `j` / `↓` — line down
- `Ctrl-b` / `PgUp` — page up
- `Ctrl-f` / `PgDn` — page down
- `g` / `Home` — top
- `G` / `End` — bottom; also re-attaches auto-follow
- `q` / `Esc` — close

Open-at-bottom for both running and finished agents (finished agent's
bottom = final result, the highest-value content; page up from there).

## SubState change summary

Replace:
```ts
textChunks: string[];
toolCount: number;
```
with:
```ts
events: Entry[];          // single source of truth for the current turn
toolIndex: Map<string, number>; // toolCallId → events index for patching
```

Existing widget render derives:
- last non-empty line → last `kind:"text"` entry's text, last line
- tool count → `events.filter(e => e.kind === "tool").length`
- everything else (status, id, lite, turn, elapsed) unchanged

`turnCount` semantics unchanged. `lite` flag unchanged.

## Affected code sites (`index.ts`)

1. `SubState` interface — swap `textChunks`/`toolCount` for `events`/`toolIndex`.
2. `processLine` — handle `tool_execution_start/update/end`; coalesce
   `text_delta` into the last text entry; patch tool entries in place.
3. `updateWidgets` — derive last line + tool count from `events`.
4. spawn/continue/reset sites — initialize `events: []`, `toolIndex: new Map()`
   instead of `textChunks: []`; same reset points as today.
5. `proc.on("close")` result builder — build tool-name summary from
   `events.filter(e => e.kind === "tool")`, prepend one line to the
   follow-up `content`.
6. New: `subagent_inspect` tool + `/subinspect` command + overlay
   component (scroll viewport over `state.events`, timer-poll invalidate,
   keys from Q9).

## Open items deferred to implementation (not decided here)

- Exact render styling of tool entries (dim header, collapsed vs expanded
  result, error color for `isError`).
- Per-tool render: show `args` inline vs collapsed behind a key.
- Overlay size/anchor (likely centered, ~80% width × 60% height, or full
  width with margins).
- Whether a done agent's inspector shows a header line with final status
  + elapsed.

These are styling/fitting decisions best made while looking at a live render,
not grilling decisions.
