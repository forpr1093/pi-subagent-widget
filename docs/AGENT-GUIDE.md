# AGENT-GUIDE — for agents researching this extension

> **Audience:** an agent (not a human end-user) assigned to research, audit, or
> propose changes to **subagent-widget**. This doc is the **mental model** —
> architecture, behavior, design philosophy, and honest gaps — in one place.
> The [README](../README.md) is the *user reference* (commands, config, syntax).
> The `docs/SPEC-*.md` files are the *decision records* (why each choice was
> locked). You are reading the *synthesis* — read this first, then drill into
> the specs/source only where you need depth.

## 0. What this extension is (one paragraph)

`subagent-widget` is a pi **extension** (auto-discovered from
`~/.pi/agent/extensions/subagent-widget/index.ts`) that lets the main agent
offload work to **background subagents** — each a separate `pi` child process
running its own session — and keeps the user + main agent informed of their
status via stacking TUI widgets, a floating inspector, and terminal follow-up
messages. It also runs **multi-agent chains** (`/subchain` / `orchestrate`)
fire-and-forget, and supports a cooperative **turn-yield** channel (`??`) where
a subagent can pause mid-task to ask the main agent a question. Designed around
**filesystem-native state** (one RunDir per spawn) and a **process-group-kill +
orphan-reaper** lifecycle. Current surface: **4 LLM tools + 9 slash commands.**

## 1. Architecture (the runtime model)

```
                       ┌──────────────────────────────────────────┐
   main agent ──────── │  index.ts  (the orchestrator)            │
   (this process)      │   - `agents: Map<id, SubState>`          │
        │              │   - `chains: Map<id, ChainState>`        │
        │              │   - `spawnAgent()` / `processLine()`     │
        │              │   - close handler (yields followUps)     │
        │              │   - `session_start` handler (reaper)     │
        │              └──────────────┬───────────────────────────┘
        │                             │ spawn (detached child `pi`)
        │                             ▼
        │   ┌──────────────────────────────────────────────────┐
        │   │  child pi process (one per subagent)              │
        │   │   - runs the task under its own session           │
        │   │   - appends events to ~/.pi/agent/runs/<id>/     │
        │   │     session.jsonl  (line-delimited InspectorEvent)│
        │   │   - exits 0 on done, non-zero on error, OR ends   │
        │   │     its final assistant turn with `?? <question>`  │
        │   │     to yield (spec §Q4 — cooperation protocol)    │
        │   └──────────────┬───────────────────────────────────┘
        │                  │ stdout lines (JSON event stream)
        │                  ▼
        │   processLine() parses events → mutates SubState →
        │   updateWidgets() re-renders the TUI box + inspector
        │
        │   close handler fires on proc exit:
        │     - `??` detected  → status=blocked + subagent-request followUp
        │     - exit 0          → status=done    + subagent-result followUp
        │     - exit non-0      → status=error   + subagent-result followUp
        │     - chain step      → onChainStepClose → auto-advance / failChain
        │
        └── followUps (`pi.sendMessage`, `deliverAs: "followUp"`) land back in
            the main agent's conversation as the next user-side message.
```

**Three core ideas to internalize:**

1. **A subagent is a separate OS process**, not a thread / coroutine. Every
   spawn pays ~the cost of starting a fresh `pi` (no inherited conversation
   memory). This is deliberate — full isolation, no shared mutable state — but
   it's the cost-frame that justifies "don't spawn for trivial work" (see
   `~/.pi/agent/AGENTS.md` → Subagent & Orchestration Policy).

2. **State is filesystem-native.** Every spawn gets a RunDir at
   `~/.pi/agent/runs/<id>/` with `prompt.md`, `result.txt`, `session.jsonl`,
   `meta.json`. All read paths (`/subinspect`, widget, `/sublist`, `/subrm`)
   funnel through this dir; `ls` is the discovery primitive. This replaced an
   earlier in-memory + session-file-only model (spec §Q2, §Q6).

3. **Async results via follow-ups.** The main agent's `subagent_create` call
   returns immediately with just the ID. The result comes back later as a
   `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` —
   which lands in the main agent's conversation as a user-side message and
   triggers a new turn. This is the extension's central IPC primitive.

### Files (deeper reference)

