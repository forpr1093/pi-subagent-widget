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

## Feature 2 (deferred)

A per-subagent extension exclude-list (e.g. to exclude `pi-permission-system` from
full subagents) is **not implemented**. pi has no `--exclude-extensions` flag and
no per-invocation settings override; the `extensions` settings array only
excludes paths you've added there, not auto-discovered/`packages`-sourced
extensions, and `pi config` disables them globally (not per-subagent). Deferred
until pi adds a per-process exclusion flag or mechanism.
