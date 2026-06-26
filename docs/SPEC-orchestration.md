# SPEC — Orchestration (named agents, chains, multi-agent workflows)

Status: **design locked** (grilling Q1–Q20; post-research adoptions Q21–Q24). This is the implementation contract.

Scope: extend the existing `subagent-widget` extension with named, customizable
agents and auto-advancing linear chains (template- or inline-defined). The
existing anonymous-subagent surface (`subagent_create(task, lite)`, `/sub`,
`/sublite`, …) stays **byte-for-byte unchanged**; orchestration is strictly
additive on top of the same `spawnAgent` subprocess machinery.

See also: `../README.md`, `SPEC-inspector.md` (sibling).

---

## 1. Decision log (24 locked)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Extend `subagent-widget`**, not a new extension | Reuses spawn/stream/widget/inspector/session machinery; two extensions would fight over widget IDs, `nextId`, `agents` map, `session_start` cleanup. |
| 2 | **Orchestrator-brokered routing** (hub-and-spoke) | Subagents never spawn siblings; the extension/main-agent brokers every A→B transfer. Keeps the recursion guard (`DEFAULT_DISALLOWED_EXT`) intact, keeps a flat `agents` map. |
| 3 | **Auto-advance chains** (no per-hop main-agent turn) | Predefined chains run to completion; main agent gets one turn at the end. Per-hop waking converges to on-demand custom → defeats the point of a saved template. |
| 4 | **Three trigger modes**: (a) orchestrator-in-loop, (b) LLM-declared/template chain, (c) user/template chain | (a) is just sequential existing-tool calls; (b)+(c) share one executor, differ only in trigger source. |
| 5 | **Fire-and-forget + follow-up** | Consistent with existing widget semantics; main agent not frozen for minutes; monitoring already covered by inspector + stacked widget. |
| 6 | **Agent-defs at `~/.pi/agent/agents/*.md`** + opt-in `.pi/agents/` (scope-gated) | Matches the stock `subagent` example's convention and pi's config-dir layout (`themes/`, `skills/`). pi core does NOT natively load this dir — the extension reads it. |
| 7 | **Per-agent `extensions`/`skills` are additive** (never trigger `--no-extensions`) | Neuralwatt structurally cannot be dropped (always part of the mode base). Strict-allowlist per-agent extensions is the only path that could break the provider — rejected. |
| 8 | **Chains reference named agents only** (no inline agent specs) | Agents are the reusable unit; chains are thin flows. One source of truth per agent. LLM picks named agents in sequence — reliable. |
| 9 | **Linear-only chains** | Fan-out/join is the orchestrator's job (mode 1) for free; a DAG executor would duplicate it. |
| 10 | **N ordinary SubStates + a thin coordinator** per chain (NOT a composite chain-state) | Reuses widget/inspector/session/`/subrm`/`/subcont` unchanged; only addressability needed per-step for keep/rm. |
| 11 | **Placeholders `{previous}` + `{input}`** | Stock-example-compatible; two placeholders cover every linear pipeline. Non-contiguous refs are expressed by threading context through each step's output. |
| 12 | **Provenance envelope** wrapped around every `{previous}` splice | Next agent knows who produced the handoff + chain context. Plus template-author prose for the richer "what scout did" framing. |
| 13 | **Agent-def schema**: comma-string list fields, `model:`thinking`` suffix | Stock `.md` files load unmodified; `parseFrontmatter` reused. |
| 14 | **Inverse semantics**: `extensions`/`skills` additive-expanders; `tools` allowlist-restrictor | Symmetric, unambiguous spawn-flag construction. `tools: none` deferred. |
| 15 | **YAML templates at `~/.pi/agent/chains/*.yaml`** (+ opt-in `.pi/chains/`), shared executor for LLM+user, 8/4 multi-chain limits, `/subchain` picker in scope, `template`>`steps` on conflict | Parallel to agent-defs; stock `ChainItem`-compatible `steps`. |
| 16 | **`/subchain` CLI-compose** from named agents (`agent "task" | agent "task" | …`) | On-demand user chains without a saved template; same executor as templates; consistent with references-only (Q8). |
| 17 | **Chain IDs `C1/C2/…`** (separate from `#N` subagent IDs); chain-level inspect-list + remove-whole; `/subrm` on a live-chain step guarded; instruct = post-completion `/subcont` on last step only | Parallel chains need addressable identity for humans + the LLM. |
| 18 | **Halt-on-failure** at the failing step; no auto-advance; completed prior steps persist for inspection; coordinator does no retry | Stock-example behavior; recovery is the main agent's job (mode 1). | 
| 19 | **Abort propagation**: sibling isolation on `/subrm C`; `aborted` flag guards auto-advance + emits one aborted-summary follow-up; Ctrl+C unchanged (no new propagation); `session_start` clears chains | Event-driven coordinator must distinguish aborted from completed-failed. |
| 20 | **`subagent_catalog` lookup tool** + one-line nudge in `orchestrate` description; NO roster injection; skip `/subagents` command for v1 | O(1) tokens regardless of agent count; fresh-by-construction (reads dirs on call); amortized one round-trip inside a heavyweight orchestration. |

