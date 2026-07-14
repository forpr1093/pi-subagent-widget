// Shared domain types for subagent-widget.
//
// SubState     — the in-memory record for one background subagent (standalone
//                OR one step inside an orchestrated chain; chainId marks the latter).
// ChainState   — the thin coordinator record for one running chain (spec §7.1).
// InspectorEvent — one ordered log entry (assistant text OR a tool call) that
//   both the stacked widget and the floating inspector derive from. Keeping a
//   single source of truth avoids drifting between the two views.
//
// See SPEC-inspector.md for the locked decisions (grilling Q1–Q9) and
// SPEC-orchestration.md §7 for the coordinator execution contract.

import type { ChainStepDef } from "./chains.ts";

export type InspectorEvent =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args: string;
      partial?: string;
      result?: string;
      isError?: boolean;
      done: boolean;
    };

export type SubagentOrigin = "user" | "agent";

export interface SubState {
  id: number;
  status: "running" | "done" | "error";
  task: string;
  events: InspectorEvent[]; // single source of truth for the current turn
  toolIndex: Map<string, number>; // toolCallId → events index (in-place patching)
  elapsed: number;
  runDir: string; // Q2 — unified run dir (~/.pi/agent/runs/<id>/); holds
                   // prompt.md / result.txt / session.jsonl / meta.json.
                   // Reaped as a unit on removal + by the Q9 sweep.
  sessionFile: string; // persistent JSONL session path (runDir/session.jsonl) —
                       // used by /subcont to resume
  turnCount: number; // increments each time /subcont continues this agent
  lite: boolean; // whether this agent runs in lite mode (restricted tools, no thinking)
  origin: SubagentOrigin; // who initiated this subagent: "user" (/sub slash) or "agent" (subagent_create tool)
  chainId?: number; // when set, this SubState is a chain step; suppresses the
                    // per-step followUp — the coordinator emits the aggregate
                    // followUp instead (spec §7.3). Dispatches to onChainStepClose.
  worktree?: { path: string; branch: string; repoRoot: string }; // §12 — git
                    // worktree this standalone subagent runs in (null/absent =
                    // shared tree). Owned here so /subrm + session_start can clean it.
                    // Chain steps carry NO worktree field — the ChainState owns it.
  proc?: any; // active ChildProcess ref (for kill on /subrm)
}

/** Coordinator record for one running chain (spec §7.1). Thin: does not render
 *  (each step is an ordinary SubState that renders itself) and does not own a
 *  session file (each step does). Stored in the `chains` map keyed by C-id. */
export interface ChainState {
  id: number; // C1, C2, …
  name: string; // template name, or "inline" for /subchain CLI-compose
  steps: ChainStepDef[]; // resolved references (agent names + tasks)
  input: string; // {input} substitution value
  currentIndex: number; // 0-based; -1 = not started
  status: "running" | "done" | "error" | "aborted";
  lite: boolean; // mode applied to every step
  aborted: boolean; // Q19 — set BEFORE killing the running step
  subagentIds: number[]; // the #N SubStates this chain has spawned (in order)
  worktree?: { path: string; branch: string; repoRoot: string }; // §12 — ONE
                    // worktree shared across this chain's linear steps (each step
                    // sees the prior step's edits). null/absent = shared tree.
                    // Removed on finalize/abort; kept if dirty.
}
