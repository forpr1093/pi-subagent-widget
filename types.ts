// Shared domain types for subagent-widget.
//
// SubState     — the in-memory record for one background subagent.
// InspectorEvent — one ordered log entry (assistant text OR a tool call) that
//   both the stacked widget and the floating inspector derive from. Keeping a
//   single source of truth avoids drifting between the two views.
//
// See SPEC-inspector.md for the locked decisions (grilling Q1–Q9).

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

export interface SubState {
  id: number;
  status: "running" | "done" | "error";
  task: string;
  events: InspectorEvent[]; // single source of truth for the current turn
  toolIndex: Map<string, number>; // toolCallId → events index (in-place patching)
  elapsed: number;
  sessionFile: string; // persistent JSONL session path — used by /subcont to resume
  turnCount: number; // increments each time /subcont continues this agent
  lite: boolean; // whether this agent runs in lite mode (restricted tools, no thinking)
  proc?: any; // active ChildProcess ref (for kill on /subrm)
}
