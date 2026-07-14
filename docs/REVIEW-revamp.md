# Review — subagent-widget revamp (7 commits, `revamp/lifecycle-and-cooperation`)

Read-only review against `docs/SPEC-revamp.md` (authoritative). Evidence is
file:line in the **final** tree unless a commit diff is cited.

---

## 1. Per-commit verdicts

### Commit 1 — `f01bdf4` feat(lifecycle): unified RunDir per spawn (Q2) — **SATISFIES**
- New `rundir.ts` creates `~/.pi/agent/runs/<id>/` with `meta.json {id, origin, agent?, lite, spawnTime, parentPid}` (`rundir.ts:18-32`, `:42-47`); `prompt.md`/`result.txt`/`session.jsonl` all written inside it (`writePromptFile`, `writeResultFile`, `sessionFilePath`).
- All four spawn sites (agent tool `index.ts:511`, chain step `index.ts:1215`, `/sub` `index.ts:1606`, `/sublite` `index.ts:1662`) write `runDir` + `makeSessionFile(runDir)`; spill reads via `writeResultFile(runDir,…)` (`index.ts:93-104`). `/subcont` reads `state.sessionFile` = `runDir/session.jsonl` (`index.ts:310`).
- Every remove path now calls `removeRunDir(state.runDir)` (`index.ts:1385,1419,1481,1787,2021`); `deleteSessionFile` is fully deleted and has zero references; `writeAgentPromptFile`/`cleanupAgentPromptFile`/`mkdtempSync`/`os.tmpdir` all gone. Inspector is pure (operates on in-memory `SubState`, no disk read paths to migrate) — so no missed read path.

### Commit 2 — `b68cd52` feat(lifecycle): process-group kill (Q3) — **SATISFIES**
- Spawn sets `detached: process.platform !== "win32"` (`index.ts:365`); `terminateProcessGroup` does `process.kill(-pid,"SIGTERM")` then `SIGKILL` after 5s, win32 fallback to direct pid, `guard.unref?.()` (`index.ts:133-164`).
- All kill sites upgraded to `terminateProcessGroup`: abortChain `index.ts:1284`, removeTarget `index.ts:1375`, /subclear `index.ts:1738`, session_start `index.ts:2005`. grep confirms **zero** bare `proc.kill("SIGTERM")` remain.

### Commit 3 — `a50349b` feat(cooperation): blocked enum + views (Q11) — **SATISFIES**
- `"blocked"` added to `SubState.status` (`types.ts:31`); derived `pendingRequest?: {question; askedAt}` field added with the "NOT a re-scan of events" comment (`types.ts:53-57`).
- Every view null-guards `pendingRequest` before reading it: inspector header `inspector.ts:168-176` + `inspector.ts:339-344`, /sublist row `index.ts:1541-1549`, widget `widget.ts:60-70`. Icon `⧗` + `warning` color in widget (`widget.ts:60,67`), inspector (`inspector.ts:333,338`), chain widget (`widget.ts:213`), /sublist (`index.ts:1917`). Blocked render path is unreachable here (correct — detect lands in commit 5) and the views can't throw on a null `pendingRequest`. **Loads** — the field is added to the type in this same commit.

### Commit 4 — `d50bfc2` feat(lifecycle): orphan reaper (Q9) — **SATISFIES**
- Single reap condition: `if (isPidAlive(meta.parentPid)) continue;` — no age, no status, no "AND own-process gone" (`index.ts:188`). Reap = `if (meta.pid && isPidAlive(meta.pid)) killProcessGroupByPid(meta.pid); removeRunDir(dir)` (`index.ts:197-199`).
- `sweepRuns()` invoked from `session_start` only, silent (`index.ts:2135-2139`); no timer/auto-timeout. In-session zombies (parent alive) are excluded by the single condition, so not reaped here — deferred to `/sub doctor` (commit 7). `pid` persisted to meta via `setRunPid` at spawn (`index.ts:421`, `rundir.ts:56-62`). Status/blocked transitions: none touched here (correct — dead code until commit 5).

