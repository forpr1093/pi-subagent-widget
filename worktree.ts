// Git worktree isolation for spawned subagents (spec §12, adopted post-research).
//
// When `worktree: "always"` (config.json) AND the cwd is a git repo, a spawned
// subagent — standalone or a chain step — runs inside a fresh worktree on a new
// branch, so concurrent agents can't clobber each other's in-flight file edits.
// Linear chain steps SHARE one worktree (a worker step sees the planner step's
// edits); parallel chains / standalone subagents get separate ones.
//
// Lifecycle: dir removed but branch KEPT on finalize/abort/`session_start` —
// committed work stays recoverable on the branch. Dirty trees are NOT
// force-destroyed (silent data loss landmine): a dirty removal is logged + the
// tree kept for inspection; only an explicit `/subrm C1` passes --force.
// Verified: `git worktree remove <path>` works from any cwd (reads the
// worktree's .git metadata); branches outlive their worktrees.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WT_DIR = path.join(os.homedir(), ".pi", "agent", "worktrees");

/** Run git in `cwd`; return {ok, out, err}. All git I/O flows through here. */
function git(args: string[], cwd?: string): {
  ok: boolean;
  out: string;
  err: string;
} {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return {
    ok: r.status === 0,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
}

/** Is `cwd` inside a git work tree? (the precondition for worktree isolation.) */
export function isGitRepo(cwd: string): boolean {
  const r = git(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.ok && r.out === "true";
}

/** The repo's top-level dir (worktree paths resolve relative to the main repo). */
export function gitRepoRoot(cwd: string): string | null {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  return r.ok ? r.out : null;
}

export interface Worktree {
  path: string; // the worktree's working directory (passed as the child's cwd)
  branch: string; // the new branch (persists after the worktree dir is removed)
  repoRoot: string; // for removal (git worktree remove is run from any repo path)
}

/** Unique-ish branch/dir name across sessions (ids reset per session_start). */
function uniqueName(prefix: string, id: number): string {
  return `${prefix}-${id}-${Date.now()}`;
}

/**
 * Create a worktree + branch off `repoRoot`'s HEAD. Returns {path, branch,
 * repoRoot} or null if git is unavailable / the add fails (caller falls back to
 * shared-tree — isolation is best-effort, never a hard error that blocks spawn).
 */
export function createWorktree(
  repoRoot: string,
  prefix: string,
  id: number,
): Worktree | null {
  if (!isGitRepo(repoRoot)) return null;
  try {
    fs.mkdirSync(WT_DIR, { recursive: true });
    const name = uniqueName(prefix, id);
    const wtPath = path.join(WT_DIR, name);
    const r = git(["worktree", "add", "-b", name, wtPath], repoRoot);
    if (!r.ok) {
      console.warn(`subagent-widget: git worktree add failed (${r.err}); shared-tree fallback.`);
      return null;
    }
    return { path: wtPath, branch: name, repoRoot };
  } catch (e) {
    return null;
  }
}

/** Remove a worktree dir, keeping its branch. `force` discards uncommitted edits
 *  (only the explicit `/subrm C1` path sets this). Returns true if the dir is
 *  gone (removed or never existed); false if a dirty tree was kept. */
/** Remove a worktree dir, keeping its branch.
 *
 *  force=false (finalize/abort path): only remove a CLEAN tree. A dirty tree
 *  is KEPT + warned (never silently destroyed). Any other failure (missing,
 *  git error, permissions) also keeps + warns — no auto-escalation. The branch
 *  always survives regardless.
 *  force=true (explicit /subrm, /subclear, session_start): --force-removes,
 *  discarding uncommitted edits as the user requested. */
export function removeWorktree(wt: Worktree, force = false): boolean {
  if (!wt?.path) return true;
  if (force) {
    const r = git(["worktree", "remove", "--force", wt.path], wt.repoRoot);
    if (r.ok) return true; // branch intentionally remains even when forced
    // Metadata already pruned? Last resort: nuke the dir directly (branch survives).
    try {
      fs.rmSync(wt.path, { recursive: true, force: true });
      return true;
    } catch {
      console.warn(`subagent-widget: could not remove worktree ${wt.path} (branch ${wt.branch} kept).`);
      return false;
    }
  }
  // Non-forced path: clean-remove only; NEVER auto-escalate to --force/rmSync.
  const r = git(["worktree", "remove", wt.path], wt.repoRoot);
  if (r.ok) return true;
  if (/modified or untracked|contains/i.test(r.err)) {
    console.warn(
      `subagent-widget: worktree ${wt.path} has uncommitted changes — kept (branch ${wt.branch}). Use /subrm to discard, or inspect/merge.`,
    );
    return false; // KEPT — no silent data loss (M2 fix)
  }
  console.warn(
    `subagent-widget: worktree ${wt.path} not clean-removable (${r.err || "unknown"}) — kept (branch ${wt.branch}). Use /subrm to force.`,
  );
  return false;
}
