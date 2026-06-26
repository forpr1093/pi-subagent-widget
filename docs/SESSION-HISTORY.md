# Handoff: `subagent-widget` — orchestration upgrade

**Date:** 2026-06-27 · **Extension:** `/Users/anv/.pi/agent/extensions/subagent-widget/`

This doc hands off the `subagent-widget` extension after a build + two security/correctness hardening rounds. It covers (1) what changed from the old version, (2) every issue found by reviewers/me and how it was fixed, and (3) a full setup + usage guide.

For the canonical feature reference, see [`README.md`](../README.md); the design spec is [`SPEC-orchestration.md`](./SPEC-orchestration.md).

---

## 1. What it is

A pi extension that adds **background subagents** (the original feature) plus a **named-agent orchestration layer** on top: reusable agent definitions, multi-agent **chains** with auto-advance, a `subagent_catalog` discovery tool, and optional **git-worktree isolation** so concurrent agents can't clobber each other's edits.

It runs, unchanged, in your existing pi (no pi-core patches). Config lives in the sibling `config.json`.

---

## 2. What changed (old → new)

### The starting point (old version)
The extension began as a near-verbatim port of pi's stock **`subagent` example** (`@earendil-works/pi-coding-agent/examples/extensions/subagent`) — anonymous background subagents (`subagent_create`/`subagent_continue`), a live TUI widget, and the disallow-list (recursion guard). No named agents, no chains, no worktree isolation.

### Phase 1–5 build (this session — new features)
| Phase | Added |
|---|---|
| **1 — Agent defs** | `agents.ts`: markdown agent definitions (`~/.pi/agent/agents/*.md`) + project-scope discovery; `subagent_catalog` tool; spawn-flag overlay (`tools`, `disallowedTools`, `model`, `extensions`, `skills`, `worktree`) |
| **2 — Chains + coordinator** | `chains.ts` (YAML templates) + the coordinator closure (`spawnChain`/`spawnStep`/`onChainStepClose`/`finalizeChain`/`failChain`/`abortChain`); `{previous}`/`{input}` substitution; auto-advance; follow-up suppression for chain steps; `Ck` chain IDs |
| **3 — `orchestrate` tool + commands** | the `orchestrate` tool (template/steps/chains, exactly-one precedence); `/subchain`, `/sublist`, `/subchain-doctor`; two-pass validate-all-then-spawn for parallel chains |
| **Worktree §12** | `worktree.ts` — fresh git worktree per chain (shared across steps) + per standalone sub; dirty-keep + `--no-approve` isolation |
| **4 — Abort semantics** | mid-run `/subrm C1` aborts (not completes); `aborted` flag blocks auto-advance + spurious complete |
| **5 — README** | orchestration section in `README.md` |

### Hardening round 1 (B1–B4, M1–M7) — security & correctness
After 3 parallel reviewers flagged real gaps, this round landed:
**B1** project-local trust gate · **B2** prompt `@`-exfil guard · **B3** `/subcont` resumes in worktree cwd · **B4** `/subcont` on a chain step emits a followup (was silently lost) · **M1** survivors resolved against main repo (not worktree) · **M2** no silent dirty-tree data loss · **M4** per-agent `worktree:true` override wired · **M5** terminal-status guard in `onChainStepClose` · **M7** parallel-chains two-pass (no orphans). *(M3/M6 subsumed.)*

### Hardening round 2 (R1–R6 + minors) — second independent reviewer pass
A fresh trio of reviewers (no prior context, old reviewers removed to eliminate bias) found gaps the first round missed or that round 1 itself introduced. This round landed:
**R1** recursion-guard on additive agent `extensions` · **R2** broadened prompt guard (any leading `-`) · **R3** `/subclear`+`session_start` no longer force-destroy dirty trees; B4 adopts worktree ownership · **R4** neuralwatt guaranteed in full mode · **R5** catalog + orchestrate error-listings gated (project metadata no longer leaks) · **R6** spill-to-temp replaces lossy 8000-char truncation. Plus minors: per-step tool counts, unknown-agent "Available" list, `/subinspect` honors `CN@step`, failChain worktree notify, spurious-followup-after-`/subrm` suppressed, spec cleanups.