### Commit 5 — `3592547` feat(cooperation): turn-yield + identity prompt (Q4,Q5,Q7,Q10,Q11d) — **SATISFIES**
- **Q5 detection** in the close handler, clean-exit only: `code === 0 ? lastText.match(/^\?\?\s+(.*)$/s) : null` reading the last `kind==="text"` event (`index.ts:456-466`).
- **Q4**: yield → `state.status="blocked"` + `pendingRequest={question,askAt}` + `subagent-request` followUp (**distinct customType**), guarded by `agents.has(state.id)` to suppress pings for mid-turn removals (`index.ts:491-514`). `subagent_continue` flips `blocked→running` and clears `pendingRequest` (`index.ts:715,733`). Per-subagent, one outstanding request holds (a re-yield on a later turn overwrites `pendingRequest`).
- **Q7 request** = `[Subagent #${id}] blocked, asking:\n${question}` — no affordance line (`index.ts:510`). **Q7 result** = `[Subagent #${id}{ ⚡lite}] finished in {s}s.\n{body | "(no text output)"}{spill}` (`index.ts:541-545`); `formatResult` spills to `runDir/result.txt` (`index.ts:93-104`). Old `Result:` label, prompt echo, tool summary `(Tools called …)`, turn count `(Turn N)`, origin line `(This agent was created by User)` all cut.
- **Q10 identity prompt** matches spec §Q10 verbatim, purpose-revealing, no MUST/should (`index.ts:362-368`); old "Work autonomously… don't await user input" line is replaced.
- **Q11d**: `chainContext` gets the no-`??` purpose line (`index.ts:1388-1391`); a chain step yielding `??` is caught **before** the `blocked` flip → `status="error"`, `pendingRequest=undefined`, `failChain(…)` terminal `chain-result` followUp, `resolve(); return` — **no `subagent-request`, never hangs** (`index.ts:469-487`). Co-born with detection (same commit) — no hang window.

### Commit 6 — `edc377b` feat(surface): collapse LLM tools to 4 verbs (Q6) — **PARTIAL**
- Exactly 4 `registerTool` survivors: `subagent_create`, `subagent_continue`, `subagent_remove`, `orchestrate` (`index.ts:578,677,756,802`). Removed: `subagent_list`, `subagent_inspect`, `subagent_catalog`, `subagent_build`. No orphaned references to the removed symbols (the dropped `transcriptText` import has zero usages; `buildList` is retained for the `/sublist` command).
- `subagent_remove` restored semantics correct: `id` given → `removeTarget` reaps any status (running is killed; blocked/done/error have `proc===undefined` so the worker is already dead and the dir is reaped) (`index.ts:772-787,1373-1381`); `id` omitted → clear-all scoped to `origin === "agent"` only, skipping chain-step SubStates (`index.ts:765-777`). User-spawned are never touched by the clear-all path. Filesystem pointers present on `subagent_create`, `subagent_remove`, `orchestrate`.
- **Partial only because** `subagent_continue`'s description (`index.ts:679`) carries **no** filesystem pointer sentence. Spec Q6 says "each surviving tool's description carries one plain sentence pointing at the filesystem location." `subagent_continue` operates on an already-known `#N` (from a prior followUp), so this is low-impact and the discovery surfaces (`agents/`, `runs/`, `chains/`) are well-covered by the other three; still a literal miss on the "each" condition.

### Commit 7 — `aedf76d` feat(surface): /sub doctor + /sub no-arg landing (Q8) — **SATISFIES**
- `/sub doctor` runs `sweepRuns()` (report reaped) + scans in-session zombies (`parentPid alive && !agents.has(meta.id)` — reported, **not** reaped) + the absorbed `/subchain-doctor` config diagnostics (`index.ts:1933-1972`). `/subchain-doctor` is retired with **no alias** — the registration is replaced in place (`index.ts:1929`).
- `/sub` no-arg emits the 3-line family landing + spawn usage (`index.ts:1520-1530`). `pi.registerCommand` count = 9 (`sub, sublite, subcont, subrm, subclear, subinspect, sublist, subchain, sub doctor`) — matches the prompt's "9 commands total" (the spec's prose "9→8" was loose wording; `/subchain-doctor` is renamed/absorbed, not deleted, so the registered-name count stays 9).

---

## 2. Locked-constraint compliance

