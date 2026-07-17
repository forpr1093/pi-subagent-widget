# subagent-widget

A pi extension that spawns background subagents with live stacking widgets.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Orchestration center: shared state (`agents` map), `spawnAgent`/`processLine`, all tools + commands + `session_start`. Loaded by pi's global auto-discovery for `extensions/<name>/index.ts`. |
| `inspector.ts` | Floating read-only inspector overlay + event-shaping helpers (`cap`, `stringifyVal`, `appendText`, `wrapLine`, `buildInspectorLines`, `InspectorComponent`, `openInspector`). |
| `widget.ts` | Compact stacked per-agent widget factory (`buildSubagentWidget`). |
| `session.ts` | JSONL session-file make/delete helpers (paths resolved via `rundir.ts`). |
| `rundir.ts` | Unified `~/.pi/agent/runs/<id>/` RunDir per spawn: `prompt.md`, `result.txt`, `session.jsonl`, `meta.json` (`{id, origin, parentPid, pid, startedAt, …}`). All read/remove paths funnel through this — a single sweep reaps orphans (spec §Q2). |
| `config.ts` | Config loaders: lite-extension allow-list (`loadLiteExtensions`), full-mode disallow-list (`loadDisallowedExtensions`), worktree mode (`loadWorktreeMode`). |
| `disallow.ts` | Full-mode extension disallow-list resolution (survivor enumeration, `filterSurvivors`, `resolveFullModeExtArgs`). |
| `agents.ts` | Named-agent discovery (`discoverAgents`) + `AgentConfig` schema + spawn-flag overlay (`agentConfigFlags`). |
| `chains.ts` | Chain-template discovery (`discoverChains`) via pi's bundled `parseFrontmatter` (full YAML). |
| `worktree.ts` | Git worktree isolation (`createWorktree`/`removeWorktree`) — §12. |
| `types.ts` | Shared types: `SubState`, `ChainState`, `InspectorEvent`. |
| `config.json` | `liteAllowedExt`, `disallowedExt`, `worktree` settings. |
| `docs/SPEC-orchestration.md` | Locked design spec for orchestration (decisions, schemas, §11 research, §12 worktree). |
| `docs/SPEC-revamp.md` | Locked revamp spec: lifecycle (RunDir §Q2, process-group kill §Q3, orphan reaper §Q9), cooperation (`??` yield channel §Q4–Q7, identity prompt §Q10, blocked status §Q11, chain detect-and-fail §Q11d), surface (4-tool / 9-command collapse §Q6, `/sub doctor` §Q8). |
| `docs/REVIEW-revamp.md` | Implementation audit of the revamp spec (SATISFIES/PARTIAL findings, locked-constraint pass sheet). |
| `README.md` | This file. |

Pure/testable modules (`inspector`, `widget`, `session`, `config`, `types`) hold no
process state; `index.ts` is the center that wires them together. Relative imports
use `.ts` extensions, matching pi's own source style and the jiti loader.

## Commands

| Command | Description |
|---|---|
| `/sub` | **No-arg:** the family landing — lists all 9 commands. **`/sub <task>`**: spawn a **full** subagent (all extensions, default tools/thinking/model). **`/sub <agent> <task>`**: spawn under a named role (`~/.pi/agent/agents/*.md` — applies its tools/extensions/skills/model + system prompt). |
| `/sublite <task>` | Spawn a **lite** subagent (restricted tools `read,bash,grep,find,ls`, thinking off, only `config.json` `liteAllowedExt` extensions). |
| `/subcont <id> <prompt>` | Continue subagent `#<id>`'s conversation — either give a finished subagent more instructions, or **answer one that blocked on a `??` question** (its follow-up said `blocked, asking:`). Preserves the subagent's original lite/full mode. |
| `/subrm [#N\|N\|CN\|CN@step]` | Remove one subagent (`#N`) or whole chain (`CN`); `CN@step` for one step of a **done** chain (guarded if live). Omit the id to remove everything (kills running, force-removes worktrees). |
| `/subclear` | Clear all subagents **and** chains (regardless of origin) — kills running, force-removes worktrees. |
| `/subinspect [#N\|CN\|CN@2]` | Open the floating inspector for `#N`, or list a chain's steps (`CN`) and drill into one. |
| `/sublist` | List all subagents (`#N`) and chains (`Ck · step i/N · agent`). |
| `/subchain <template> [input]` | Run a named chain template (or `agent "task" \| agent "task"` to compose on-demand; no args = picker). The chain-result follow-up carries an `Input:` echo + `(user-spawned)` marker for `/subchain` (vs `orchestrate`, which is agent-origin). |
| `/sub doctor` | Read-only health + maintenance: **sweeps `~/.pi/agent/runs/` for orphaned runs** (dead `parentPid` → process-group kill + dir removal), reports in-session zombies (blocked or running but pid-dead), and shows resolved agent/chain dirs + extension survival (neuralwatt). |