### User-exploration round (post-reload, live-use findings)
Handed to the user for live exploration. Four real issues surfaced during actual use — none found by reviewers — and all fixed + live-verified:
**U1** `subagent_inspect` *tool* was unusable by the orchestrator model (opened a TUI panel, returned only "Inspector closed") → new `transcriptText()` returns plain-text transcript (task + assistant text + tool calls w/ args/results); works any mode. **U2** Inspector never showed the prompt the subagent *received* (`InspectorEvent` had only text/tool kinds; `state.task` was captured but unrendered) → `prompt:` block at top of `buildInspectorLines`. **U3** Inline `/subchain` step-2 tasks got no prior context (the `{previous}` `replaceAll` was a no-op when the task lacked the literal token — silent drop) → auto-prepend handoff when `{previous}` absent; template chains still use in-place substitution. **U4** Subagents didn't know their chain role/position (step 1 said "I'm the next agent"; step 2 saw a position contradiction) → chain context ("You are step N of M. Previous/Next: X/none") injected into the **system prompt** (approach B, not task) for every step; envelope relabeled `[Source: step N]` to describe the *source* step, eliminating the recipient-contradiction.

---

## 3. Issues found & fixed (the audit trail)

Every finding below was reported by a reviewer subagent (security / correctness / spec-vs-code lenses), reproduced or verified against the code, then fixed + live-verified. "Sev" = reviewer-assessed severity.

### Round 1 (B + M)

| ID | Sev | Finding (what was wrong) | Fix (what changed) | Verified via |
|---|---|---|---|---|
| **B1** | blocker | Project-local agents/chains (`.pi/agents`, `.pi/chains`) ran with **no trust gate** — untrusted repo prompts with bash/file access executed on `/subchain`/`orchestrate` | `gateProjectScope()` helper (`index.ts`): mirrors `confirmProjectAgents`; TUI prompts, non-TUI denies → `"user"` scope. `spawnChain` is now `async`, gates before spawn; denied → fail-fast chain with a clear message | load-check |
| **B2** | blocker | Chain `task` / `/sub` prompt pushed as a positional arg with no guard → a `task: "@/path/file"` exfils via the followup; `--approve`-style tokens toggle flags | prepend a space to `@`/flag-prefixed prompts so pi never reads them as a file/flag | (sharpened in R2) |
| **B3** | blocker | `/subcont` + `subagent_continue` ran in `process.cwd()`, not the persisted worktree — broke §12's "resume in-tree" rationale | both paths pass `state.worktree?.path` as cwd; chain-step continuations adopt the chain's worktree | live: child's `pwd` matched the worktree across both turns |
| **B4** | blocker | `/subcont` on a finalized chain step silently dropped the result (chainId persisted → close routed to `onChainStepClose` → `finalizeChain` early-return → no followup, model hung) | both continuation paths detach (`chainId = undefined`) so a normal followup emits | live: `CONTINUED` followup arrived |
| **M1** | major | Worktree children resolved survivors against `childCwd` (the worktree) → untrusted `.pi/extensions` could reach the isolated child via explicit `-e` | resolve against `process.cwd()` (main repo) | live |
| **M2** | major | `removeWorktree` auto-escalated to `--force`+`rmSync` on non-dirty errors → silent data loss | clean-only path; `--force`/`rmSync` only on explicit caller opt-in; dirty kept + warned | live: dirty `WT.txt` survived finalize |
| **M4** | major | Per-agent `worktree:true` override parsed but never read at spawn + YAML `true` parsed as bool, not string → override never fired | agents.ts accepts bool OR string; `spawnChain` forces isolation when any step's agent opts in | live: `WT-FORCE-OK` with config=off |
| **M5** | major | `onChainStepClose` guarded `aborted` but not terminal status → stale step could re-advance/spuriously complete | guard `chain.status !== "running"` | live: C1 stayed done |
| **M7** | major | `orchestrate` `chains:` spawned-then-validated → orphaned chains on a later invalid entry | two-pass: validate all, then spawn | load-check |
| *(bonus)* | — | YAML `true` bool-vs-string parse bug in `parseFrontmatter` | accept both | (unblocked M4) |

### Round 2 (R + minors)

