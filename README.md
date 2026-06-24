# subagent-widget

A pi extension that spawns background subagents with live stacking widgets.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Orchestration center: shared state (`agents` map), `spawnAgent`/`processLine`, all tools + commands + `session_start`. Loaded by pi's global auto-discovery for `extensions/<name>/index.ts`. |
| `inspector.ts` | Floating read-only inspector overlay + event-shaping helpers (`cap`, `stringifyVal`, `appendText`, `wrapLine`, `buildInspectorLines`, `InspectorComponent`, `openInspector`). |
| `widget.ts` | Compact stacked per-agent widget factory (`buildSubagentWidget`). |
| `session.ts` | JSONL session-file make/delete helpers. |
| `config.ts` | Lite-extension allow-list loader (`loadLiteExtensions`). |
| `types.ts` | Shared types: `SubState`, `InspectorEvent`. |
| `config.json` | List of extension names that lite subagents may load. |
| `README.md` | This file. |

Pure/testable modules (`inspector`, `widget`, `session`, `config`, `types`) hold no
process state; `index.ts` is the center that wires them together. Relative imports
use `.ts` extensions, matching pi's own source style and the jiti loader.

## Commands

| Command | Description |
|---|---|
| `/sub <task>` | Spawn a **full** subagent (all extensions, default tools/thinking/model). |
| `/sublite <task>` | Spawn a **lite** subagent (only `config.json` extensions, restricted tools `read,bash,grep,find,ls`, thinking off). |
| `/subcont <id> <prompt>` | Continue subagent `#<id>`'s conversation (preserves its lite/full mode). |
| `/subrm <id>` | Remove subagent `#<id>` — kills process, removes widget, deletes its JSONL session file. |
| `/subclear` | Clear all subagents (same cleanup as `/subrm` for each). |
| `/subinspect [id]` | Open a floating, read-only, live-updating **inspector** for subagent `#<id>`. With no `id`, shows a picker of current subagents. See [Inspector](#inspector) below. |

The main agent also has matching tools: `subagent_create` (with a `lite` parameter), `subagent_continue`, `subagent_remove`, `subagent_list`, `subagent_inspect`.

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

```json
{
  "liteAllowedExt": ["npm:pi-neuralwatt-provider"],
  "disallowedExt": ["@gotgenes/pi-permission-system"]
}
```

When the list is **non-empty and matches at least one declared extension**, the
full subagent is sandboxed to the survivors via `--no-extensions -e <each>` —
so the disallowed extension never loads. When the list is empty or matches
nothing (e.g. a stale/typo entry), **no extension flags are injected** and pi's
normal discovery runs untouched: zero behavior change in the common case.

The survivor list faithfully reproduces what the child would have loaded —
**all three discovery sources** (global-local `~/.pi/agent/extensions/*/`,
project-local `.pi/extensions/*/`, and `settings.json["packages"]`) minus only
the disallowed entries. No silent drops of currently-loaded extensions.

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
- Discovery mirrors pi 0.80.x (`loader.js` `discoverAndLoadExtensions`):
  global-local + project-local + `settings.json["packages"]`. If pi adds a
  fourth source in future, disallowed entries there won't be reachable.

## Session file cleanup

Each subagent writes its conversation to a JSONL file under `~/.pi/agent/sessions/subagents/`. These files are deleted when the subagent is removed (`/subrm`, `/subclear`, `subagent_remove`, or on `session_start`/resume). Subagents that finish naturally keep their file (so `/subcont` works mid-session) until explicitly removed.

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
See `SPEC-inspector.md` for the locked decisions (dataset model, scroll
behavior, optional-spec). Requires TUI mode (the picker falls back to
`/subinspect <id>` in print/json mode).

On a subagent's finish, the follow-up "subagent-result" message now begins with
a **tool-name-only summary** (e.g. `Tools called (7): bash ×4, read ×2, edit ×1`);
full per-call args/results live only in the inspector.

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