| File | Role |
|---|---|
| `index.ts` | Orchestrator: shared `agents`/`chains` maps, spawn/close/continue, all 4 tool + 9 command registrations, `session_start` reaper. ~1900 lines. |
| `inspector.ts` | Floating read-only overlay + event-shaping (`cap`, `stringifyVal`, `appendText`, `buildInspectorLines`, `openInspector`). |
| `widget.ts` | One compact stacked box per active entity. Renders status glyphs. |
| `rundir.ts` | The unified RunDir primitive — `createRunDir`, `writeMeta`/`writePromptFile`/`writeResultFile`, `sessionFilePath`, `readMeta`. All spawn/remove paths go through here. |
| `session.ts` | `makeSessionFile` / `deleteSessionFile` (paths resolved via `rundir.ts`). |
| `agents.ts` | Named-agent discovery (`discoverAgents` from `~/.pi/agent/agents/*.md` + project `.pi/agents/`) + `AgentConfig` schema + spawn-flag overlay. |
| `chains.ts` | Chain-template discovery (`discoverChains` from `~/.pi/agent/chains/*.yaml`). |
| `worktree.ts` | Git worktree isolation per chain / per standalone spawn (spec §12). |
| `config.ts` / `disallow.ts` | Lite-allowed list + full-mode disallow-list (survivor enumeration → `--no-extensions -e <each>`). |
| `types.ts` | `SubState`, `ChainState`, `InspectorEvent`, `SubagentOrigin`. |

## 2. Lifecycle state machine

### `SubState` (one per subagent, in `agents: Map<id, SubState>`)

```
                  spawnAgent()
   (nothing) ─────────────────► pending
                                  │ proc.on("spawn")
                                  ▼
                                running ──────────► blocked   (yielded `??`; spec §Q4)
                                  │   ▲                │
                                  │   └────────────────┘ /subcont answer (re-spawn
                                  │                          with the session file,
                                  │                          preserves mode → back to running)
                                  │ proc.on("close")
                                  ├─ exit 0     → done
                                  ├─ exit non-0 → error
                                  └─ was removed mid-run    → (silently dropped, no followUp)
                                                       │
                                  any terminal state ─┤
                                  + reap at           │ /subrm #N or session_start sweep
                                  next session_start  ▼
                                                   (RunDir removed, SubState pruned)
```

Status glyph legend (widget): `●` running · `⧗` blocked · `✓` done · `✗` error.

### `ChainState` (one per running chain, in `chains: Map<id, ChainState>`)

```
  spawnChain() → running ──► (step i closes OK) ──► advance to step i+1
       │                │                              …
       │                ├─── step yields `??`  ──► error (failChain, spec §Q11d)
       │                ├─── step crashes       ──► error (failChain, terminal followUp)
       │                └─── last step done     ──► done (finalizeChain, aggregate followUp)
       │
       └── `/subrm C1` mid-run ──► aborted (abortChain, aborted flag set
                                              BEFORE kill so close handler
                                              won't auto-advance)
```

**Chains cannot enter `blocked`** — there is no `??` answer route in a pipeline.
A step that wrongly yields is treated as a **failure**, not a wait (spec §Q11d).
The failed step's `SubState` + RunDir are deliberately **left for inspection**
(`subagent-request` is NOT emitted; the failure `chain-result` followUp is terminal; the user uses `/subinspect #N` to see what the step was doing when it
wrongly yielded). It's swept at the next `session_start` regardless.

## 3. Data flow — one spawn, end to end

1. **Invocation.** Main agent calls `subagent_create` tool, OR user types
   `/sub <task>` / `/sublite <task>` / `/sub <agent> <task>`.
2. **State allocation.** `nextId++`, new `SubState` written into `agents`.
3. **RunDir creation** (`rundir.createRunDir`): `~/.pi/agent/runs/<id>/` with
   `prompt.md` (task + identity header if agent-origin, spec §Q10),
   `meta.json` (`{id, origin, parentPid, startedAt, …}` — `pid` written
   post-spawn), empty `session.jsonl`.
4. **Process spawn.** Child `pi` process, **detached** so its process group can
   be killed via `process.kill(-pid, SIGTERM→SIGKILL)` (spec §Q3). Args carry
   session-file path, system-prompt path, worktree (if any), `-e` survivor
   extensions (if full mode), `--no-approve`.
5. **Event streaming.** Child's stdout lines (JSON `InspectorEvent`s) are
   parsed by `processLine()` → mutate `SubState.events` + `widget`/`inspector`
   re-render. `appendText` coalesces text deltas; `cap` bounds tool fields.