| # | Constraint | Result | Evidence |
|---|-------------|--------|----------|
| 1 | Blocked icon `⧗` + warning, **not** `?` | **PASS** | `widget.ts:60,67`, `inspector.ts:333,338`, `widget.ts:213`, `index.ts:1917` — no `?`-as-status glyph anywhere |
| 2 | `pendingRequest` is a derived field, not a re-scan of `state.events` | **PASS** | Written once at `index.ts:494`; views read the field (`inspector.ts:168`, `index.ts:1543`, `widget.ts`); the only event scan is the one-time detection at `index.ts:456-466`, not a per-render re-scan |
| 3 | `subagent_remove` clear-all scoped to `origin === "agent"` only (never user) | **PASS** | `index.ts:766-777` (`if (s.origin !== "agent" …) continue;`); user `/subclear` path `index.ts:1730` is separate and unscoped |
| 4 | `⚡lite` emoji kept in followUp | **PASS** | `index.ts:543` `${state.lite ? " ⚡lite" : ""}`; widget badge retained (`widget.ts`) |
| 5 | No shared blackboard / shared mutable state between subagents | **PASS** | Blocked state is per-`SubState`; no cross-agent shared map introduced; chains share only pre-existing `ChainState.worktree` (preserved module) |
| 6 | Close-affects-blocked produces NEITHER result NOR request followUp | **PASS** | Moot-but-safe: blocked ⟺ worker already closed (the `??` detection runs *in* the close handler, `state.proc=undefined` at `index.ts:448`); no second close can re-enter either path. Removal paths (`removeTarget`/sweep/`/subclear`) delete + reap without emitting followUps, and both emission sites are guarded by `agents.has(state.id)` (`index.ts:498,532`) |
| 7 | One outstanding request at a time | **PASS** (per-subagent) | A blocked worker is closed, so it cannot yield again until `subagent_continue` flips `running` and spawns a new turn; each yield overwrites `pendingRequest` (`index.ts:494`). *See Risks §R4 for a global-reading caveat.* |

---

## 3. Q-by-Q locked-decision verification (summary)

| Decision | Result | Notes |
|---|---|---|
| Q1 green-path (loads at every commit) | **PASS** | Final tree type-checks clean (only ambient `@types/node`/scoped-package resolution noise from a standalone `tsc` run, plus a `guard.unref?.()` that needs node types — all runtime-fine). Per-commit symbol deps resolve within-commit: Q11 adds the `pendingRequest` field the views read (commit 3); Q9 adds `readMeta`/`RUNS_DIR`/`setRunPid`/`killProcessGroupByPid` it uses (commit 4); Q5 renames `spillResult`→`formatResult` and references it consistently (commit 5). No commit references a symbol landed later. |
| Q2 RunDir | **PASS** | See commit 1. All read paths + all remove paths updated; no `deleteSessionFile` leftover. |
| Q3 process-group kill | **PASS** | See commit 2. `detached:true`, negative-pid SIGTERM→SIGKILL, all kill sites upgraded. |
| Q4/Q5 cooperation | **PASS** | See commit 5. `??` on clean exit → `running→blocked` → `subagent-request` (distinct customType); `subagent_continue` flips `blocked→running`. |
| Q7 output contract | **PASS** | Result + request formats verbatim per spec; old prompt-echo/tool-summary/turn-count/origin cut; no affordance line on requests; no spill pointer on requests. |
| Q9 reaper | **PASS** | See commit 4. Single condition, session_start + doctor only, pg-kill+rm, no auto-timeout, in-session zombies reported not reaped. |
| Q10 identity prompt | **PASS** | Locked text matches spec §Q10 exactly; purpose-revealing, no forcing modals. |
| Q11d chain handler | **PASS** | `chainContext` no-`??` line; detect-and-fail via `failChain` + terminal `chain-result` followUp, no `subagent-request`, never hangs; co-born with detection. |
| Q6 tool cut | **PARTIAL** | 4 survivors, 4 removed, pointers on 3/4; `subagent_continue` description lacks a filesystem pointer sentence. |
| Q8 slash surface | **PASS** | `/sub doctor` (sweep + absorbed diagnostics); `/subchain-doctor` retired (no alias); `/sub` no-arg landing; 9 commands. |

---

## 4. Risks / regressions