### Post-research adoptions (surveyed 6 frameworks + 4 pi repos; see §11)

| # | Decision | Rationale |
|---|---|---|
| 21 | **`disallowedTools` field** (deny-first via pi's `--exclude-tools`), then `tools` allowlist-resolved | Claude Code + QuintinShaw pattern; ergonomics for "inherit all except Edit". **Orthogonal** to the additive-extensions invariant — operates on the *tool* axis, never the extension/provider axis, so neuralwatt model resolution stays structurally safe. |
| 22 | **`/subchain-doctor` diagnostic command** | Read-only report of resolved agent/chain dirs, discovery counts, sample agent resolution, extensions survival. Trivial to build, huge for "why didn't my agent load?". |
| 23 | **Forward-compatible envelope seam** | The `{previous}` provenance envelope is a single string today; a later step could append a fenced YAML/JSON block inside it as a structured payload without breaking existing templates. No v1 code change — recorded so we don't paint into a corner. |
| 24 | **Research findings appendix (§11)** | Records DEFER/REJECT verdicts on framework/repo ideas with one-line rationale + revisit triggers, so the spec stays self-defending and we don't relitigate. |

---

## 2. Architecture

Three layers, all in the existing extension. Existing surface is the foundation;
orchestration sits on top of the same `spawnAgent`.

```
┌─ Layer 3: orchestration (NEW) ───────────────────────────────────────┐
│  agent-defs + chain-templates (discovery)                             │
│  coordinator (sequential spawns, {previous} subst, provenance, halt) │
│  tools: orchestrate, subagent_catalog                                 │
│  commands: /subchain, /sublist, chain-aware /subinspect /subrm        │
├─ Layer 2: existing subagent-widget (UNCHANGED) ─────────────────────┤
│  spawnAgent(state, prompt, ctx, lite)  — the seam                     │
│  processLine, updateWidgets, inspector, JSONL sessions                │
│  SubState, agents map, widgetCtx, session_start handler               │
│  tools: subagent_create/continue/remove/list/inspect                   │
│  commands: /sub /sublite /subcont /subrm /subclear /subinspect        │
├─ Layer 1: pi subprocess + JSON mode (UNCHANGED) ────────────────────┤
│  `pi --mode json -p --session <file> [--model M] [--tools T] ...`    │
└──────────────────────────────────────────────────────────────────────┘
```

**The seam** is `spawnAgent(state, prompt, ctx, lite)`. Orchestration extends it
to accept a full agent-config (system prompt, model, extensions, skills, tools)
and adds a coordinator that calls it N times with `{previous}` substitution.
No existing call site changes.

---

## 3. Agent definitions

### 3.1 Location & discovery

- User-level: `~/.pi/agent/agents/*.md` (always loaded).
- Project-level: `.pi/agents/*.md` (only with `agentScope: "both"` or `"project"`).
- Project agents override user agents with the same `name` when `agentScope: "both"`.
- **Security parity with the stock example**: project-local agents are repo-controlled
  prompts that can instruct bash/file access. Confirm before running project agents
  (reuse the existing `confirmProjectAgents` pattern; default `true`).
- Discovered fresh on every spawn (matches the widget's existing pattern for
  `config.json` / disallow-list — no `/reload` needed).

Implementation: port the stock example's `agents.ts`
(`loadAgentsFromDir`, `findNearestProjectAgentsDir`, `discoverAgents`,
`formatAgentList`, `parseFrontmatter`). The names dir resolves via `getAgentDir()`
from `@mariozechner/pi-coding-agent` (= `~/.pi/agent/` + `agents`).

### 3.2 Schema (markdown + YAML frontmatter)

```markdown
---
name: scout                                    # required → display + chain ref
description: Fast codebase recon               # required → routing hint + widget
tools: read, grep, find, ls, bash              # optional → --tools (comma string)
model: neuralwatt/kimi-k2.7-code:high          # optional → --model (supports :thinking)
extensions: npm:pi-neuralwatt-provider, @upstash/context7-pi   # optional → -e (additive, NEW)
skills: ~/.pi/agent/skills/grilling            # optional → --skill (additive, NEW)
disallowedTools: edit, write                   # optional → --exclude-tools (deny-first, NEW)
---
System prompt body. Optional — empty body = pi's default assistant prompt (appended via --append-system-prompt, gated by .trim()).
```

- All list fields are comma-separated strings, parsed by `split(",").map(trim)`,
  matching the stock example's `parseFrontmatter` usage. Stock `.md` files
  (`scout.md`, `planner.md`, `worker.md`, `reviewer.md`) load unmodified.
- `model` accepts pi's `provider/id:thinking` form.
- `tools` (allowlist) and `disallowedTools` (denylist) may both be set;
  apply deny-first, then allowlist-resolved. See §3.3.

### 3.3 Spawn-flag construction (additive / inverse semantics)

For a step using agent-def `a` in mode `lite`:

| Field | When present | When absent |
|---|---|---|
| `extensions` | append `-e <each>` (additive to mode base) | mode base only |
| `skills` | append `--skill <each>` (additive; **replaces** lite's `--no-skills`) | mode's skills policy |
| `tools` | append `--tools <list>` (**allowlist**; restricts to listed set) | full toolset inherited |
| `disallowedTools` | append `--exclude-tools <list>` (**denylist**; applied first, then allowlist-resolved) | none removed beyond the mode set |
| `model` | append `--model <value>` | global default (`neuralwatt/glm-5.2-short`) |

Always first: load the mode's base extensions/skills (full discovery incl. the
survivor list from `disallow.ts`, or lite allow-list). **Neuralwatt always
survives by construction** — it is part of every mode base and `extensions` only
ever adds.

**Tool axis vs extension/provider axis (important):** `tools`/`disallowedTools`
operate only on the *tool* axis (built-in/extension/custom tools surfaced to the
LLM). They **cannot** drop the neuralwatt *provider* (model resolution) — that is
extension-level, governed by the additive `extensions` rule (Q7). So a user could
use `disallowedTools` to exclude a neuralwatt-registered *tool* (if one exists),
but `--model neuralwatt/...` still resolves. The provider guarantee is untouched.

`systemPrompt` body → write to a temp file (reuse the stock example's
`writePromptToTempFile`), append `--append-system-prompt <file>` (guarded by
`body.trim()`), clean up in `finally`.

### 3.4 Neuralwatt guarantee (verified)

Empirically verified: `pi --no-extensions -e npm:pi-neuralwatt-provider
--list-models` resolves all neuralwatt models (the provider self-registers via
`pi.registerProvider("neuralwatt", makeProviderConfig())` and ships `models.json`
baked in — no dependency on `settings.json packages`). So loading it through
`-e` alone is sufficient in both lite and full spawn paths. The additive rule
guarantees it is never omitted.

---

## 4. Chain templates

### 4.1 Location & discovery

- User-level: `~/.pi/agent/chains/*.yaml` (+ `.yml`).
- Project-level: `.pi/chains/*.yaml` (only with `chainScope: "both"` or `"project"`,
  same security gate as agents).
- Project overrides user by `name`.
- Discovered fresh on each `subagent_catalog` call and each spawn.

### 4.2 Schema (YAML frontmatter + body)

```yaml
---
name: implement-and-review
description: scout → planner → worker → reviewer. End-to-end implementation with QA.
steps:
  - agent: scout
    task: "Investigate the request: {input}"
  - agent: planner
    task: |
      The scout agent has completed recon. Its findings:

      {previous}

      Based on the above, produce an implementation plan.
  - agent: worker
    task: |
      The planner agent has produced a plan. Implement it:

      {previous}
  - agent: reviewer
    task: |
      Review the worker's implementation against the plan:

      {previous}
---
# body optional — template-level system nudge
You are operating inside a multi-step chain. Be thorough.
```

- `steps: [{agent, task}]` mirrors the stock `subagent` example's `ChainItem`
  exactly — portable, no new shape.
- Each `agent` must resolve in the discovered agent set (references only — Q8);
  if not, the spawn errors with `Unknown agent "reviewer". Available: …`.
- `task` may contain `{previous}` (prior step's final text, wrapped in the
  provenance envelope) and `{input}` (the chain trigger input).

### 4.3 Placeholder substitution + provenance envelope

When the coordinator spawns step *i+1*, it substitutes `task`:

```js
const handoff = `[Handoff from agent: ${prevAgentName}]\n[Context: step ${i+1} of ${total} in chain "${chainName}"]\n\n${prevFinalText}`;
const task = step.task.replaceAll("{previous}", handoff).replaceAll("{input}", chainInput);
```

Template-author prose (e.g. "The scout agent has completed recon") provides the
richer "what the prior agent did" framing; the envelope guarantees provenance
even when the author omits it.

**Forward-compatible seam (Q23):** the envelope is a single plain string today.
A later step could append a fenced YAML or JSON block *inside* the envelope
(e.g. a triple-backtick-fenced `yaml` block carrying a structured plan) without
breaking existing templates — the next agent reads it as part of the `{previous}`
text. No v1 code change; recorded so a future structured-handoff need doesn't
require a new field or a breaking change to the envelope format.

### 4.4 On-demand CLI composition (`/subchain`, no template)

User spells out a sequence of *existing* agent names + per-step tasks:

```
/subchain scout "Investigate: {input}" | reviewer "Review: {previous}" | worker "Implement: {previous}"
```

- `|` separates steps (shell-safe, visually distinct from `;`).
- Each segment: `agent "task"` (agent name resolves in the discovered set).
- `{input}` defaults to empty unless the command provides a trailing input
  (the first step's task IS the entry point for one-liners).
- Same executor + coordinator + widget as a saved template — only the `steps`
  source differs.
- No inline agent specs (consistent with Q8). Unknown agent → error.

Parser: ~30 lines, splits on `|` at the top level (not inside quotes), then
parses each segment as `agent rest-is-the-task`. Use a simple state machine
respecting double-quoted strings.

---

## 5. Tool surfaces

### 5.1 Preserved (Mode 1 — zero new tools)

| Tool | Params | Notes |
|---|---|---|
| `subagent_create` | `task`, `lite` | **Unchanged.** Spawn an unnamed full/lite subagent. Description gets a one-line nudge: "to orchestrate multi-agent workflows use `orchestrate`; to discover defined agents/templates use `subagent_catalog`." |
| `subagent_continue` | `id`, `prompt` | Unchanged. |
| `subagent_remove` | `id` | Extended: accepts `#N` or `CN`. `CN` → remove whole chain (Q16). `#N` where N is a live-chain step → guarded. |
| `subagent_list` | — | Extended: includes a chains section (`C1 implement-and-review · step 2/4 · planner ⏳`). |
| `subagent_inspect` | `id` | Extended: accepts `#N` (existing per-step inspector) or `CN` (chain view = list of steps; drill into a step → existing inspector). |

Mode 1 *is* the main agent calling these sequentially, reading follow-ups,
deciding the next call — exactly as today. The only change is documentation.

### 5.2 New — `orchestrate` (Mode 2, LLM auto-advance chain)

```ts
orchestrate({
  template?: string,   // named chain to resolve from ~/.pi/agent/chains/
  steps?:   Array<{agent: string, task: string}>,  // inline LLM-authored (refs only)
  chains?:  Array<{template?: string, steps?: Array<{agent, task}>}>,  // multi-chain
  input?:   string,    // {input} substitution value
  lite?:    boolean,   // default false; applies to every step in the chain(s)
})
```

- Exactly one of `template` / `steps` / `chains` set (else error).
- `template` > `steps` if both (Q15).
- `steps` items reference named agents only; unknown agent → error with the
  available list.
- Returns immediately with `"Chain C1 spawned (3 steps)."` — fire-and-forget (Q5).
  Final result delivered via follow-up when the chain completes/halts.
- Description: one-line nudge — "Agents & templates are discoverable via
  `subagent_catalog`; call it before authoring `steps` or using `template`."
  **No roster injection** (Q20).

### 5.3 New — `subagent_catalog` (LLM discovery, Q20)

```ts
subagent_catalog({ scope?: "user" | "project" | "both" })  // default "user"
```

Returns (as tool result text):

```
## Agents (user)
- scout: Fast codebase recon
- planner: Implementation plans
- worker: General-purpose
- reviewer: Code review

## Chains (user)
- implement-and-review: scout → planner → worker → reviewer
- scout-and-plan: scout → planner
```

- Name + description only (no system prompts / tool lists / step details).
- Reads `~/.pi/agent/agents/*.md` + `~/.pi/agent/chains/*.yaml` fresh on each call.
- Human parallel = `ls ~/.pi/agent/agents/` (no `/subagents` command in v1).

---

## 6. Command surfaces

### 6.1 Preserved (unchanged)

`/sub`, `/sublite`, `/subcont`, `/subrm` (with `#N`), `/subclear`, `/subinspect` (with `#N`).

### 6.2 New / extended

| Command | Purpose |
|---|---|
| `/subchain <template-name> [input]` | run a named template |
| `/subchain scout "task" \| reviewer "task" \| worker "task"` | compose on-demand (Q16) |
| `/subchain` (no args) | picker of available templates (`ctx.ui.select`) |
| `/subinspect C1` | list C1's steps; drill into a step's existing inspector |
| `/subinspect C1@2` (or pick from the list) | inspect a specific step of C1 |
| `/subrm C1` | kill any running step + remove whole chain |
| `/subrm C1@2` | remove a specific step (only if the chain is done; guarded if live) |
| `/sublist` | list subagents (`#N`) + chains (`Ck · step j/N · agent ⏳`) |
| `/subchain-doctor` | read-only diagnostics: resolved agent/chain dirs, discovery counts, sample agent resolution, extensions survival (Q22) |

`/subchain` with no args requires TUI; in print/json mode fall back to
`Usage: /subchain <template-name> [input]` or `… agent "task" | …`.

---

## 7. Coordinator execution contract

The coordinator is a thin object stored in a new `chains: Map<number, ChainState>`.
It does NOT render (Q10 — N ordinary SubStates render themselves) and does NOT
own a session file (each step does).

### 7.1 `ChainState`

```ts
interface ChainState {
  id: number;                    // C1, C2, …
  name: string;                 // template name, or "inline" for /subchain compose
  steps: ChainStepDef[];        // resolved [{agent, task}] (references resolved)
  // stepAgentNames is NOT a stored field — derived from steps[].agent on demand
  // (each step already carries its agent name; a parallel array would drift).
  input: string;                 // {input} substitution value
  currentIndex: number;          // 0-based; -1 = not started, steps.length = done
  status: "running" | "done" | "error" | "aborted";
  lite: boolean;                 // mode applied to every step
  aborted: boolean;              // Q19 — set BEFORE killing the running step
  subagentIds: number[];         // the #N SubStates this chain has spawned
}
```

### 7.2 Advance loop (auto-advance, Q3)

```
spawnChain(chain):
  state = new ChainState(...)
  chains.set(state.id, state)
  spawnStep(state, 0)

spawnStep(state, i):
  if state.aborted: return                          // Q19 guard
  if i >= state.steps.length:
    finalizeChain(state, lastStepOutput)            // emit final follow-up
    return
  state.currentIndex = i
  step = state.steps[i]
  prevOutput = i > 0 ? getFinalOutput(prevStepState.messages) : ""
  handoff = provenanceEnvelope(prevAgentName, i, state) + prevOutput    // Q12, only if i>0
  task = step.task.replaceAll("{previous}", handoff).replaceAll("{input}", state.input)
  // Resolve the named agent → AgentConfig, build spawn args (additive, Q7/Q14)
  sub = spawnAgent(agentState, task, ctx, state.lite, agentConfig)      // EXTENDED spawnAgent
  state.subagentIds.push(sub.id)
  // On step close (in the existing close handler, branched by chainId):
  onStepClose(sub, state):
    if state.aborted: return                        // Q19 — don't advance, no follow-up
    if sub failed (exit!=0 | stopReason error | aborted):
      state.status = "error"
      sendFollowUp(`Chain C${id} failed at step ${i+1} (${agentName}): ${err}. Completed: ${doneList}.`)  // Q18
      return
    if i == steps.length - 1:
      finalizeChain(state, getFinalOutput(sub.messages))
    else:
      spawnStep(state, i+1)                          // AUTO-ADVANCE (Q3)
```

`finalizeChain` sends one follow-up:
```
Chain C1 "implement-and-review" complete (4/4 steps).
Final result (worker):
<final step output, capped>
Per-step: scout ✓ (12s, 3 tools), planner ✓ (8s, 1 tool), worker ✓ (45s, 7 tools), reviewer ✓ (6s, 0 tools).
```

### 7.3 Follow-up suppression (Q5)

Intermediate steps do NOT send the existing per-subagent `followUp`. Only:
- the **final** step's `followUp` (chain complete), and
- the single **failure** / **aborted** `followUp` (Q18/Q19).

Implemented by a `chainId` field on `SubState`: when set, the existing
`pi.sendMessage(... {deliverAs:"followUp", triggerTurn:true})` in the step's
close handler is suppressed; the coordinator emits the aggregate follow-up
instead. A standalone subagent (`chainId == null`) keeps today's behavior.

### 7.4 `spawnAgent` extension (the seam change)

Today: `spawnAgent(state, prompt, ctx, lite)`. Extend to:

```ts
spawnAgent(state, prompt, ctx, lite, agentConfig?: AgentConfig)
```

`agentConfig` (optional — null = today's behavior, used for `subagent_create`):
- builds the CLI args from the agent-def fields per §3.3 (additive extensions/skills,
  allowlist tools, model, system-prompt temp file).
- The mode's base flags (full discovery vs. lite allow-list) are constructed as
  today; `agentConfig` fields only ever append.

All existing call sites pass no `agentConfig` → behavior unchanged.

---

## 8. Failure & abort semantics

### 8.1 Failure (Q18)

- Halt at the failing step; no auto-advance.
- Failing step's SubState records `status:"error"` + error text (existing).
- Completed prior steps **persist** (not auto-removed) — `agents` map keeps them,
  JSONL sessions kept, `/subinspect` works on them.
- One failure follow-up naming the failing step + listing completed steps.
- No coordinator-side retry. Recovery = main agent (mode 1): `subagent_continue`
  the failed step, re-`orchestrate`, or abandon.

### 8.2 Abort (Q19)

| Trigger | What dies | Siblings | auto-advance? | Follow-up |
|---|---|---|---|---|
| `/subrm C1` / `subagent_remove({id:"C1"})` | C1's running step (SIGTERM) | untouched | no (`aborted` flag) | one aborted-summary |
| `/subrm #N` where N is a live-chain step | **guarded**: "step #N is in live chain C1; use `/subrm C1`" | — | — | — |
| Ctrl+C (main TUI) | nothing new (Q19) | untouched | n/a | n/a |
| `session_start` | all chains + all subagents killed + cleared | — | — | — |

`aborted` flag is set **before** SIGTERM so the step's `close` handler sees it
and skips auto-advance + skips the complete follow-up, emitting the single
aborted summary instead.

### 8.3 `session_start` lifecycle (extended, Q19)

Existing handler already kills running subagents + clears `agents` + resets
`nextId`. Extend to also: kill running chain steps, clear the `chains` map,
reset `nextChainId`. New session = clean slate, no orphans.

---

## 9. Implementation plan (ordered, with verification)

Files use the existing widget's import style: `@mariozechner/pi-coding-agent`
(alias shim) for pi APIs + `@sinclair/typebox` for schemas. Available exports
confirmed: `getAgentDir`, `CONFIG_DIR_NAME`, `parseFrontmatter`, `getMarkdownTheme`,
`DynamicBorder`.

### Phase 1 — Agent definitions (§3)
1. Create `agents.ts` — port the stock example's discovery (`loadAgentsFromDir`,
   `findNearestProjectAgentsDir`, `discoverAgents`, `formatAgentList`). Reuse
   `getAgentDir()` + `parseFrontmatter`.
   → verify: `discoverAgents(cwd, "user")` returns the agent list from
   `~/.pi/agent/agents/*.md`; create a sample `scout.md` and confirm.
2. Extend `spawnAgent` to accept an optional `agentConfig` and build CLI args
   per §3.3. Keep all existing call sites passing `undefined`.
   → verify: `/sub "test"` still works byte-for-byte (no agentConfig);
   a test spawn with a `scout` agentConfig loads neuralwatt + its tools/model.
3. Add `subagent_catalog` tool (§5.3) reading the agents dir fresh.
   → verify: LLM-invoked `subagent_catalog({})` returns name+description list.

### Phase 2 — Chain templates (§4)
4. Create `chains.ts` — template discovery + YAML frontmatter parse
   (`loadChainsFromDir`, `discoverChains`, mirroring `agents.ts`). Use a YAML
   parser already in pi's deps (check `js-yaml` availability; fallback to a
   minimal frontmatter+steps parse if not present).
   → verify: `discoverChains(cwd, "user")` returns templates from
   `~/.pi/agent/chains/*.yaml`.
5. Create `coordinator.ts` — `spawnChain`, `spawnStep`, the advance loop,
   provenance envelope (§4.3), follow-up suppression (§7.3), `ChainState`.
   → verify: a 2-step saved template runs end-to-end; final follow-up arrives;
   intermediate steps send NO follow-up; `/subinspect C1` lists steps.
6. `/subchain` command (§6.2) — template run, CLI-compose parser (§4.4),
   picker (`ctx.ui.select`).
   → verify: `/subchain implement-and-review do X` runs the template;
   `/subchain scout "find auth" | reviewer "review {previous}"` composes.

### Phase 3 — Orchestration surface (§5)
7. `orchestrate` tool (§5.2) — `template`/`steps`/`chains`/`input`/`lite`;
   fire-and-forget; one-line `subagent_catalog` nudge in the description.
   → verify: LLM calls `orchestrate({steps:[...]})`; chain C1 spawns;
   `subagent_list` shows it; final follow-up returns the synthesis.
8. Extend `subagent_remove` / `subagent_inspect` / `subagent_list` to accept
   `C` IDs (parse `C\d+` prefix) and the chain-list view (§5.1).
   → verify: `/subrm C1` removes a whole chain; `/subrm #N` on a live step is
   guarded; `subagent_list` shows a chains section.
9. `/subchain-doctor` command (§6.2) — read-only diagnostics: resolved
   agent/chain dirs, discovery counts, sample agent resolution, extensions survival.
   → verify: `/subchain-doctor` prints resolved paths + counts; with a missing
   agent dir it reports 0 found + the searched paths.

### Phase 4 — Failure & abort (§8)
10. Failure halt (§8.1) + aborted-flag propagation (§8.2) + `session_start`
   chain cleanup (§8.3).
   → verify: force a step to fail (bad agent name / model) → chain halts, prior
   steps persist, failure follow-up names the step; `/subrm C1` mid-run →
   aborted summary, no spurious complete follow-up, siblings untouched.

### Phase 5 — Docs
11. Update `README.md` with the orchestration section, agent-def + chain-template
    schemas, the three modes, command/tool tables.

---

## 10. Out of scope / deferred (explicit non-goals)

- **Inline agent specs in chains** (Q7/Q8 — references only).
- **DAG / fan-out within one chain** (Q9 — linear only). Fan-out = orchestrator.
- **Mid-run instruction injection into a chain** (Q3 — instruct = post-completion
  `/subcont` on the last step only).
- **Per-hop main-agent turns in predefined chains** (Q3 — auto-advance).
- **Blocking orchestrate tool** (Q5 — fire-and-forget).
- **Strict-allowlist per-agent extensions** (Q7 — additive only; the only path
  that could drop neuralwatt).
- **`tools: none` literal** for pure-reasoning agents (Q14 — deferred).
- **Mid-turn interception by the main agent** (Q3 — human `/subrm` + `/subinspect`
  already cover it; LLM interception is racy + costly).
- **Peer-to-peer (subagent-initiated) handoffs** (Q2 — orchestrator-brokered).
- **Capped roster injection into tool descriptions** (Q20 — `subagent_catalog`
  lookup tool instead; O(1) tokens).
- **`/subagents` human command** (Q20 — `ls` works in a pinch; deferred).
- **Composite chain widget/session** (Q9 — N ordinary SubStates; the step
  widgets already stack).
- **Retry/recovery policy in the coordinator** (Q18 — recovery is mode 1).

---

## 11. Research findings (post-design)

Surveyed post-lock: 6 frameworks (LangGraph, OpenAI Agents SDK, Microsoft
AutoGen/AG2, CrewAI, Google ADK, Claude Code subagents) + 4 pi extension repos
(nicobailon/pi-subagents, tintinweb/pi-subagents, QuintinShaw/pi-dynamic-workflows,
gotgenes/pi-packages). Adoptions folded into v1 above (Q21–Q24). This section
complements §10 (grilling-era non-goals) by adding research-sourced ideas + a
revisit trigger for each, so deferred decisions can be revisited on a named
signal rather than re-debated from scratch.

| Idea | Verdict | Why | Revisit trigger |
|---|---|---|---|
| DAG / fan-out within one chain | REJECT | Fan-out-join needs reduce semantics (LangGraph reducers, ADK external state). Our mode-1 orchestrator already does fan-out for free (Q9); a per-chain DAG duplicates it + imports deterministic-join bugs. | A concrete saved fan-out template becomes a felt need ("run 3 reviewers in parallel, then merge"). |
| Checkpoint / resume | DEFER | Assumes long-lived, cross-process, interruptible workflows with idempotent nodes (LangGraph). Ours is single-session, fire-and-forget, complete-or-halt (Q5); `session_start` clears; recovery = mode-1 `subagent_continue`. | A chain long enough that interrupting mid-run matters. |
| `PROVIDER_USAGE_LIMIT` → `paused` status + `resetHint` | DEFER | QuintinShaw proves quota-pause (not hard-fail) is essential for long chains; our halt-on-failure (Q18) can't resume a quota-killed run. Adds a `paused` status + quota-failure detection. | A real chain killed by a provider-quota reset mid-run. |
| First-class typed handoff object | REJECT | OpenAI's `Handoff` (input_type, on_handoff, input_filter) carries LLM-decided metadata. Our chains are deterministic — no LLM-decided metadata to transport; the string envelope + template prose carries who/what/step-index (Q12). Structured payload deferred via the forward-compatible seam (Q23). | An agent needs a reliably-parseable structured handoff payload. |
| Human-in-the-loop pause/approval per step | DEFER→REJECT | CrewAI's per-task `human_input` and Claude Code permission modes break auto-advance (Q3's premise) and introduce racy waits. Our existing surface (stacked widget + `/subinspect` + `/subrm` + `/subcont`) is HITL-adjacent and costs nothing. | A regulated/audited workflow needing explicit per-step sign-off. |
| Loop / conditional edges inside a template | REJECT | Dynamic per-hop routing (LangGraph conditional edges, ADK graphs) puts an LLM-or-fn in the routing loop. Our linear-only chains are deterministic by design (Q9). | A templated retry-until-pass flow can't be expressed as linear. |
| Per-step `acceptance` gate (verified/checked) | DEFER | nicobailon's QA primitive; orthogonal to linear-only but medium effort + competes with halt-on-failure semantics. | A "reviewer must pass" gate that current halt-on-failure can't express. |
| `append-step` on a live async chain | DEFER | nicobailon's clean answer to the mid-run injection we rejected (Q3): append to the tail, don't inject into the running step. Small effort once chains exist. | Mid-chain extension without re-running from scratch. |
| Grace-turn wrap-up before hard abort | DEFER | tintinweb emits a soft "wrap up, N turns left" steer before hard `max_turns`. Only relevant if/when we add a `maxTurns` step field (we haven't). | We add `maxTurns` per step. |
| Model `tier:` alias on `model:` | DEFER | QuintinShaw's small/medium/big tiers = nice "cheap explore / expensive synthesize" UX. Needs a tier-config + resolver — a new concept. | Per-agent model pinning proves too coarse for cost routing. |
| Call-hash journaling for chain resume | DEFER→REJECT | QuintinShaw's standout, but our chains are fire-and-forget single-session (Q5); journaling assumes long-lived re-runnable workflows we don't have. | Chains become long-lived + re-runnable. |
| Cross-extension service boundary (`getSubagentsService()`) | DEFER | gotgenes' vetted spawn path for other extensions; pairs with WorkspaceProvider. No other consumers at v1. | A second extension needs to spawn subagents/orchestrate. |
| `WorkspaceProvider` seam (worktree isolation) | **ADOPTED (post-research, 2026-06)** | The revisit trigger fired — the user hit the exact "2 agents editing the same file" collision. Implemented as git worktree isolation (see §12). | (triggered) |
| Package-supplied agents (`package.json`) | DEFER | nicobailon scans installed npm packages for agent packs. Attractive, medium effort, orthogonal to user/project dirs. | Distributable agent packs become a real need. |
| Per-step structured output (`output_json`/pydantic) | DEFER | CrewAI's typed step outputs; pairs with the envelope forward-compat seam (Q23). Weak signal for v1. | A step's output must be reliably parsed by the next. |
| Recursion via env-var depth counting | REJECT | nicobailon allows intentional N-deep recursion; our intent is *zero* subagent-initiated recursion, enforced structurally by `DEFAULT_DISALLOWED_EXT` (Q2). | (none — structural block is the decision) |
| Bidirectional child→parent intercom | REJECT | nicobailon's `contact_supervisor` needs a richer child→parent channel than fire-and-forget + follow-up supports (Q5). | Subagents must ask the orchestrator questions mid-run. |
| One mega-tool with `action:` dispatch | REJECT | nicobailon's 11-action tool is a schema-collision landmine (`chain` vs `chainName` exists as evidence). Our `orchestrate` + `subagent_catalog` split is the locked decision (Q20). | (none — split is the decision) |
| vm-sandbox code-execution as the chain primitive | REJECT | QuintinShaw's LLM-authored JS DAG trades reliability (LLM must emit correct code) for expressiveness our declarative `steps` already get (Q8/Q9). | (none — declarative is the decision) |
| In-process child execution | REJECT | tintinweb/gotgenes share the runtime; a crashing child corrupts shared state. Our subprocess `spawnAgent` (Layer 1) is the locked foundation — crash-isolation over speed (Q10). | (none — subprocess is the decision) |
| Inline roster injection into tool descriptions | REJECT | tintinweb/nicobailon inject rosters; tintinweb added `toolDescriptionMode: compact` to patch the token cost — evidence it doesn't scale. `subagent_catalog` is the locked decision (Q20). | (none — lookup tool is the decision) |

## 12. Git worktree isolation (adopted post-research, 2026-06)

The revisit trigger on the §11 `WorkspaceProvider` row fired ("Parallel
file-mutating agents start colliding") — the user wants spawned subagents to
work in isolated git worktrees so concurrent agents can't clobber each other's
in-flight file edits. Verified feasible end-to-end: a `pi` child spawned with
`cwd` = a fresh worktree runs cleanly (verified `--no-approve` sidesteps the
project-trust gate deterministically even for a trust-requiring worktree, and
the child's `pwd` reports the worktree path).

**Granularity (locked):** one worktree per chain (shared across its linear
steps — a `worker` step sees the `planner` step's edits) + one per standalone
`subagent_create`/`/sub`/`/sublite`. Parallel chains → separate worktrees →
no collision. Read-only agents (scout/reviewer) also get one under "always"
(uniform + simple; pure overhead for them but not a correctness issue).

**Lifecycle (locked):** auto-create on spawn (branch off current repo HEAD,
named `pi-sub-<id>-<ts>` / `pi-chain-C<id>-<ts>` so ids resetting per session
never collide). **Standalone** subagent worktrees persist until explicit
removal (`/subrm #N`, `/subclear`, `session_start`) — so `/subcont` can resume
in-tree. **Chain** worktrees (one per chain, shared across its linear steps)
are removed on finalize/abort (`/subrm C1` force-removes). The branch is ALWAYS
kept — committed work stays recoverable. **Landmine (conservative choice): if
a worktree is dirty at non-forced removal, do NOT `--force` (silent data loss);
keep it + notify the path/branch so the user inspects/merges. Only explicit
removal (`/subrm`, `/subclear`, `session_start`) passes `--force`.**

**Opt-in vs default (locked):** `config.json` `worktree: "always" | "off"`
(default **off** so non-isolation users aren't surprised by branches) + a
per-agent-def `worktree: true` override (applies to **chain steps**, which
reference named agents; standalone spawns are anonymous — §5.1/Q8 — so the
override is N/A there). A per-`orchestrate`/`/subchain` worktree passthrough is
**not** implemented — use the per-agent override or `worktree: "always"`. "When in a git repo" — a non-git cwd falls back to today's
shared-tree behavior (no isolation).

**Fixed by design:** worktree children always spawn with `--no-approve`
(deterministic, no trust-prompt, no trust-store pollution; untrusted =
project-local `.pi/extensions` and AGENTS.md NOT loaded — which is desirable
for isolation anyway). The neuralwatt guarantee is unaffected (loaded via the
global packages + `-e`, not project-local). Caveat made explicit: committed
project-local `.pi/extensions` won't load in worktree children.

**Seam:** `spawnAgent(state, prompt, ctx, lite, agentConfig?, cwd?)` — `cwd`
defaults to `process.cwd()` (today's behavior); a worktree passes the worktree
path. Existing call sites that pass no `cwd` are unchanged.

Full source reports retained at `/tmp/framework-research.md` and
`/tmp/repo-research.md` (research subagent outputs, 2026-06).