The main agent has **4 LLM tools** (see [Orchestration](#orchestration-named-agents-chains-multi-agent-workflows)): `subagent_create`, `subagent_continue`, `subagent_remove`, `orchestrate`. Inspecting a subagent is filesystem-native via `~/.pi/agent/runs/<id>/` (`read` its `prompt.md`/`result.txt`/`session.jsonl`/`meta.json`); listing is via `/sublist`.

## Configuring lite extensions

`config.json` lists extension names under `liteAllowedExt`, each passed to `pi -e`:

```json
{
  "liteAllowedExt": [
    "npm:pi-neuralwatt-provider",
    "npm:pi-permission-system",
    "/absolute/path/to/some-extension.ts"
  ]
}
```

Entries are any form `pi -e` accepts: `npm:<package>`, `npm:<package>@<version>`, `git:...`, or an absolute file/directory path. Edits take effect on the next spawn — no `/reload` needed (the file is read fresh every time a lite subagent spawns). If the file is missing or invalid, the fallback is `["npm:pi-neuralwatt-provider"]`.

## Configuring disallowed extensions

`config.json` lists extension names under `disallowedExt` that are **blocked
from loading in full-mode subagents** (`/sub`, `lite=false`). Lite subagents are
unaffected — they stay governed by `liteAllowedExt`.

> **Built-in default (code level, not config):** `subagent-widget` itself is
> **always excluded** from full-mode subagents regardless of this list, so a
> spawned subagent can't recursively spawn further subagents via this widget's
> own tools (`subagent_create`, `subagent_continue`, …). It's hardcoded in
> `disallow.ts` as `DEFAULT_DISALLOWED_EXT` and merged with your `disallowedExt`
> on every spawn. You don't need to (and can't disable this by editing)
> config.json for this entry; `disallowedExt` only adds *more* exclusions on top.

```json
{
  "liteAllowedExt": ["npm:pi-neuralwatt-provider"],
  "disallowedExt": ["@gotgenes/pi-permission-system"]
}
```

The effective disallow list is the built-in default **plus** your `disallowedExt`.
When it matches at least one declared extension, the full subagent is sandboxed
to the survivors via `--no-extensions -e <each>` — so those extensions never
load. Because `subagent-widget` is always in the default list and is always
among the discovered extensions while the widget is running, a full-mode spawn
**always** injects `--no-extensions -e <survivors>` (it never discovers the
widget in the child). The user list is still gated by matching (criterion b):
a stale/typo `disallowedExt` entry that matches nothing drops nothing beyond the
built-in default.

The survivor list reproduces what the child would have loaded across the
standard discovery sources — global-local (`~/.pi/agent/extensions/*/`),
project-local (`.pi/extensions/*/`), and `packages` from both the global
(`<agentDir>/settings.json`) and project (`<cwd>/.pi/settings.json`) settings —
minus only the disallowed entries. This is a faithful port of the per-directory
logic in pi's `package-manager`/`resource-loader`; no blockable extension that
the child would discover is silently dropped.

Residual gaps are **over-inclusion, never drops**: pi applies root-self-checks,
`.gitignore`, dotfile, and `node_modules` skips during auto-discovery that this
enumeration does not. In practice these only matter if an auto-discovery dir
contains a stray `node_modules/` or root `package.json`, in which case the
child would load an *extra* extension, not lose one. The parent process's own
CLI `-e` extensions are not forwarded to the child today either way.

### Matching (strict)

Entries are normalized before comparison: strip the `npm:` prefix and any
`@<version>`, keep `@scope`, lowercase. To block a **scoped** package you must
write the scope — a bare name will **not** match.

| Disallow entry | Declared entry | Match? |
|---|---|---|
| `@gotgenes/pi-permission-system` | `npm:@gotgenes/pi-permission-system` | ✅ |
| `@gotgenes/pi-permission-system` | `npm:@gotgenes/pi-permission-system@2.0` | ✅ (version dropped) |
| `npm:@gotgenes/pi-permission-system` | `npm:@gotgenes/pi-permission-system` | ✅ (`npm:` prefix optional) |
| `pi-permission-system` (bare) | `npm:@gotgenes/pi-permission-system` (scoped) | ❌ no match |
| `pi-rtk-optimizer` | `npm:pi-rtk-optimizer` | ✅ |
| `subagent-widget` | `~/.pi/agent/extensions/subagent-widget/index.ts` | ✅ (local dir basename) |

Local (auto-discovered) extensions are matched by their directory name (or the
file name without extension, for direct `extensions/*.ts` files).

The list is read fresh on every spawn, so edits take effect immediately — no
`/reload` needed — including on `/subcont` continuations (the disallow state is
never frozen across turns).

### Scope & limits

- **Full mode only.** Lite mode keeps its own `liteAllowedExt` allow-list; to
  block an extension in lite, remove it from `liteAllowedExt`.
- The parent process's own CLI `-e` extensions are not forwarded to the child
  today, so they are not blockable here (not a regression).
- Discovery mirrors pi's runtime (`package-manager.resolve()` +
  `resource-loader.getExtensions()`): global + project auto-discovered dirs,
  and `packages` from both global and project `settings.json`. It does not
  replicate the root-self-check / `.gitignore` / dotfile / `node_modules`
  skips (over-inclusion only — see above). If pi adds a further discovery
  source in future, disallowed entries there won't be reachable.