- **R1 — `Q11d` does not reap the failed step (diverges from spec prose).** Spec §Q11d literally says "treat it as a chain failure (`abortChain`, emit a terminal followUp, **reap the step**)." The implementation calls `failChain` (not `abortChain`) and deliberately **keeps** the failed step for inspection (`failChain` message: "Steps persist for inspection (/subinspect #N).", `index.ts:1268`). The prompt's checklist (the grading criterion) names `failChain` and only requires "terminal chain-result followUp, NO subagent-request, NEVER hangs" — all three hold. The unreaped step's RunDir behaves exactly like Q9's "in-session zombie" (reportable by `/sub doctor`, reapable by `/subrm`/session_start), so it's consistent with the broader philosophy. **Low severity, but a real prose divergence** — flag if strict-spec-conformance is required.

- **R2 — "blocked worker may still be alive" modeling mismatch (benign).** Spec §Q9 prose assumes a blocked worker is idle-but-alive ("an orphaned blocked worker may still be alive (idle between turns)"). The implementation detects `??` **in the close handler**, so a blocked subagent's worker has **already exited** (`state.proc=undefined`, `index.ts:448`). Consequences: (a) `sweepRuns`' `isPidAlive(meta.pid)` check for blocked orphans is usually false → the pg-kill is a no-op (the defensive check makes this safe either way); (b) the spec's "worker crashes mid-yield" close-affects-blocked case cannot arise. No observable locked decision is violated, but the spec's mental model and the code's don't fully agree on what "blocked" physically is.

- **R3 — `subagent_continue` description has no filesystem pointer (Q6 "each" condition).** `index.ts:679`. The discovery path is well-covered by the other three survivors' descriptions, so the practical degradation is small, but the literal Q6 condition ("each surviving tool's description carries one plain sentence pointing at the filesystem location") is not met for this one verb.

- **R4 — "one outstanding request at a time" is only enforced per-subagent.** `index.ts:494`. If two distinct subagents both yield `??`, both emit `subagent-request` followUps and both carry a `pendingRequest`. A strict *global* reading of "the main agent sees only the latest" is not honored. A global single-outstanding rule would be incoherent (the second subagent's question is real and needs an answer), so the per-subagent reading is almost certainly intended; flagged because the spec text is ambiguous and the handoff lists this as a locked constraint.

- **R5 — spill fallback in `finalizeChain` can silently lose the spill pointer on an empty-steps edge.** `index.ts` (finalizeChain) passes `lastState?.runDir ?? runDirPath(chain.subagentIds[last] ?? -1)`; if both are absent, `writeResultFile` targets a non-existent `runs/-1` dir and throws, `formatResult` catches and falls back to the lossy 8000-char cap with no pointer (`index.ts:99-102`). Cannot occur for a real chain (steps always exist), so very low impact, but the pointer would vanish silently rather than crash.

- **R6 — stale comment referencing a removed tool.** `index.ts:1424` docstring still says "shared by the `subagent_list` tool and …". `subagent_list` was cut in Q6. Cosmetic only.

- **R7 — `/sub doctor` zombie scan re-reads `RUNS_DIR` after `sweepRuns()` already did.** `index.ts:1944-1960`. Harmless (one extra readdir) and the ordering is correct (sweep first, then scan survivors), but the two passes could be unified. Cosmetic.

---

## 5. Suggestions (non-blocking polish only — spec is locked, no Q1–Q12 re-litigation)

1. Add one filesystem-pointer sentence to `subagent_continue`'s description (e.g. "Run artifacts for any subagent live at `~/.pi/agent/runs/<id>/` — `read` its `result.txt`/`meta.json` to inspect one.") to fully satisfy Q6's "each" condition. (Closes R3.)
2. Use the `~`-prefixed form `~/.pi/agent/runs/<id>/result.txt` for the spill pointer (spec §Q7 shows the `~` form) instead of the absolute path — the LLM-facing message is slightly more legible and matches the spec's example. The absolute path is more directly `read`-able, so this is purely cosmetic.
3. Decide deliberately on R1: either reap the failed chain step's RunDir in the Q11d path (strict spec conformance) or amend the spec prose to "fail + leave for inspection" to match the (arguably better) implementation. Don't leave the prose/code silently disagreeing.
4. Fix the stale `subagent_list` reference in the `buildList` docstring (`index.ts:1424`) — trivial.
5. Unify `sweepRuns` + the `/sub doctor` zombie scan into one `readdir` pass (R7) — minor, avoids reading the runs dir twice.