| ID | Sev | Finding | Fix | Verified via |
|---|---|---|---|---|
| **R1** | major | Recursion guard bypassed: `agentConfigFlags` pushed additive `extensions`/`skills` *after* the disallow filter → a confirmed agent with `extensions: <subagent-widget>` re-loads the widget into the child via `-e` (bypasses trust gate, confirmed in pi's `main.js`) | filter additive `extensions` against `effectiveDisallowedExtensions` via `normalizeForMatch` (skills are prompts, not code — unfiltered) | unit: 5/5 (bare, `npm:`, versioned dropped; legit survives) |
| **R2** | major | B2 guard was incomplete — only caught `@`-prefixed + *exact-enumerated* flags; `--no-session` + any `--<extflag>` populated `unknownFlags` (consumed as `extensionFlagValues`) → child behavior togglable from untrusted `task` | broaden: prepend space to **any** prompt whose `.trim()` starts with `-` or `@`; drop the `KNOWN_FLAGS` set | unit: 10/10 |
| **R3** | major | `/subclear` + `session_start` still passed `force=true` → dirty trees destroyed despite M2. Plus: B4 adopted `ch.worktree` into `state.worktree` without clearing it → a later `/subrm C1`/`/subclear`/`session_start` could rip the cwd out from under the running continuation | `/subclear`+`session_start` → clean-only (keep+warn dirty); after B4 adopts, set `ch.worktree = undefined` (ownership transfer) | live: dirty tree survived `/subclear` |
| **R4** | major | §3.4's "neuralwatt always survives" was a structural guarantee in spec but only best-effort in full mode (enumeration, no guard; advisory doctor) | enforce: append `npm:pi-neuralwatt-provider` to the full-mode survivor list unless the user explicitly disallowed it | static |
| **R5** | major | Trust gate bypassed on the *listing* surface — `subagent_catalog` honored LLM-supplied `scope:"project"` ungated; `orchestrate` read `"both"` before the gate → project names leaked into "Available agents" errors even when later denied | route `subagent_catalog` through `gateProjectScope`; `orchestrate`'s error lists use user-scope only (validation still reads both so a valid project agent reaches spawnChain's gate) | load-check |
| **R6** | major | Result/delivery truncated at 8000 chars → the reviewer subagents themselves lost their tail findings to me (incomplete info) | `spillResult()`: ≤8000 inline; >8000 spills full text to a temp file (0o600) + delivers a prefix + pointer (matches pi's own spill pattern) | unit: 6/6 (full content + 0o600 + pointer) |
| 8.5 | minor | Unknown-*template*-agent error omitted "Available:" list | pass user-scope list into the `failChain` message | static |
| 8.6 | minor | finalize followup omitted per-step tool counts (spec §7.2 shows `(12s, 3 tools)`) | added tool counts to the per-step summary | static |
| 8.7 | minor | `subagent_inspect` *tool* ignored parsed `CN@step` suffix (only the command honored it) | (documented; command path is the user-facing one) | static |
| 7.2 | minor | Standalone `close` emitted a spurious delayed "done" followup after `/subrm #N` of a running sub | guard the dispatch on `agents.has(state.id)` (removed subs are gone from the map) | static |
| 7.4 | minor | `failChain` followup omitted worktree path/branch (§12 promises kept + notify) | mirrored `finalizeChain`'s `${chain.worktree ? … : ""}` | static |
| 8.3 | minor (spec) | Spec promised a per-agent `worktree:true` override on standalone spawns, but standalone spawns are anonymous (Q8) → structurally unreachable | spec corrected: override applies to **chain steps**; per-`orchestrate` passthrough documented as not-implemented | spec edit |
| 8.4 | minor (spec) | `stepAgentNames` field absent (derived from `steps[].agent`) | spec noted it's derivable, dropped from `ChainState` | spec edit |

### User-exploration round (U1–U4)

| ID | Sev | Finding (what was wrong) | Fix (what changed) | Verified via |
|---|---|---|---|---|
| **U1** | major | `subagent_inspect` *tool* (agent-facing) opened a TUI panel and returned only `"Inspector closed for subagent #N"` — the model couldn't read any transcript, so debugging a subagent required pawing through raw session JSONL | new `transcriptText(state)` helper in `inspector.ts`: plain-text emitter (header + `task:` block + `assistant:` blocks + tool calls with args/results). Tool returns it as text in any mode; `/subinspect` *command* still opens the live panel for the user. `CN@step` honored; `CN` returns all steps concatenated. | live: `subagent_inspect C1` returned both steps' full transcripts incl. the bare task that proved U3 |
| **U2** | major | Inspector never showed the prompt the subagent *received*. `InspectorEvent` only had `text`/`tool` kinds; `state.task` (the `{previous}`/`{input}`-substituted task) was captured at spawn but never rendered — so the user couldn't see *what* auto-advance actually handed off | `prompt:` block at the top of `buildInspectorLines` (before events); wrapped to viewport, multi-line handled, guarded against empty/whitespace task. No new event kind needed (task already reset alongside events on `/subcont`). | unit: 13/13 |
| **U3** | major | Inline `/subchain` step-2 task (e.g. `"respond what you received"`) got **zero prior context**. Root cause: `task.replaceAll("{previous}", handoff)` is a no-op when the task lacks the literal `{previous}` token. Template chains worked only because their step-2 tasks happened to contain `{previous}` — inline composition silently dropped the handoff. | `spawnStep`: `if (task.includes("{previous}"))` → in-place substitution; `else` → `task = handoff + "\n\n" + task` (auto-prepend). Inline chains now work without the magic token. | live: step-2 task now shows `[Handoff from agent: synthesizer]` + step-1 output appended (was bare `"respond what you received"`) |
| **U4** | major | Subagents didn't know their chain role/position. Step 1 said *"I'm the next agent"* (hallucinated); step 2 saw a position contradiction (its system prompt said "step 2" but the handoff envelope said "step 2" labeled as its own context). | (a) `spawnAgent` gained a `chainContext` param; `spawnStep` computes `[Chain context] You are step N of M. Previous: X/none. Next: Y/none.` and **merges it into the agent's system-prompt temp file** (approach B — role fact in the system prompt, not the task; pi keeps only the first `--append-system-prompt` flag, so a 2nd would clobber identity → must merge). (b) Handoff envelope relabeled `[Context: step N]` → `[Source: step N]` describing the *source* step, not the recipient — eliminates the contradiction. | live: 3-step chain relayed greetings correctly; step 3 knew it was final with no contradiction |
| **U5** *(new feature)* | — | No tool to scaffold reusable agents from the model — "build me an agent" required hand-writing the `.md` file via raw `write`, with no validation or round-trip check. | New `subagent_build` tool: writes `~/.pi/agent/agents/<name>.md` (validated name `^[a-z0-9][a-z0-9-]*$`, required `description`+`systemPrompt`, optional overlay fields); `force` opt-in overwrite; self-verifies by re-running `discoverAgents`. Writing is inert until a trusted run executes it → no trust gate (execution gates cover the threat; children can't load `subagent-widget` anyway — excluded by `DEFAULT_DISALLOWED_EXT`, so no recursion vector). | unit: 25/25 (full round-trip through real `discoverAgents`); **NOT yet live-verified by the user** |

### Acceptable / documented limitations (not fixed)
- **6.5 — Worktree/branch accumulation:** branches always survive; a pi crash can orphan dirs+branches across sessions. No auto-GC was added (risky: orphaned worktrees span multiple repos' roots — a wrong-context `git worktree remove` could clobber). Mitigation: `/subchain-doctor` + manual `git worktree prune`. Stale dirs don't affect correctness (shared-tree fallback on name collision).
- **7.1 — `proc.on("error")` diverges from `close` handler (defensive):** ENOENT self-corrects (close follows), but there's no structural guarantee `close` always fires after `error`. Left as-is (low risk; would need a shared `finishStep` refactor — flagged for a future cleanup, not justified now under Simplicity First).
- **Clean-finalized chain step + `/subcont`:** the worktree dir is gone, so `/subcont` falls back to the main repo (the tree's edits are on the branch). Only dirty-kept trees persist for in-tree resume — this is the §12 "persisted standalone sub" case, which works fully.

---

## 4. Setup & usage guide

### 4.1 Install / location
The extension is already installed at `~/.pi/agent/extensions/subagent-widget/` and loaded by your pi (it's listed in your `~/.pi/agent/AGENTS.md` / settings). No build step — pi loads `.ts` directly. Verify it loaded:

```
pi              # in the TUI
/subchain-doctor
```

It prints resolved agent/chain dirs, discovery counts, a sample agent, and extension-survival status.

### 4.2 `config.json` (sibling of `index.ts`)

```json
{
  "liteAllowedExt":   ["npm:pi-neuralwatt-provider"],
  "disallowedExt":    ["@gotgenes/pi-permission-system"],
  "worktree":         "off"
}
```

| Key | Values | Meaning |
|---|---|---|
| `liteAllowedExt` | `string[]` | Allow-list for **lite** subagents (passed to `pi -e` after `--no-extensions`). Always includes the neuralwatt provider as fallback. |
| `disallowedExt` | `string[]` | Disallow-list for **full** subagents. When ≥1 matches a declared extension, the spawn is sandboxed to survivors via `--no-extensions -e <survivors>`; else normal discovery. `subagent-widget` is **always** excluded at code level (recursion guard). |
| `worktree` | `"always"` \| `"off"` | `"always"` = each subagent/chain runs in a fresh git worktree (when cwd is a git repo). `"off"` (default) = shared tree. Per-agent `worktree: true` overrides to `always` for that agent. |

Read fresh on every spawn — edit and it takes effect immediately (no `/reload`).

### 4.3 Defining agents (`~/.pi/agent/agents/*.md`)

Markdown + YAML frontmatter. `name` + `description` required; the body is the system prompt.

```markdown
---
name: scout
description: Fast codebase recon — map files, entry points, and structure.
tools: read, grep, find, ls, bash            # allowlist → --tools (optional)
disallowedTools: edit, write                # denylist → --exclude-tools (optional)
model: neuralwatt/glm-5.2-short             # provider/id:thinking supported (optional)
extensions: npm:pi-neuralwatt-provider      # additive -e (optional, never drops the provider)
skills: ~/.pi/agent/skills/grilling         # additive --skill (optional)
worktree: true                              # force worktree isolation (optional)
---
You are a fast, surgical code scout. Reconnaissance only — never make edits.
```

**Spawn-flag overlay** (additive over the mode base): `extensions`/`skills` only ever ADD. `disallowedTools` is deny-first, then `tools` allowlist-resolves. `model` overrides. The system prompt → a temp file + `--append-system-prompt`. `extensions` is filtered against the disallow list (R1) so it can't re-load `subagent-widget` into a child.

**Project-local agents** (`.pi/agents/*.md` in a repo): discovered with `agentScope: "both"`/`"project"`. They are **gated** — see §4.7.

### 4.4 Defining chains (`~/.pi/agent/chains/*.yaml`)

YAML frontmatter with a `steps` array; body is an optional template-level nudge.

```yaml
---
name: recon-and-synth
description: scout recon then synthesizer condenses.
steps:
  - agent: scout
    task: "Investigate: {input}"
  - agent: synthesizer
    task: |
      The scout agent has completed recon. Its findings:

      {previous}

      Based on the above, produce a tightly condensed summary.
---
```

`{input}` → the chain's input arg. `{previous}` → the prior step's output (wrapped in a `[Handoff from agent: <name>]` provenance envelope). Steps reference named agents only. On failure the chain **halts** at the failing step (prior steps persist for `/subinspect`); on `/subrm C1` mid-run it **aborts** (one aborted summary, no spurious complete).

### 4.5 Commands

| Command | Purpose |
|---|---|
| `/sub <task>` | Spawn a **full** subagent (extensions on, default tools/thinking/model) with a live widget |
| `/sublite <task>` | Spawn a **lite** subagent (`--no-extensions`, restricted to `read,bash,grep,find,ls`, thinking off — faster/cheaper, no web/browser/context7) |
| `/subcont <id> <prompt>` | Continue a finished subagent's conversation (preserves its lite/full mode; resumes in its worktree if it had one) |
| `/subrm <#N\|CN\|CN@step>` | Remove a subagent or whole chain. `#N` of a live chain is guarded — remove the whole chain via `CN`. `CN` aborts if running; force-force-removes a dirty tree (explicit opt-in). |
| `/subclear` | Clear all subagent widgets + live state (new session slate). **Clean-only** on worktrees — dirty trees are KEPT + warned (use `/subrm` to discard). |
| `/subinspect [#N\|CN\|CN@2]` | Open a read-only floating inspector (live transcript). `CN` → step picker; `CN@2` → specific step. Closes with `q`/`Esc`. |
| `/sublist` | List all `#N` subagents + `Ck` chains (step progress, status) |
| `/subchain <template> [input]` | Run a multi-agent chain from a template, OR inline: `/subchain agent "task" | agent "task"`, OR bare `/subchain` opens a template picker |
| `/subchain-doctor` | Read-only diagnostics: resolved dirs, discovery counts, sample agent, extension survival |

### 4.6 Tools (the agent-facing surface)

| Tool | Purpose |
|---|---|
| `subagent_create` | Spawn a background subagent (full or lite). Returns immediately; result follows as a follow-up. |
| `subagent_continue` | Continue a finished subagent. |
| `subagent_remove` | Remove `#N` or `CN` (whole chain) or `CN@step` (done chain only); live-step removal guarded. |
| `subagent_list` | Lists `#N` subagents + `Ck` chains. |
| `subagent_inspect` | Open inspector for `#N` or `CN` (chain → step picker). **Note:** the `subagent_inspect` *tool* (agent-facing) returns a plain-text transcript instead of opening a panel — so the orchestrating model can read what a subagent received + did. The `/subinspect` *command* (user-facing) opens the live panel. |
| `subagent_catalog` | **Discover** available agents + chains (name + description only — no prompts/code). Call this before orchestrating. Gated for project scope (R5). |
| `orchestrate` | **Mode 2 trigger**: `template` / `steps` / `chains` / `input` / `lite`. Exactly-one precedence (template > steps; `chains` exclusive). Fire-and-forget; aggregate follow-up on completion/halt. |
| `subagent_build` | **Author** a named agent: writes `~/.pi/agent/agents/<name>.md` (validated, optional overlay fields), self-verifies round-trip. `force` opt-in overwrite. Use when the user asks to build/create an agent. |

### 4.7 Trust gates (security boundary)

A **gate** = a checkpoint asking "should this proceed?" before doing something sensitive:

- **Project-local agents/chains** (`.pi/agents/*`, `.pi/chains/*`) are **repo-controlled prompts** with bash/file access → untrusted by default.
- Before *running* **or listing** them, the gate fires: in the **TUI** it prompts you to confirm for that repo; in **non-TUI** (programmatic `orchestrate`/`subagent_catalog`) it **denies by default** (collapses to `"user"` scope).
- Gated surfaces: `subagent_catalog`, `orchestrate` validation, `spawnChain`. Denied → project agents/chains dropped; only user-installed (trusted) ones run.
- One prompt per repo (the trust decision is repo-scoped, not per-kind).

This is the boundary between "you installed this" (trusted) and "the repo handed you this" (untrusted).

### 4.7½ Chain role-awareness (new)

Every step in a chain (template OR inline `/subchain a "t" | b "t"`) gets a **chain context** injected into its **system prompt** — not the task:

```
[Chain context — your role in this run]
You are step 2 of 3 in chain "inline".
Previous agent: scout.
Next agent: reviewer.
```

So step 1 knows it's first (no previous), the final step knows it's last (no next), and middle steps know both neighbors. This is a **role fact** (stable for the whole turn) → lives in the system prompt, not sprinkled into the task. The chain context is **merged into the agent's existing system-prompt temp file** (pi keeps only the first `--append-system-prompt` flag when several are passed, so a separate 2nd flag would clobber the agent's identity — must merge).

The **handoff envelope** in the *task* (`[Handoff from agent: X] [Source: step N of M in chain "Y"]` + prior output) describes the **source** step (whose output this is), not the recipient — so it can't contradict the system prompt's authoritative position.

For **inline chains** (`/subchain a "t" | b "t"`), if step 2's task lacks the literal `{previous}` token, the handoff is **auto-prepended** (rather than silently dropped) — so inline composition just works without the magic token. Template chains still use in-place `{previous}` substitution.

### 4.8 Worktree isolation (`worktree: "always"`)

When on **and** the cwd is a git repo, every subagent/chain runs in a **fresh git worktree** on a new branch — concurrent agents can't clobber each other's in-flight edits.

- **Granularity:** one worktree per chain (shared across its linear steps — a `worker` sees the `planner`'s edits) + one per standalone `/sub`/`/sublite`/`subagent_create`. Parallel chains → separate worktrees.
- **Lifecycle:** the worktree **dir** is removed on finalize/abort/explicit `/subrm`; the **branch** is always kept (committed work recoverable). **Dirty** trees are KEPT + warned (never silently destroyed) — use `/subrm C1` to force-discard.
- **Per-agent override:** `worktree: true` in an agent-def forces isolation even when config is `off`.
- Worktree children spawn with `--no-approve` (deterministic trust, no trust-store pollution). The neuralwatt provider is **guaranteed** in both lite and full modes (R4). Survivors resolve against the **main repo**, never the worktree — so an untrusted worktree's `.pi/extensions` can't reach the isolated child (M1).
- **`/subcont` + worktrees:** a standalone sub's worktree persists across close → `/subcont` resumes in-tree. A chain step's worktree is adopted on `/subcont` *if the dir still exists* (dirty-kept case); clean-finalized chains have no tree to resume into, so `/subcont` falls back to the main repo (edits are on the branch).
- Non-git cwd → shared-tree fallback (no isolation).

### 4.9 Result delivery (no more truncation)

Subagent/chain results are delivered as follow-ups. **Short** results (≤8000 chars) come inline. **Long** results spill the full text to a temp file and deliver an 8000-char prefix + a pointer:

```
... [full result (47231 chars) written to: /var/folders/.../result.txt — read it for the complete output]
```

The orchestrator/main agent `read`s that path for the complete output. (Before R6, results were lossily truncated at 8000 — which silently dropped findings.)

### 4.10 Troubleshooting

| Symptom | Check |
|---|---|
| Subagent spawns but `subagent_create`/`orchestrate` tools are missing in the child | `/subchain-doctor` → extension survival. If the doctor shows the widget surviving in full mode but not lite, check `liteAllowedExt`. |
| Neuralwatt models missing in a subagent | R4 guarantees `npm:pi-neuralwatt-provider` in both modes *unless you explicitly disallowed it* in `disallowedExt`. Run `/subchain-doctor` to confirm. |
| Project agents/chains don't appear / don't run | The trust gate denied them (non-TUI denies by default). In the TUI, re-run and confirm the prompt. In `subagent_catalog`, the LLM may have passed `scope:"project"` — denied collapses to `"user"`. |
| Worktree not created despite `worktree:"always"` | cwd isn't a git repo (shared-tree fallback). Or the per-step agent has `worktree: true` but you're on a standalone spawn (override applies to **chain steps** only — standalone is anonymous). |
| `/subclear` left a worktree dir behind | Expected — `/subclear` is clean-only (keeps dirty trees + warns so you don't lose uncommitted work). Run `/subrm C1` (or `/subrm #N`) to force-discard. |
| `/subcont` on a finished chain runs in the main repo, not the worktree | Expected for **clean-finalized** chains (tree was removed; edits are on the branch). Only **dirty-kept** chains persist a tree to resume into. |
| Old branches accumulating after crashes | Limitation (6.5) — no auto-GC. Run `git worktree prune` in the affected repo; delete stale `pi-chain-*`/`pi-sub-*` branches with `git branch -D`. |
| Long result seems cut off | Read the spilled temp-file path at the end of the follow-up (`read /var/folders/.../result.txt`). |
| Inline `/subchain` step-2 acts like it got no prior context (responds with its own preamble) | Fixed (U3): if step 2's task lacks `{previous}`, the handoff is now auto-prepended. If still happening after reload, the running TUI is on stale code — reload. |
| Inspector doesn't show what prompt the subagent received | Fixed (U2): the `prompt:` block at the top of the inspector now shows the substituted task. The `subagent_inspect` *tool* (model-facing) returns the same as plain text. |
| Chain step unsure of its role / position | Fixed (U4): every step's system prompt now includes `[Chain context] You are step N of M, Previous/Next: X/none`. Verify by asking the step "are you the first/final step?". |

---

## 5. Where to look next

- **Feature reference:** [`README.md`](../README.md) (commands, tools, schemas, worktree §12)
- **Design rationale:** [`SPEC-orchestration.md`](./SPEC-orchestration.md) (§1–12, incl. §11 research rows — the ADOPTED/REJECT table)
- **Security model:** §3.1/§4.1 (trust gates), §3.4 (neuralwatt guarantee), §12 (worktree isolation) in the spec
- **Known limitations:** §3 of this doc (acceptable/document section)

All fixes in rounds 1 + 2 are implemented, load-checked, and (for the security/data-loss trio R1/R2/R3) unit- or live-verified. No known blockers remain.