## RunDir — `~/.pi/agent/runs/<id>/`

Each spawn gets a unified on-disk RunDir (spec §Q2):

| File | Contents |
|---|---|
| `prompt.md` | The task prompt (agent-origin spawns prepend an identity header — spec §Q10: purpose-revealing, not role-forcing). |
| `result.txt` | Final result body, spilled here when it exceeds the inline budget (~8KB). |
| `session.jsonl` | Full conversation transcript — the inspector's source of truth for prior turns. |
| `meta.json` | `{id, origin: "user"\|"agent", parentPid, pid, startedAt, …}` — the reaper's `parentPid` + worker `pid` let orphans be detected post-crash. |

`/subinspect #N`, the widget, `/sublist`, and `/subrm #N` all read from this dir;
`ls ~/.pi/agent/runs/` is the file-native way to see what's alive.

**Cleanup timing:** a RunDir is deleted on `/subrm`, `/subclear`, `subagent_remove`,
or after a natural-completion follow-up is delivered (mid-session it persists so
`/subcont` works). **Orphan reaper (spec §Q9):** on every `session_start`, the
`runs/` dir is swept — any dir whose `parentPid` is no longer alive (parent pi
process crashed) is process-group-killed via the `pid` field (spec §Q3) and its
dir removed. Misbehaving in-session zombies (blocked or running but pid-dead)
are *reported* by `/sub doctor`, not auto-reaped — `/subrm #N` removes them
deliberately.

## Stacked widgets

One bordered box is stacked above the editor per active entity:

