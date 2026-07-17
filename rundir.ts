// Unified RunDir per subagent spawn (spec Q2).
//
// One directory per spawn holds every artifact that run produces, so "clean up
// the run" = rm -rf one dir. Reaped by the Q9 sweep (session_start + /sub doctor)
// and by explicit removal (/subrm, /subclear, subagent_remove).
//
//   ~/.pi/agent/runs/<id>/
//     prompt.md       ← --append-system-prompt body (was a mkdtemp temp file)
//     result.txt      ← spilled result beyond 8KB inline (was orphaned in $TMPDIR)
//     session.jsonl   ← pi's --session file (was in sessions/subagents/)
//     meta.json       ← { id, origin, agent?, lite, spawnTime, parentPid }
//
// meta.json carries parentPid so the reaper can decide liveness by checking
// whether the spawning pi is still alive (single reap condition — see Q9).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RUNS_DIR = path.join(os.homedir(), ".pi", "agent", "runs");

export interface RunMeta {
  id: number;
  origin: "user" | "agent";
  agent?: string;
  lite: boolean;
  spawnTime: number;
  parentPid: number;
  /** The spawned worker pi's own pid (the process-group leader). Set after
   *  spawn (createRunDir runs before the child exists). The Q9 reaper uses it
   *  to process-group-kill an orphaned worker whose parent pi died. */
  pid?: number;
}

/** Path of the run dir for a given subagent id (may not exist yet). */
export function runDirPath(id: number): string {
  return path.join(RUNS_DIR, String(id));
}

/** Create the run dir + write meta.json. Idempotent on the mkdir; meta.json is
 *  overwritten (a continuation reuses the dir + refreshes meta). Returns the
 *  dir path. */
export function createRunDir(id: number, meta: RunMeta): string {
  const dir = runDirPath(id);
  fs.mkdirSync(dir, { recursive: true });
  writeMeta(dir, meta);
  return dir;
}

export function writeMeta(dir: string, meta: RunMeta): void {
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Patch the worker pid into an existing run's meta.json (called from
 *  spawnAgent once pi's child pid is known). No-op if the dir/meta is gone. */
export function setRunPid(dir: string, pid: number): void {
  const meta = readMeta(dir);
  if (!meta) return;
  meta.pid = pid;
  writeMeta(dir, meta);
}

/** Write the --append-system-prompt body as prompt.md inside the run dir.
 *  Returned path is the --append-system-prompt argument. Reaped with the run. */
export function writePromptFile(dir: string, body: string): string {
  const filePath = path.join(dir, "prompt.md");
  fs.writeFileSync(filePath, body, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return filePath;
}

/** Spill a large result to result.txt inside the run dir. Reaped with the
 *  run, so the pointer is durable within the run's lifetime. */
export function writeResultFile(dir: string, text: string): string {
  const filePath = path.join(dir, "result.txt");
  fs.writeFileSync(filePath, text, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return filePath;
}

/** session.jsonl path inside the run dir (pi's --session file). */
export function sessionFilePath(dir: string): string {
  return path.join(dir, "session.jsonl");
}

/** Best-effort read + parse of a run dir's meta.json. Returns null if the dir
 *  or meta is missing/unreadable. Used by the Q9 reaper + /sub doctor. */
export function readMeta(dir: string): RunMeta | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "meta.json"), "utf-8");
    return JSON.parse(raw) as RunMeta;
  } catch {
    return null;
  }
}

/** Best-effort removal of an entire run dir (recursive). Swallows ENOENT. */
export function removeRunDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort: a reap failure must never crash the extension.
  }
}
