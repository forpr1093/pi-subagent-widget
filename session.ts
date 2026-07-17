// Persistent JSONL session-file helper for background subagents.
//
// Q2: the session.jsonl now lives inside the subagent's RunDir
// (~/.pi/agent/runs/<id>/session.jsonl) alongside prompt.md / result.txt /
// meta.json. The whole RunDir is reaped together (removeRunDir in rundir.ts)
// on removal (/subrm, /subclear, subagent_remove, session_start) — no per-file
// delete helper is needed.
import * as path from "node:path";
import { sessionFilePath } from "./rundir.ts";

/** Return the session.jsonl path inside the given run dir. The run dir is
 *  created by createRunDir before this is called; --session appends across
 *  /subcont turns, enabling resume. */
export function makeSessionFile(runDir: string): string {
  return sessionFilePath(runDir);
}