6. **Close** (proc exit):
   - `??` detected in the final assistant text → `status="blocked"`, store
     `pendingRequest`, emit `subagent-request` followUp with the question +
     (for user-origin) `Task:` echo. **Process exits** — the worker is gone;
     "blocked" means "the worker finished its turn asking a question and is
     waiting for an answer that will spawn a new worker reusing its session."
   - Normal close → `done`/`error`, emit `subagent-result` followUp (trimmed
     per §Q7; origin-marked + task-echoed per §Q7-supplement if user-origin).
7. **Continue** (`/subcont` / `subagent_continue`): spawns a new child `pi`
   pointing at the existing `session.jsonl` (resumes the conversation).
   Preserves lite/full mode, agent role, and `origin`.

## 4. The cooperation model (`??` yield channel, spec §Q4–Q7)

The single genuinely novel primitive. A standalone subagent (NOT a chain step)
can end its assistant turn with a line beginning `??` to **pause mid-task and
ask the main agent a question** rather than guess.

- **Detection.** The close handler scans the subagent's final assistant text
  for a `??` line. The format is `?? <question>`.
- **Follow-up.** Emits `customType: "subagent-request"`, content shaped like:
  ```
  [Subagent #N · user-spawned] blocked, asking:
  Task: <state.task, capped ~300 chars>
  <question>
  ```
  (`· user-spawned` marker + `Task:` echo only for user-origin; agent-origin
  spawns keep the bare header since the agent already knows the task it
  assigned — spec §Q7-supplement.)
- **Resume.** `/subcont #N <answer>` (user) or `subagent_continue` (agent)
  spawns a fresh worker reusing the session file, with your answer injected.
  The worker continues to completion (or yields again).
- **Identity prompt (§Q10).** Agent-origin spawns get a purpose-revealing
  header in `prompt.md` — *"You are a background subagent spawned by the main
  agent. You are NOT the main agent. … If you need a decision you can't make,
  end your turn with `?? <question>` and wait."* This is **honest about the
  subagent's position**, not role-forcing. Written to `prompt.md` so it
  survives across `/subcont` turns.
- **Chains can't use `??`.** The answer channel has no route in a pipeline
  (the chain auto-advances on close, not waits). A step that yields is treated
  as a chain failure (§Q11d) — terminal `chain-result` followUp, no
  `subagent-request`, never hangs. The failed step + its RunDir persist for
  `/subinspect #N` and are swept at the next `session_start`.

## 5. Surface (4 LLM tools + 9 slash commands)