- **Standalone subagent** (`/sub`, `/sublite`, `subagent_create`) → one `sub-${id}`
  box: `● Subagent #3 ⚡lite · 12s | Tools: 5` + a live `▸ last activity` line.
  Status glyph: `●` running, `⧗` blocked (waiting on a `??` question — see
  [Cooperation](#cooperation-the--turn-yield-channel)), `✓` done, `✗` error.
- **Chain** (`/subchain`, `orchestrate`) → **one composite `chain-${id}` box per
  chain**, not one box per step. The header carries the C-id + name so multiple
  concurrent chains are distinguishable at a glance
  (`⏳ ⛓ C1 "recon-and-synth" · step 1/3 · scout ⚡lite · (12s, 5 tools)`),
  followed by one row per step (`● #3 scout · 12s · 5 tools`, `○ synthesizer`,
  `✓ #5 …`). Only the currently-running step shows a live activity line,
  keeping finished chains compact.

The chain box is the live counterpart of `/sublist`/`/subinspect` for seeing
both *which agent is in which chain* and *that it is in a chain at all* — the
old design stacked N identical per-step boxes that were indistinguishable from
standalone subagents.

## Inspector

`/subinspect` opens a floating, read-only overlay that shows, for the selected
subagent's **current turn**, the live flow the small widget can't fit:

- Every assistant text delta (paragraphs, coalesced) — **shown in full**,
  wrapped to the dialog width, never truncated. The subagent's reasoning is
  the part you most need to read, so it's never cut.
- Every tool call: name, args, live partial result (while running), and final
  result. Tool fields are **display-truncated to ~400 chars** (with a
  `[… chars omitted]` marker) so a huge tool output — e.g. a directory listing
  of hundreds of files — can't flood the dialog and drown out the agent's text.
  Multi-line tool output has newlines flattened to a `⏎` marker (keeps the box
  borders intact). Tool errors render red. Full, unbounded content is always on
  disk in the session file for the rare case you need to see the whole output.
- Header: id · status · lite badge · turn · elapsed · tool count.

Open with `/subinspect <id>` (direct) or `/subinspect` (picker over current
subagents). The overlay stays open and live-updates as events stream in; works on
running **and** finished subagents (so you can review how it got its result).
See `docs/SPEC-inspector.md` for the locked decisions (dataset model, scroll
behavior, optional-spec). Requires TUI mode (the picker falls back to
`/subinspect <id>` in print/json mode).

On a subagent's finish, the `subagent-result` follow-up is **trimmed** (spec
§Q7): just `[Subagent #N ⚡lite · user-spawned] finished in Xs.` + the result
body (spilled to `result.txt` if >8KB). For user-origin spawns it prepends a
`Task:` echo of what you asked (spec §Q7-supplement) — the main agent has no
other way to know what a user-initiated spawn was for. Full per-call args +
results live in `session.jsonl` on disk and via `/subinspect`.

### Inspector keys

| Key | Action |
|---|---|
| `k` / `↑` | line up |
| `j` / `↓` | line down |
| `Ctrl-b` / `PgUp` | page up |
| `Ctrl-f` / `PgDn` | page down |
| `g` / `Home` | top |
| `G` / `End` | bottom (re-attaches auto-follow) |
| `q` / `Esc` | close |

New events auto-scroll while you're at the bottom (tail-follow); scrolling up
pauses auto-follow until you jump back to the bottom (`G`/`End`).

**Memory**: the inspector only retains the **current turn** in memory — opening
`/subinspect` after a `/subcont` resets to the new turn. Prior turns' full
transcripts remain on disk in the session file at the path shown in the widget.

## Feature 2 (disallow-list — implemented)

A per-subagent extension **disallow-list** for full-mode subagents is
implemented via [Configuring disallowed extensions](#configuring-disallowed-extensions).

pi has no `--exclude-extensions` flag, so the disallow effect is achieved by
enumerating every extension the child would load (all three discovery sources),
subtracting the disallowed entries, and spawning the child with
`--no-extensions -e <each survivor>`. Because the enumeration is faithful to
pi's own discovery, no currently-loaded extension is silently dropped — only
the disallowed ones are omitted. Lifted only when the list actually matches
(criterion b), so an empty/stale list is a true no-op.

## Orchestration (named agents, chains, multi-agent workflows)

Three execution modes (full design: [`docs/SPEC-orchestration.md`](./docs/SPEC-orchestration.md), revamp: [`docs/SPEC-revamp.md`](./docs/SPEC-revamp.md)):

1. **Mode 1 (preserved)** — the main agent calls `subagent_create`/`subagent_continue`
   sequentially, reads each follow-up, decides the next call. Zero new tools.
2. **Mode 2 (`orchestrate` tool + `/subchain`)** — a multi-agent **chain** runs in the
   background with **auto-advance** (each step's output spliced into the next's
   `{previous}` placeholder) and one aggregate follow-up on completion. Fire-and-forget.

> **Filesystem-native discovery (spec §Q6):** named agents live as files at
> `~/.pi/agent/agents/*.md` and chain templates at `~/.pi/agent/chains/*.yaml` —
> `ls` them before referencing. No LLM tool for catalog lookup (was
> `subagent_catalog` — removed in the revamp collapse to 4 tools).

### Named agents (`~/.pi/agent/agents/*.md`)

Markdown files with YAML frontmatter. `name` + `description` required; the body
is the agent's system prompt.

```markdown
---
name: scout
description: Fast codebase recon — map files, entry points, and structure.
tools: read, grep, find, ls, bash            # allowlist → --tools (optional)
disallowedTools: edit, write                # denylist → --exclude-tools (optional)
model: neuralwatt/glm-5.2-short             # supports provider/id:thinking (optional)
extensions: npm:pi-neuralwatt-provider      # additive -e (optional, never drops the provider)
skills: ~/.pi/agent/skills/grilling         # additive --skill (optional)
worktree: true                              # force worktree isolation for this agent (optional)
---
You are a fast, surgical code scout. Reconnaissance only — never make edits.
```

Spawn-flag overlay (additive over the mode base): `extensions`/`skills` only
ever ADD; `disallowedTools` is deny-first (then `tools` allowlist-resolves);
`model` overrides. The system prompt → a temp file + `--append-system-prompt`.

### Chain templates (`~/.pi/agent/chains/*.yaml`)

YAML frontmatter with a `steps` array (each `{agent, task}`); body is an optional
template-level nudge.

```yaml
---
name: recon-and-synth
description: scout recon then synthesizer condenses. Minimal 2-step test chain.
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

`{input}` substitutes the chain's input arg; `{previous}` substitutes the prior
step's output wrapped in a provenance envelope (`[Handoff from agent: <name>]` +
step index). Steps reference named agents only (no inline specs). On failure the
chain **halts** at the failing step (prior steps persist for inspection); on
explicit removal (`/subrm C1`) mid-run it **aborts** (the `aborted` flag blocks
auto-advance + the complete follow-up; one aborted summary instead).

### The 4 LLM tools (spec §Q6)

| Tool | Purpose |
|---|---|
| `subagent_create` | Spawn a background subagent (`task` required). `lite: true` → restricted read/bash/grep/find/ls + no extensions + thinking off. Optional `agent` runs under a named role from `~/.pi/agent/agents/*.md`. Living + past subagents: `ls ~/.pi/agent/runs/<id>/`. |
| `subagent_continue` | Continue or answer a subagent (`id` + `prompt`). Two uses: (a) give a finished subagent more instructions; (b) **answer a subagent that ended its turn with `??`** (its follow-up said `blocked, asking:`). Preserves the subagent's original lite/full mode. |
| `subagent_remove` | Stop + clean one subagent (`id`: `#N` / `N` / `CN` / `CN@step`) — kills if active, removes its RunDir. **Omit `id`** to clear all of the agent's *own* spawns (origin=`agent`) only — never the user's; the user uses `/subclear` for a full clear. |
| `orchestrate` | Mode 2 trigger: exactly one of `template` (named, from `~/.pi/agent/chains/*.yaml`), `steps` (inline), or `chains` (run multiple); `template` > `steps`. `input` substitutes `{input}`; `lite` applies to every step. Fire-and-forget spawn confirmation; terminal `chain-result` follow-up on completion/halt. Chains **can't ask mid-run** (see Cooperation). |

### Cooperation: the `??` turn-yield channel (spec §Q4–Q7)

A standalone subagent (not a chain step) can end its turn with a `??` line to
**ask the main agent a question mid-task** rather than guess:

```
[Subagent #2 · user-spawned] blocked, asking:
Task: draft a migration plan for auth
should I delete the old JWT helper or keep it?
```

- The subagent's status flips to `blocked` (glyph `⧗`); the main agent gets a
  `subagent-request` follow-up with the question + (for user-origin) a `Task:`
  echo so it knows what you originally asked.
- Answer via `/subcont #2 <answer>` (user) or `subagent_continue` (agent) — the
  subagent resumes with your answer and finishes.
- **Chains can't use `??`** — the answer channel has no route in a pipeline. A
  step that wrongly yields is treated as a chain **failure** (terminal
  `chain-result` follow-up, no `subagent-request`, never hangs; the failed step
  persists for `/subinspect` — spec §Q11d). If a step genuinely needs input,
  spawn it standalone via `subagent_create` instead.
- **Identity prompt (spec §Q10):** agent-origin spawns get a purpose-revealing
  header in their `prompt.md` (the subagent knows it's a subagent, not the
  main agent) — not role-forcing, just honest about its position. Written to
  `prompt.md` so it survives across `/subcont` turns.

### Git worktree isolation (§12)

When `config.json` sets `worktree: "always"` **and** the cwd is a git repo, every
spawned subagent / chain runs in a **fresh git worktree** on a new branch — so
concurrent agents can't clobber each other's in-flight file edits.

- **Granularity:** one worktree per chain (shared across its linear steps — a
  `worker` step sees the `planner` step's edits) + one per standalone
  `/sub`/`/sublite`/`subagent_create`. Parallel chains → separate worktrees.
- **Lifecycle:** the worktree **dir** is removed on finalize/abort/explicit
  removal; the **branch** is always kept (committed work stays recoverable).
  **Dirty** worktrees are kept + flagged (never silently force-destroyed) — use
  `/subrm C1` to force-discard.
- **Per-agent override:** `worktree: true` in an agent-def forces isolation even
  when config is `off`. Non-git cwd → shared-tree fallback.
- Worktree children always spawn with `--no-approve` (deterministic trust). The
  neuralwatt provider guarantee is unaffected (loaded via global packages + `-e`,
  not project-local). Caveat: committed project-local `.pi/extensions` won't load
  in worktree children.
