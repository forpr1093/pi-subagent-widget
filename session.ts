// Persistent JSONL session-file helpers for background subagents.
//
// Each subagent's conversation is written to disk by pi (appended across
// /subcont turns via --session), enabling resume. Files are cleaned up on
// removal (/subrm, /subclear, subagent_remove, session_start) so no orphans
// accumulate in ~/.pi/agent/sessions/subagents/.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function makeSessionFile(id: number): string {
  const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
}

// Best-effort removal of a subagent's persistent JSONL session file.
// Structured by .sessionFile so it works on SubState and minimal stubs alike.
export function deleteSessionFile(state: { sessionFile: string }) {
  if (!state.sessionFile) return;
  try {
    fs.unlinkSync(state.sessionFile);
  } catch (err: any) {
    if (err && err.code !== "ENOENT") {
      // Swallow ENOENT (file already gone); cleanup is best-effort.
    }
  }
}