Authoritative lists live in [README §Commands](../README.md#commands) and
[README §The 4 LLM tools](../README.md#the-4-llm-tools-spec-q6). Recap:

**LLM tools** (the main agent calls these): `subagent_create`,
`subagent_continue`, `subagent_remove`, `orchestrate`. (~Q6 collapse: was 8,
cut `subagent_catalog`/`_list`/`_inspect`/`_build` in favor of filesystem-
native discovery + the `/sub` no-arg landing.)

**Slash commands** (user types): `/sub` (no-arg = family landing),
`/sub <task>`, `/sublite <task>`, `/subcont <id> <prompt>`, `/subrm`, `/subclear`,
`/subinspect`, `/sublist`, `/subchain <template> [input]`, `/sub doctor`.

**Origin tagging.** Every spawn records `origin: "user" | "agent"` in
`meta.json` (and `ChainState`). User-origin follow-ups carry a `· user-spawned`
marker + a `Task:`/`Input:` echo; agent-origin follow-ups stay bare. This is
so the main agent can tell whether a follow-up came from something *it*
spawned (knows the task) or from something the *user* spawned (no context).

## 6. Storage (RunDir)

`~/.pi/agent/runs/<id>/` per spawn:

| File | Contents |
|---|---|
| `prompt.md` | Task prompt (+ identity header for agent-origin). |
| `result.txt` | Final result body, spilled here when >8KB. |
| `session.jsonl` | Full conversation transcript; inspector + `/subcont` source of truth. |
| `meta.json` | `{id, origin, parentPid, pid, startedAt, …}` — the reaper's locals. |

**Cleanup timing:**
- **Deleted on** `/subrm`, `/subclear`, `subagent_remove`, or after a
  natural-completion follow-up is delivered.
- **Orphan reaper (§Q9):** on every `session_start`, `runs/` is swept. Any
  dir whose `meta.json` `parentPid` is no longer alive (parent `pi` crashed)
  → process-group-kill via `meta.json` `pid` (§Q3) → dir removed.
- **In-session zombies** (blocked or running but pid-dead, with a live
  parentPid) → **reported** by `/sub doctor`, NOT auto-reaped. The user
  removes them deliberately via `/subrm #N`. Reason: an in-session zombie
  might still be being inspected; let the user decide.

## 7. Design philosophy (the locked principles)

These are the load-bearing design choices. Any improvement proposal should
either honor them or explicitly argue for replacing them.

1. **Filesystem-native state over in-memory registries** (§Q2, §Q6). State
   lives on disk (RunDir + session.jsonl). `ls` is the discovery primitive.
   `subagent_catalog`/`_list`/`_inspect`/`_build` tools were **removed** in
   the Q6 collapse — the agent reads the filesystem directly instead.
2. **Process isolation over shared-memory concurrency.** A subagent is a
   separate OS process (detached child `pi`). Cost: ~a fresh `pi` start per
   spawn. Benefit: full isolation; no shared mutable state; crash containment
   (orphan reaper). This is the **cost-frame** that justifies "don't spawn
   for trivial work" — see `~/.pi/agent/AGENTS.md` → Subagent & Orchestration
   Policy.
3. **Async-by-default.** Every spawn returns the ID immediately; results
   arrive via `followUp`. The main agent can stop its turn, do other work, or
   spawn parallel siblings while a subagent runs.
4. **Cooperation as opt-in, not coercion.** The `??` channel lets a subagent
   pause to ask — but the identity prompt (§Q10) is **purpose-revealing, not
   role-forcing**. The subagent knows it's a subagent and what it was asked
   to do; it's not told to pretend it's the main agent.
5. **Chains don't ask.** A pipeline step has no answer route. If it needs
   input, it should have been a standalone subagent the main agent manages
   (§Q11d). This is a deliberate constraint, not a bug — it keeps chains
   fire-and-forget.
6. **Honest failure over silent hang.** Q11d's detect-and-fail; Q9's reaper
   over stale-zombie accumulation; the "leave the failed step for inspection"
   choice over eager reaping. Failures surface; nothing hangs silently.
7. **Surgical surface.** 8 LLM tools → 4 (§Q6). Each tool description carries
   a filesystem pointer so the agent can self-serve inspection.

## 8. Known gaps + honest limitations (NOT in the README)

This is the section a research agent will care most about. Honest, not
marketing:

### Verified gaps (in the implementation itself)

- **No live-LLM smoke test of the `blocked` path.** All verification of the
  `??` yield → `blocked` status → `subagent-request` followUp → `/subcont`
  resume cycle was done with a **scripted fake `pi`** (functional simulation).
  The end-to-end flow with a real LLM driving the yield has not been
  eyeballed in a real pi session. Specifically unverified against real
  pixels/timeouts: the `⧗` blocked glyph rendering in the live TUI, the
  follow-up surfacing to the actual end-user (vs the LLM picking it up).
- **Chain step yield → failChain is the only chain block path.** A model
  that's been told "don't ask if you can avoid it" but asks anyway loses the
  run. No "promote the step to standalone subagent + ask the user, then
  resume the chain" recovery exists — by design, but limits resilience.
- **Child `pi` args don't forward parent's CLI `-e` extensions** (only the
  discovered set + survivors). Documented in the README's disallow-list
  "Scope & limits" section.
- **Discovery over-inclusion (never drops):** the disallow-list enumeration
  doesn't replicate pi's root-self-checks / `.gitignore` / dotfile /
  `node_modules` skips, so a stray `node_modules/` in an auto-discovery dir
  could cause the child to load an `extra` extension (not lose one). Doc'd
  in README.

### Architectural limitations (by design, but worth re-examining)

- **No planning phase.** Compare Factory.ai Missions: their flow is
  `collaborative plan → milestones → execute`. This extension has no
  upfront planning — a chain's "plan" is whatever the user/main-agent wrote
  in the YAML template or inline steps, in one shot.
- **No progress dashboard.** Stacked widgets show per-step status, but
  there's no Mission-Control-style view of "feature X is at milestone 3 of 5,
  self-QA passed." For long chains this is hard to glance at.
- **No self-QA / self-correction.** No worker step that runs the user's app
  + tests to verify the previous step's output. Missions pins this as a
  core primitive ("runs user-facing QA testing … to validate each feature
  and self-correct as it goes").
- **No skill-aware execution.** Named agents exist (`~/.pi/agent/agents/*.md`)
  but are static roles; Missions develops new specialized skills per
  milestone on the fly.
- **`??` is a one-question-at-a-time channel.** A blocked subagent asks
  exactly one question; there's no structured "I need three decisions"
  protocol.
- **No parallelism within a chain.** Chain steps run sequentially by design
  (`{previous}` splices step N's output into step N+1's prompt). Parallel
  sibling chains exist (run multiple `/subchain`), but no fan-out
  /gather primitive.
- **No worktree-branch merge helper.** Isolation creates branches but
  there's no first-class `/submerge C1 #N` to merge a chain's branch back
  to the parent repo. Left to the user's git.

### UX gaps

- **The `## Feature 2 (disallow-list — implemented)` heading in the README**
  is leftover WIP-notes style (was never cleaned up). Cosmetic but
  noticeable.
- **`/sub` no-arg landing is a flat text list.** No interactive picker (the
  `/subchain` no-arg picker only covers templates).
- **`/sub doctor` is read-only-ish** — it sweeps orphans (mutating) and
  reports zombies, but offers no `--fix` to auto-reap in-session zombies.
  By design (user-decides), but feels half-finished.
- **No way to retry a failed chain step in isolation** (promote to a
  standalone subagent the main agent can drive). Currently you read the
  inspector, then re-write the task as a fresh `/sub`.

## 9. Future direction (the user's aspiration)

The user wants the extension to evolve toward something like **Factory.ai
Missions** (https://docs.factory.ai/features/missions/overview) — but
**deliberately not as bloated**. Missions' core pillars:

1. **Collaborative planning** upfront (features + milestones + success
   criteria), negotiated with the user before any code.
2. **Skill-aware execution** — leverage existing skills, develop new
   specialized skills per milestone.
3. **Structured orchestration** — a Mission Control view that tracks each
   feature's progress through milestones and lets the user intervene.
4. **Self-QA** — the orchestrator runs user-facing tests against the running
   app to validate each feature, self-correcting as it goes.
5. **Config carries over** — MCP / skills / hooks / custom droids work
   inside Missions.

Factory themselves call Missions a "research preview" and list open
questions worth borrowing: *is parallelization necessary? how do you
maximize correctness in long-running plans? cost vs. quality tradeoffs —
how aggressive should the orchestrator be?*

**"Not too bloated"** means: the user does NOT want to clone all of Factory
Missions. They want the high-value bits — likely (1) planning phase + (3)
progress visibility + (4) self-QA — added without the enterprise surface
(MCP, custom droids, agent-readiness levels, headless/enterprise policy menus).

A research agent's job is to figure out **which** of Missions' pillars are
worth porting, **how** to fit them into the existing architecture (§1) without
breaking the locked principles (§7), and **what to deliberately not do.**

## 10. Pointers — deeper reading

- **Source:** `~/.pi/agent/extensions/subagent-widget/index.ts` (~1900 lines —
  the orchestrator; everything wires through here).
- **Locked spec (revamp):** [`docs/SPEC-revamp.md`](./SPEC-revamp.md) —
  the Q1–Q12 decisions (RunDir, process-group kill, orphan reaper, `??`
  channel, blocked status, 4-tool collapse, `/sub doctor`, identity prompt,
  chain detect-and-fail).
- **Audit:** [`docs/REVIEW-revamp.md`](./REVIEW-revamp.md) — the
  SATISFIES/PARTIAL findings + locked-constraint pass sheet.
- **Orchestration spec:** [`docs/SPEC-orchestration.md`](./SPEC-orchestration.md) —
  the deeper decisions on chains + worktree (§11 research, §12 worktree).
- **Inspector spec:** [`docs/SPEC-inspector.md`](./SPEC-inspector.md) — the
  inspector's dataset model + scroll behavior + optional spec.
- **User reference:** [`../README.md`](../README.md) — commands + config knobs.
- **Global agent instructions:** `~/.pi/agent/AGENTS.md` → Subagent &
  Orchestration Policy (the inline-vs-offload cost-frame).

---

**Reading order suggested for a research agent:** this doc (§0–§9) → skim the
README → skim `SPEC-revamp.md` to confirm locked decisions → read the close
handler + `spawnAgent` in `index.ts` to verify the model → propose.
