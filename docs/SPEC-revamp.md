# SPEC — Subagent-Widget Revamp

**Status:** Draft for review (post-grilling). All 12 questions (Q1–Q12) resolved.
**Method:** Facilitator grilled a `spec-owner` subagent (defined in
`~/.pi/agent/agents/spec-owner.md`) one question at a time. Every locked
decision below carries the facilitator's recommendation *and* the spec-owner's
corrections — where they diverge, the spec-owner's reasoning wins and is
recorded. This is not a menu of options; it is a single coherent spec.

---

## The four goals (every decision serves these)

1. **Native feel.** Any LLM using pi uses the subagent features by scenario —
   feels integrated, not a bolted-on "extension."
2. **No bad designs.** Subagents recognize themselves, cooperate, no identity
   confusion.
3. **Good lifecycle.** One coordinated run dir per spawn; no orphaned temp
   files; no hidden vulnerabilities or exploits.
4. **Easy to get hands on.** A fresh user finds the surface and trusts it.

## The user's locked preferences (constraints, not re-litigatable)

- **P1** Refactor in place, not a clean rewrite. Keep the 9 sound pure modules;
  rewrite the orchestration core (`index.ts`).
- **P2** Subagents use the `settings.json` default model — never follow the main
  agent's current model. (`model: "default"` keyword.)
- **P3** **Block, not fire-and-forget** for the request channel. "Do the correct
  thing, not just do something and call it a day even if it's wrong." Prevent
  token waste on wrong assumptions.
- **P4** No hard instructions forcing behavior. Tell agents the channel exists
   and that the subagent will ping them; let them choose.
- **P5** Plain words in tool descriptions, not heavy prescriptive rules.

---

## Locked decisions

### Q1 — Revamp in place (P1)

Keep the 9 pure modules (`types.ts`, `config.ts`, `disallow.ts`, `agents.ts`,
`chains.ts`, `session.ts`, `worktree.ts`, `inspector.ts`, `widget.ts`). Rewrite
the orchestration core: `index.ts` (tools + commands + coordinator + spawn/close)
+ `types.ts` additions. The pure modules already encode hard-won insights
(dirty-worktree preservation, the disallow-list filter, survivor resolution);
rewriting them is where bugs re-enter. "Groundbreaking" comes from capabilities
added and surface subtracted, not a stylistic rewrite.

### Q2 — Unified `RunDir` per spawn

One directory per spawn holds every artifact that run produces, so "clean up the
run" = `rm -rf` one dir.

```
~/.pi/agent/runs/<id>/
  prompt.md       ← append-system-prompt content (was temp file)
  result.txt      ← spilled result (was orphaned in $TMPDIR)
  session.jsonl   ← pi's --session file (was in sessions/subagents/)
  meta.json       ← {id, origin, agent, lite, spawnTime, parentPid}  (NEW)
```

- **`<id>` scope:** per-session reset (matches today's `nextId`). `meta.json`
  carries `parentPid` so orphans are detectable by "live set doesn't contain
  this dir's parent pid."
- **Migration:** one atomic commit (no shadow two-step — see Q12). All read
  paths (`subagent_continue` on session.jsonl, spill on result.txt, inspector)
  updated to read from the run dir.
- **Reaped by** the Q9 sweep (session_start + `/sub doctor`).

### Q3 — Process-group kill

Today `state.proc.kill("SIGTERM")` kills only the direct `pi` child; its
grandchildren (git, npm, tsx, dev server) orphan — zombie grandchildren holding
file locks and worktrees.

- **Spawn:** `detached: true` → child calls `setsid()`, becomes a process-group
  leader. Every process it spawns joins that group.
- **Kill:** `process.kill(-proc.pid, "SIGTERM")` (negative pid = whole group),
  then `SIGKILL` after ~5s if still alive. Mirrors pi's own `exec.js` pattern
  (graceful → forced).
- **Replaces** the 3 bare `proc.kill("SIGTERM")` sites (`abortChain`,
  `removeTarget`, `/subclear`).
- **`detached` implication:** subagents survive a parent-pi crash (the point —
  crash-survivors can be `/subcont`'d). The Q9 orphan sweep catches the ones
  nobody comes back to.

### Q4 — Turn-yield request channel (the cooperation primitive)

No synchronous `await` (no such primitive exists across separate pi processes),
no shared blackboard. "Block" realizes as a **cooperative turn-yield**:

1. Subagent, hitting a fork, **ends its turn with a `??`-marked question**
   instead of guessing and continuing.
2. Extension's close handler detects the marker → emits `subagent-request`
   followUp (distinct from `subagent-result`).
3. Main agent wakes on the followUp, answers via **existing `subagent_continue`**
   — no new tool.
4. `subagent_continue` pushes the answer as a new prompt → subagent starts a
   fresh turn with the answer as context.

**Why turn-yield over synchronous-block:** no hang primitive to time out, no new
IPC surface (reuses stdout + `pi.sendMessage` + `subagent_continue`), idle
between turns costs zero tokens/CPU, survives main-agent crash (just an idle
"running" subagent). Observable property is identical to a real block: no work
proceeds until answered.

- **One outstanding request at a time.** A new request supersedes the old (main
  agent sees only the latest). Enforced in the sender, one line.
- **Never-answered case:** **linger** until explicit kill (`/subrm`,
  `/subclear`) or the Q9 session_start sweep. **No auto-timeout** — re-introducing
  timeout machinery would undo the "no timeout" win. Idle-between-turns holds
  only cheap resources (worktree files); the explicit escapes are sufficient.
- **Blackboard dropped.** LLMs cooperate poorly via shared mutable state
  (cost explosion or lost-update drift). Message-passing (this) + pipeline
  (chains) cover the legs that work.

### Q5 — The yield mechanism: stdout `??` marker

The extension does **not** load inside its own children (`disallow.ts`'
recursion guard). So the yield can't be a `subagent_ask_parent` tool registered
in the child — that would require a child-side extension piece (removing the
recursion guard risks subagents spawning their own subagents) or a separate
micro-extension. **Rejected** on the recursion-guard constraint alone.

- **Mechanism: prompt convention + stdout marker.** The identity prompt tells
  the subagent to end its turn with `??  ` followed by the question. The parent's
  `processLine`/close handler detects a last-text-event starting with `??  ` →
  emits `subagent-request` instead of `subagent-result`.
- **Distinct `customType`** (`subagent-request` vs `subagent-result`) —
  structured type is more reliable across models for "any LLM uses this
  natively" (goal #1) than a prose prefix.
- **No new tool, no extension-in-child, no recursion-guard change.** The wire is
  stdout, which we already poll.

### Q6 — Collapse the LLM tool surface to 4 verbs

Today: 8 LLM-facing tools (`subagent_create`, `subagent_continue`,
`subagent_remove`, `subagent_list`, `subagent_inspect`, `subagent_catalog`,
`subagent_build`, `orchestrate`). A model landing fresh sees a spreadsheet of
verbs, not a coherent feature — directly hurts goal #1.

**Survivors (4), each a distinct scenario:**
1. `subagent_create` — spawn (lite or full, named-agent or bare). "Offload work
   to the background."
2. `subagent_continue` — resume / answer a blocked subagent's `??` request
   (Q4). "Cooperate."
3. `subagent_remove` — stop + reap a subagent no longer needed (running,
   blocked, done, or error). "Clean up."
4. `orchestrate` — multi-step chain referencing named agents. "Pipeline."

**`subagent_remove` is kept (restored from cut) for LLM cleanup agency.**
Design:
```
subagent_remove({ id? })
  - id given   → kill (Q3 process-group) + reap RunDir, any status
                 (running / blocked / done / error). Explicit intent, safe.
  - id omitted → clear all subagents with origin === "agent"
                 (the LLM's own spawns only; never user-spawned ones)
```
- **The safety boundary is `origin`** (the field already exists in `SubState`).
  Targeted `id` removal is explicit intent — safe for any origin (the LLM names
  a specific `#N`). Clear-all is the real footgun (an LLM "tidy up" sweeping
  subagents it didn't intend, including ones the *user* spawned and is
  watching), so clear-all is `origin === "agent"`-scoped: the LLM cleans its own
  mess, never yours. Your `/subclear` (user command, Q8) still clears
  everything regardless of origin.
- **Does NOT conflict with Q4/P3.** P3 (block, don't guess) constrains the
  *subagent's* behavior (ask instead of guessing). The *parent* deciding "I
  don't need this anymore, remove it" is a separate, legitimate cleanup action —
  it cancels the subagent, it doesn't tell it to guess. The spec-owner's earlier
  "footgun/determinism" argument conflated these two.
- **Resolves cost "hung child lingers until user `/subrm`s"** (see Costs): the
  LLM now reaps its own done-with spawns instead of leaving them for the user.

**Cut** (4), each justified as **file-native**, not "user-only action":
- `subagent_list`, `subagent_inspect`, `subagent_catalog` — the unified `RunDir`
  (Q2) + `~/.pi/agent/agents/` dir give the LLM *native filesystem access* to
  the same info. `ls ~/.pi/agent/agents/` enumerates named agents;
  `read ~/.pi/agent/runs/<id>/{meta.json,result.txt,session.jsonl}` inspects a
  running subagent. Dedicated tools are single-use wrappers around `ls`/`read`
  a native-feeling LLM doesn't need. Simplicity-rule cuts.
- `subagent_build` — the `crafting-agents` skill already documents the spawn
  contract; the LLM has `write`. A dedicated file-authorship tool is redundant.
  Malformed files fail at spawn — a fine error path; no pre-validation tool.

**The condition (load-bearing):** each surviving tool's description carries one
plain sentence pointing at the filesystem location. `subagent_create` names
`~/.pi/agent/agents/` (to reuse a role) and `~/.pi/agent/runs/` (to see living
subagents). Without that pointer, the cuts degrade from "native" to "hidden."
No prescriptive rules (P5) — just "these live here."

**Descriptions:** scenario-led plain words ("use this when you have substantial
independent work to offload"), not prescriptive rules. The `subagent_continue`
description names the "answer a blocked subagent" scenario — there is **no
affordance line baked into each request followUp** (Q7). Trust the description;
verify empirically; add back only if LLMs stall on requests in testing.

### Q7 — Output contract

**Spill threshold: keep 8KB inline, spill to `~/.pi/agent/runs/<id>/result.txt`
beyond that.** Don't change the number — it was stress-tuned (R6); the bug was
the orphaned destination, which Q2's RunDir fixes. Self-cleaning now (reaped
with the run). Tuning it would be speculative (P1/simplicity).

**`subagent-result` content — trim provenance, keep the operable + signal facts:**

```
[Subagent #{id}{ if lite: " ⚡lite"}] finished in {round}s.
{result | "(no text output)"}
{if spilled: "Full result: ~/.pi/agent/runs/{id}/result.txt"}
```

- **Keep:** `#{id}` (operable — needed for continue), `⚡lite` (the **quality
  signal** — a lite subagent has a strictly smaller tool surface, so its claim
  "I checked the docs" means *stronger* than a full agent's, because the lite
  one physically couldn't run a doc lookup; that changes how the main agent acts
  on the result), `"(no text output)"` (the LLM knowing the child produced
  nothing is material), spill pointer (tells it more exists).
- **Keep the emoji** (`⚡lite`). User preference — the emoji is high-visibility,
  not mere widget-cuteness; the spec-owner cut it as "cuteness" but visibility
  is exactly the point of the lite signal.
- **Cut:** `Result:` label (result is obviously the result), turn count (widget
  territory; the LLM doesn't act on it), origin line (file-native in meta.json
  per Q6's logic).

**`subagent-request` content — question-shaped, distinct, no affordance line:**

```
[Subagent #{id}] blocked, asking:
{the ?? question}
```

- "Blocked" carries the Q4 not-finished state; "asking" signals a response is
  expected (the affordance, in one word); `#{id}` is the operable piece.
- **No "Answer via subagent_continue…" affordance line.** Q6's whole design pays
  for scenario-led descriptions; if the LLM needs an affordance baked into
  *every request followUp*, Q6's descriptions failed and we fix the
  description — not patch every message. Annotating each followUp with the
  predicted tool name is the spreadsheet-of-verbs anti-pattern in another form.
- No spill pointer on requests — a yielded clarifying question is short by
  nature.

### Q8 — Slash command surface: minimal consolidation + family landing

User-typed commands (not LLM tools). Pressure is discoverability, not LLM
attention. Keep what's distinct; fold the one real redundancy.

**Two required changes:**

1. **Fold the doctors into `/sub doctor`.** Absorb `/subchain-doctor`'s config
   diagnostics INTO `/sub doctor`, and make `/sub doctor` ALSO run the Q9 orphan
   sweep (report + reap). One command, two jobs (show config state + sweep dead
   runs). `/subchain-doctor` dies cleanly (no alias — refactor-in-place, not
   "keep the old path alive").
2. **`/sub` no-arg → family landing.** Three short lines naming the family
   (spawn `/sub`/`/sublite`; view `/sublist`; kill `/subrm`/`/subclear`;
   cooperate `/subcont`; pipeline `/subchain`; health `/sub doctor`), then the
   spawn usage. The landing IS goal #4's user-side implementation — 8 peer
   commands are tractable *because* the surface reveals itself at the natural
   entry point (`/sub` is what a fresh user types first). The count and the
   landing are coupled decisions: you can't cut the landing and keep the count.

**Keep the rest separate:**
- `/sub` + `/sublite` as peer commands (not a `--lite` flag). The sound reason:
  **autocomplete-discoverability** — a user typing `/sub` sees `/sublite` as a
  sibling and learns the spectrum exists; a flag requires the user to already
  know it. Peer verbs are the discovery surface; flags are for experts. (Not
  "you wanted it in history" — that's an appeal to history, rejected on
  principle.)
- `/subclear` separate from `/subrm`. `/subrm` no-arg = clear-all is a footgun
  (typo'd/empty arg nukes everything). `/subclear` is the deliberate
  two-syllable "I mean all." The Unix `rm` analogy fails: `rm` operates on
  named files; "clear all subagents" has no named target.
- `/sublist` + `/subinspect` separate. Summary vs detail; `/sublist` is the
  non-TUI (`-p`) lifeline.
- `/subcont` + `/subchain` separate. One verb each, mirroring the Q6 tool
  scenarios.

Net: 9 commands → 8 (`/subchain-doctor` absorbed) + the `/sub` landing.

### Q9 — Reaper

Stale RunDirs accumulate (crashed parent, killed subagents, finished-but-not-
cleaned, abandoned blocked). The sweep decides what dies and when.

- **Triggers: session_start + `/sub doctor`. No timer.** session_start is the
  natural lifecycle boundary (catches last-session orphans cheaply: one readdir
  + pid liveness check per dir); `/sub doctor` is the on-demand escape hatch. A
  timer is a hidden lifecycle the user can't see/control — schedulers in
  extensions are a known footgun.
- **Reap criterion: `parentPid` not-alive. Single condition.** A RunDir is
  reapable iff `meta.json`'s `parentPid` is no longer a live process. Do NOT
  reap by age (would kill a legitimately long-running subagent). Do NOT add
  "AND status terminal" or "AND own-process gone" — those are **redundant**:
  every run the sweep should NOT touch (in-session working, in-session blocked,
  in-session finished) is already excluded by "parentPid alive" (spawned by
  THIS session's pi). Extra conditions protecting already-protected cases is
  speculative defense.
- **Reap = process-group kill (Q3) + RunDir removal.** Not file-only: an
  orphaned blocked worker may still be alive (idle between turns); the sweep
  must kill the live worker process-group, then remove the dir.
- **Blocked-subagent distinction is subsumed by the single condition:**
  - Blocked, spawned THIS session (parent alive): parentPid alive → not
    reapable. Lingers until `/subrm` or parent dies. Honors Q4's "linger until
    explicit kill." The sweep never touches it.
  - Blocked, parent crashed: parentPid dead → reapable. This is the Q3 orphan
    case — the sweep *does* catch it. (A parent/own-pid conflation in an
    earlier draft would have left orphaned blocked workers lingering forever;
    the single-condition rule has no such hole.)
- **No keep-one-cycle.** /sublist-after-restart does NOT genuinely need
  last-session results: /sublist is "what's running NOW"; results were already
  delivered as followUps into the prior session's conversation (pi's own log);
  cross-session LLM file-native access isn't a thing (fresh pi = fresh LLM
  session, no memory of last session's subagent IDs); keep-one-cycle needs
  state (reap counter / lastSeen timestamp) which is real complexity for
  marginal benefit. All last-session runs reaped at next session_start uniformly.
- **`session_start` = the restart boundary.** A crash ends the session; the
  restart IS a new session_start, which fires the sweep. No "one session of
  lingering" — the restart immediately reaps orphans.
- **In-session zombie RunDirs** (worker exited, parent pi still alive — e.g.,
  hard crash of a lite worker mid-task): NOT reaped by session_start (parent
  alive) NOR by `/subrm` unless the user notices. `/sub doctor` mid-session
  should **report** these as diagnostics ("1 zombie: worker exited, RunDir
  remains at runs/<id>") without reaping, letting the user `/subrm`
  deliberately. Flagged as a doctor-feature, not a reaper-rule.

### Q10 — Identity prompt (the heart of goal #2)

Rewrite the current `subagentContext`, which literally says "Work autonomously...
don't await user input" — a direct contradiction of Q4.

**The lever, precisely:** P4 forbids *forcing* = unconditional modals
(MUST/always/never) that remove the model's judgment about *when* to act. It
does NOT forbid (a) revealing the channel's existence, (b) revealing its
*purpose* (what scenario it's for), (c) the mechanism. The distinguishing fact:
does the wording preserve the model's judgment over whether the triggering
scenario has occurred? If yes → steering (allowed). If no ("you may not proceed
without asking") → forcing (forbidden). The lever is **not modal strength
(can/should/MUST)**; it is **whether the channel's purpose is revealed**.

**"You can" is below P4's floor, not above it.** Mere permission reveals a
channel *exists* but not *what it's for* — a fresh spawn doesn't know asking is
the *designed remedy* for risky forks; it reads as an optional escape hatch, and
a greedy model skips it. The fix is not to climb the modal ladder; the fix is to
reveal purpose: name the scenario the channel is *for*, then the mechanism. This
is Q6's scenario-led principle applied to the prompt.

**Locked prompt text:**

```
[Subagent context]
You are a subagent — a background agent spawned by ${originLabel} to perform a delegated task. You are not the main agent and do not interact with the user directly. Work toward completing the task; your final output is returned to ${originLabel} automatically when your turn ends.

The "??" marker is for asking ${originLabel} a question mid-task: if you reach a fork where proceeding risks wrong or wasted work, end your turn with "?? " followed by your question. Your turn ends; ${originLabel} continues you with an answer. One question at a time — a new one replaces any pending.

When a continuation arrives after your "??" question, read it before acting: it's either an answer to apply as context and resume, or a redirection. Distinguish before proceeding.
```

- `originLabel` = "the user (via a slash command)" | "the main agent (via a tool call)".
- Purpose first ("is for asking mid-task"), trigger scenario second ("if you
  reach a fork where proceeding risks wrong or wasted work"), mechanism third
  ("end your turn with '?? '"). No modal. The model retains full judgment over
  whether a fork occurred (Q4: block *when* risky, not *always*).
- `chainContext` (when applicable) gets its own purpose-revealing line — see
  Q11. Exact voice deferred to implementation, but must preserve Q10's
  principle (reveal *why*, not just forbid).

**Reinforcement:** each subagent spawn is zero-memory, so cross-spawn
reinforcement doesn't happen. The prompt is the **primary** lever for
*first-yield* behavior; the Q7 followUp design is a **secondary** lever (channel
viability *within* a multi-turn yield cycle). Testing empirically is the
verification (success criterion: "subagent yields at a constructed risky fork
instead of guessing") — empirics verify the wording, they don't substitute for
choosing it.

### Q11 — The blocked state surface

Q4/Q5 created a new state: BLOCKED (yielded `??`, ended turn, waiting for
answer). Today's `status: "running" | "done" | "error"` renders a blocked
subagent as `●` accent — indistinguishable from "still working." Breaks goal #1
(user can't trust the state) and goal #2 (cooperation invisible).

**(a) Add `"blocked"` to `SubState.status`.** Transition invariants (load-bearing):
- `running→blocked` (yield detected in `processLine`/turn-boundary)
- `blocked→running` (`subagent_continue` starts the next turn)
- `blocked→done|error` (real close while blocked — worker crashes mid-yield, or
  parent dies and reaper kills per Q9). **Required by Q9:** the close/kill path
  must NOT require going through `running` first (no `blocked→running` gate
  before reap).
- **Close handler ordering hazard:** for a `blocked→done/error` transition there
  may be a pending `??` question. The close path must NOT attempt to *deliver*
  that pending question as a `subagent-request` (the agent is gone); it reaps.
  Close-affects-blocked produces **neither result nor request followUp**, just
  the reap transition. (Implicit cost of the blocked-orphan case.)

**(b) Widget: hourglass icon + warning color.** Status `blocked` → icon `⧗` (or
`◷`), color `warning` (yellow). Renders against `●` accent (running) / `✓` green
(done) / `✗` red (error).
- **Rejected `?` icon** on three grounds: (i) `?` conventionally reads "unknown
  status / error" — undermines trust for goal #1; (ii) redundant with the
  question text rendered in inspector/sublist; (iii) wrong temporal semantics —
  "blocked, waiting" is a *waiting* state, not a *questioning* state. The
  affordance is in the inspector/sublist question text + the Q7 followUp wording,
  not the glyph.
- **Yellow intentionally collides with the lite badge's color family** — coherent
  signaling: yellow = "this subagent is in a non-default mode you should notice"
  (lite capability constraint / blocked waiting).

**(c) Inspector + /sublist: show the pending question via a derived field.**
- inspector header: `subagent #N [blocked] lite · turn M · asking: <pending>`
- /sublist row: `#N blocked: <preview>` (no leading `?`-glyph; `[blocked]` says
  it).
- **Source:** when status flips `running→blocked`, write the pending question
  once to a derived field: `pendingRequest?: { question: string; askedAt:
  number }` (in-memory on SubState, or RunDir/meta.json sibling). Clear on
  `blocked→running` (answered) and `blocked→done|error` (reaped). inspector /
  sublist / subagent-request followUp all read this one field.
- **Not** a re-scan of `state.events` (the append log) for "last `??`-text
  event." That's an *unstable abstraction* (re-scans the whole log each render;
  semantics drift if a non-`??` line starts with `??`; unclear under multi-turn
  yields whether older `??` events are trimmed). `pendingRequest` is a derived
  pointer the status machine maintains for O(1) reads — not duplication.

**(d) Chain steps + blocked: forbid `??` via `chainContext`; detect-and-fail
non-compliance.**
- **The sharp fact:** a chain step's `??` has **no well-defined answer-channel
  semantics.** The Q5 protocol requires `subagent_continue(id, answer)` from the
  main agent; in a chain, the coordinator (`orchestrate` via `onChainStepClose`)
  auto-advances — there is no "main agent" in the loop, and the coordinator is a
  router, not a reasoner. A chain's design invariant is single-input-per-step
  (the `{previous}` substitution is the sole inter-step input). A yield would
  either wrongly auto-advance on a non-answer (silent corruption — next step runs
  on garbage) or wrongly hang. Fixing either requires puncturing fire-and-forget
  — bubbling the request to the main agent, which means the chain is no longer a
  pipeline but a managed multi-step subagent. `??` in a chain isn't a question
  with nowhere to go — it's *semantically undefined*.
- **`chainContext` line** (purpose-revealing, Q10's voice): "This subagent runs
  as one step in an automated chain; the `??` answer channel has no route in
  chains, so proceed through the step without yielding `??`." Reveals the
  *reason* (no route), not just a forbid.
- **Required defensive handler (not optional):** a chain step that *does* yield
  `??` despite the prompt (models don't always comply) would flip to `blocked`,
  but `onChainStepClose` waits for a close that a blocked step never produces →
  the chain hangs forever. When a chain-context subagent transitions to
  `blocked`, treat it as a chain **failure** (`abortChain`, emit a terminal
  followUp, reap the step). NOT a silent hang. Cost: a chain step that wanted to
  yield is killed; acceptable because a step that genuinely needs an input must
  be a standalone subagent the main agent manages, not a pipeline step.

### Q12 — Migration ordering (7 commits, no backwards dependencies)

Q1's refactor-in-place requires a green path between commits: at every commit,
the extension loads and existing commands work (behavior can be
partial/feature-gated; no parse-error/non-loading commits). No big-bang rewrite.
Count is driven by the green-path constraint, not a preference for small commits.

**The 7-commit ordering (each independently loadable + manually testable):**

1. **Q2 (full)** — RunDir created, `meta.json` written, `prompt.md` /
   `result.txt` / `session.jsonl` moved INTO it; all read paths updated
   atomically. Verify: spawn writes `runs/<id>/`, `/subcont` reads from new
   path, spill lands at `runs/<id>/result.txt`. Safety: risky (path migration) —
   de-risked by **atomic review**, not by a shadow two-step (the shadow protected
   nothing: the reaper catches dead-parent RunDirs, not botched path reads).
2. **Q3** — process-group kill (`detached:true` + `process.kill(-pid,
   SIGTERM→SIGKILL)`), 3 sites. Verify: `/subrm` kills the whole tree.
3. **Q11 enum + views (dead code)** — `blocked` enum, transition invariants,
   in-memory `pendingRequest` field, widget `⧗`/warning icon, inspector/sublist
   wording. Verify: extension loads, existing states render, blocked render path
   unreachable. Views must null-guard `pendingRequest` (render "asking:" only
   when non-null), since it's empty until step 5.
4. **Q9 (lifecycle only)** — `sweepRuns()` + `session_start` hook; reap =
   process-group kill (Q3) + RunDir removal; blocked-orphan reap path respects
   "no followUp on close-affects-blocked" (dead code here, alive after step 5).
   Verify: kill parent, restart, runs swept. **No `/sub doctor` command yet**
   (that's Q8 — de-conflated from the lifecycle primitive).
5. **Q4 + Q5 + Q7 + Q10 + Q11 chain handler (cooperation model, end-to-end)** —
   `??` marker detection in `processLine` → `running→blocked` transition →
   `subagent-request` followUp (Q7 format) reading `pendingRequest` → identity
   prompt rewrite (Q10) → `subagent_continue` flips `blocked→running` → **chain
   detect-and-fail handler + `chainContext` no-`??` line** (co-born with
   detection — no hang window between detection and the handler that catches
   non-compliance). Verify: construct a risky-fork task → yields `??` →
   `/subcont` answers → resumes; chain step yielding `??` aborts with failure
   followUp, doesn't hang. The largest commit; these 5 are genuinely inseparable
   (`??` detection without the blocked state / followUp / prompt / answer flip /
   chain handler is a half-feature that can't be smoke-tested for cooperation).
6. **Q6** — remove 4 `registerTool` calls, rewrite 4 descriptions (incl.
   `subagent_remove`'s restored cleanup semantics) with filesystem pointers to
   `~/.pi/agent/agents/` + `~/.pi/agent/runs/`. Verify: `/sub` spawns,
   `subagent_continue` answers, `subagent_remove` reaps (by id + origin-scoped
   clear), `orchestrate` chains; `ls`/`read` see file-native surfaces.
7. **Q8** — `/sub doctor` command (on-demand sweep (Q9's `sweepRuns`) + absorbed
   `/subchain-doctor` config diagnostics) + `/sub` no-arg family landing. Verify:
   `/sub doctor` does both jobs; `/sub` no-arg lists family.

**Backwards-dependency check (verified):** Q9 reads Q2's `meta.json`
(step 1 → 4 ✓) and uses Q3's kill (2 → 4 ✓); Q11 views are dead code until
Q4/Q5's detection (3 → 5 ✓); Q7 reads Q11's `pendingRequest` (3 → 5 ✓); Q10
references `??` marker from Q5 (same commit ✓); chain handler co-fires with
detection (same commit ✓); Q8 invokes Q9's `sweepRuns` (4 → 7 ✓); Q6's pointers
to `agents/` (pre-existing) and `runs/` (Q2, step 1 → 6 ✓). **No dependency runs
backwards.** The hazard that *appeared* to (chain handler after detection) was
merged into step 5.

**Not collapsed further because:** merging step 3 into 5 bloats the feature
commit beyond reviewability; merging Q6 + Q8 conflates distinct review surfaces
(removing LLM-tool registrations vs absorbing a slash command + adding a landing)
with different revert reasons. 7 is the floor where each commit is independently
loadable + testable AND no ordering hazard exists.

---

## Costs paid (honest accounting) + resolutions

- **Chains cannot ask.** Real, and unfixable within the pipeline abstraction
  (sound framing: "no answer-channel semantics exist for single-input chain
  steps," not "we choose to disable"). **Resolution is at the authoring layer,
  not the architecture:** `orchestrate`'s description must state plainly "chain
  steps can't ask mid-run; if a step needs input, spawn it standalone instead."
  The cost moves from a silent limitation to a stated boundary the LLM/user
  picks around at selection time. The detect-and-fail handler (step 5) still
  catches non-compliance — a chain step that yields `??` aborts with a failure
  followUp rather than hanging.
- **~~A hung child lingers until the user `/subrm`s.~~** **Dissolved** by
  restoring `subagent_remove` (Q6). The LLM now reaps its own done-with spawns
  (`origin === "agent"` scoped for clear-all). This was the single biggest
  lifecycle leak; the user's Q6 feedback closes it.
- **~~`blocked` lingers until explicit kill with no auto-timeout.~~**
  **Dissolved to intended behavior.** A blocked subagent the LLM/user *wants*
  to wait on is correct, not a cost. A blocked subagent nobody wants now has two
  exits: the LLM `subagent_remove`s it, or Q9's sweep reaps the orphan (dead
  `parentPid`). No auto-timeout is re-introduced (would undo the no-timeout
  win); the explicit exits cover the "nobody comes back" case.
- **The step-5 feature commit is a 5-decision-in-1.** Large, but the 5 are
  genuinely inseparable (`??` detection without the blocked state / followUp /
  prompt / answer flip / chain handler is a half-feature that can't be
  smoke-tested for cooperation). **Resolution is process, not architecture:**
  split the *review* even though the commit is atomic — review the 5 pieces
  independently before landing. Everything before step 5 made the state machine
  safe; step 5 is the feature commit everything else prepared.
- **No "should"-flavored normative pressure** in the identity prompt (P4). A
  model that understands the channel's purpose but *chooses* to guess anyway
  has one less modal pressure to stop it. **This is the explicit P4 tradeoff —
  accepted by design, not "solved."** "Solving" it means re-introducing forcing
  (`MUST`/`always`), which contradicts P4. The escape hatch is empirical:
  construct a risky-fork test, measure yield-vs-guess rate; *if* it shows
  persistent guessing despite clear purpose, that's evidence to reopen the
  wording (toward "should") — not a license to start there. Not solvable a
  priori; it's the cost P4 buys on purpose.

## What this spec does NOT decide (explicitly out of scope)

- `/sublist` output format alignment with the family-aware landing (formatting,
  not behavior).
- Exact `chainContext` wording (voice established; text deferred to
  implementation).
- In-session zombie RunDir diagnostic format (flagged as a doctor-feature).
- Whether to append a `blocked` field to `meta.json` (not needed: blocked is a
  transient in-memory status, only meaningful while the process is alive; Q9's
  reaper only acts on dead `parentPid`).
