# Implementation Plan — `disallowedExt` for full-mode subagents

> Status: **planned, not yet implemented.** Checkpoint `53f1d89` is the revert
> baseline (`git reset --hard 53f1d89`).
>
scope: `subagent-widget/` only. No changes to `pi-subagents/` (reference) or
any other extension.

## Goal & success criteria

**Goal:** A global, config-driven extension **disallow-list** that prevents
specific extensions from loading in **full-mode** subagents (`/sub`,
`lite=false`), with:

- zero behavior change when the list is empty, and
- no silent loss of currently-loaded extensions when the list is active.

**Verify by:**

1. `config.json` with `"disallowedExt": []` → `/sub` spawns with **no**
   `-e`/`--no-extensions` flags (byte-identical to today). ✓
2. `disallowedExt: ["@gotgenes/pi-permission-system"]` → `/sub` spawn args
   contain `--no-extensions` + `-e` for every survivor **except**
   `npm:@gotgenes/pi-permission-system`. All other declared extensions
   (8 `packages` entries + 2 local dirs) preserved. ✓
3. A stale/typo entry matching nothing → no flags injected (no-op). ✓
4. Lite mode (`/sublite`) args **unchanged**. ✓
5. `/subcont` re-reads config fresh each turn. ✓

## Resolved design (from grilling)

| Branch | Decision |
|---|---|
| Surface | `disallowedExt: string[]` in `subagent-widget/config.json` |
| Scope | Full mode only; lite stays on `liteAllowedExt` (L1) |
| Gate | Inject `--no-extensions -e <survivors>` **only if ≥1 declared ext matches** the disallow list (criterion b) |
| Enumeration | Global-local + project-local (`resolveExtensionEntries` port) + `settings.json["packages"]` — faithful to pi's child discovery |
| Matching | **Strict** — `parseNpmPackageName` normalization (strip `npm:` + `@version`, keep `@scope`, case-insensitive); local paths match by top-level dir basename under `extensions/` |
| Continue | Fresh read each spawn, no freeze |

### Matching — strict (D1 = ii)

A disallow entry must match a declared entry **exactly** after standard
normalization:

| Disallow entry | Declared entry | Match? |
|---|---|---|
| `@gotgenes/pi-permission-system` | `npm:@gotgenes/pi-permission-system` | ✅ |
| `@gotgenes/pi-permission-system` | `npm:@gotgenes/pi-permission-system@2.0` | ✅ (version dropped) |
| `npm:@gotgenes/pi-permission-system` | `npm:@gotgenes/pi-permission-system` | ✅ (npm: prefix optional on the disallow side) |
| `pi-permission-system` (bare, unscoped) | `npm:@gotgenes/pi-permission-system` (scoped) | ❌ **no match** |
| `pi-rtk-optimizer` | `npm:pi-rtk-optimizer` | ✅ |

Normalization applied to **both** the disallow entry and the declared entry
before comparison:

1. Strip a leading `npm:` prefix if present.
2. Strip a trailing `@<version>` (the regex's group 2), **keeping** `@scope`.
3. Lowercase.

So `npm:@scope/pkg@2.0` → `@scope/pkg`. A bare `pkg` does **not** match
`@scope/pkg`.

> Rationale: predictable, no over-matching. The cost is you must type the
> scope for scoped packages. Accepted.

## File-by-file changes

### 1. `config.ts` (~+8 lines)

Add `loadDisallowedExtensions()` mirroring the existing `loadLiteExtensions()`,
reading `disallowedExt` from the same sidecar (`getLiteConfigPath`). Fallback
`[]`. Cohesive here — both functions read `config.json`.

```ts
export function loadDisallowedExtensions(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(getLiteConfigPath(), "utf8"));
    if (Array.isArray(raw)) return raw.filter((e) => typeof e === "string");
    if (raw && typeof raw === "object" && Array.isArray(raw.disallowedExt)) {
      return raw.disallowedExt.filter((e: any) => typeof e === "string");
    }
  } catch {}
  return []; // no-op fallback — pi's normal discovery runs untouched
}
```

### 2. `disallow.ts` (NEW, ~90 lines) — pure module, no process state

Pure functions only (so they're unit-testable without process state):

- `parseNpmName(spec): string | undefined`
  - Port of `pi-subagents`' regex: `^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$`.
  - Strips `npm:` prefix, drops `@version`, keeps `@scope`, lowercases.
  - Returns `undefined` for unparseable specs.
- `normalizeForMatch(entry: string): string`
  - One canonical normalizer applied to both sides of the comparison:
    npm-spec → parsed name; else the raw string, lowercased.
- `resolveExtensionEntries(dir: string): string[] | null`
  - **Faithful port** of pi's `loader.js` `resolveExtensionEntries`:
    `package.json` `pi.extensions` field first → else `index.ts` → else
    `index.js` → else `null`. Returns resolved absolute paths.
- `discoverEntryPaths(extDir: string): string[]`
  - readdirSync + `resolveExtensionEntries` per subdir (mirrors
    `discoverExtensionsInDir`), one level deep.
- `loadDeclaredExtensions(cwd: string): { entry: string; key: string }[]`
  - Combines: global-local (`~/.pi/agent/extensions/`) + project-local
    (`${cwd}/.pi/extensions/`) + `settings.json["packages"]` entries.
  - Dedup by resolved path. `entry` = the `-e`-ready string; `key` = the
    `normalizeForMatch(entry)` value.
- `resolveFullModeExtArgs(cwd: string): string[] | null`
  - **The gate (criterion b).** Reads `loadDisallowedExtensions()`:
    - empty list → `null` (no-op).
    - non-empty → enumerate declared; if no declared `key` matches any
      disallow `key` → `null` (no-op; stale/typo entries don't trigger).
    - ≥1 match → return the survivor `entry` strings (declared − matched).

### 3. `index.ts` (surgical — one block in `spawnAgent`)

In the full-mode `else` branch (currently empty), add:

```ts
} else {
  // Full mode: let pi discover all extensions unless the disallow list
  // actually matches — then sandbox to survivors via --no-extensions -e.
  const extArgs = resolveFullModeExtArgs(process.cwd());
  if (extArgs) {
    args.push("--no-extensions");
    for (const e of extArgs) args.push("-e", e);
  }
}
```

Plus the import: `import { resolveFullModeExtArgs } from "./disallow.ts";`

**No change** to: the lite branch, `--tools`, `--thinking`, `--no-skills`,
`--mode`, `--session`. Those axes are untouched.

### 4. `config.json`

Add `"disallowedExt": []` (no-op default). Example after edit:

```json
{
  "liteAllowedExt": ["npm:pi-neuralwatt-provider"],
  "disallowedExt": []
}
```

### 5. `README.md`

- New section "Configuring disallowed extensions": the key, scope (full mode
  only), strict matching semantics with the table above, the gate (no-op when
  empty or stale), no-silent-drop guarantee, the "fresh read each spawn"
  behavior.
- Update "Feature 2 (deferred)": the disallow-list is now implemented via
  `--no-extensions` + survivor re-emission. Native `--exclude-extensions` is
  still absent, but allow-list-subtraction achieves the disallow effect
  faithfully.

### 6. Tests — `test/disallow.test.ts` (recommended, zero-dep)

`node --test` (built-in), mirroring `pi-subagents`' unit-test style. Cover the
riskiest pure logic:

- `parseNpmName` / `normalizeForMatch`:
  - `npm:pkg` → `pkg`
  - `npm:pkg@2.0` → `pkg`
  - `npm:@scope/pkg` → `@scope/pkg`
  - `npm:@scope/pkg@2.0` → `@scope/pkg`
  - bare `pkg` → `pkg`
  - `git:...` / local path → unchanged (lowercased)
- Matching:
  - `@gotgenes/pi-permission-system` matches `npm:@gotgenes/pi-permission-system` ✓
  - `@gotgenes/pi-permission-system` matches `npm:@gotgenes/pi-permission-system@2.0` ✓ (version-insensitive)
  - bare `pi-permission-system` does **not** match `npm:@gotgenes/pi-permission-system` ✓ (strict)
  - local dir `pi-subagents` matches a survivor whose path is under
    `.../extensions/pi-subagents/` ✓
  - stale entry `does-not-exist` → no match ✓
- `resolveFullModeExtArgs` gate (with stubbed enumeration via temp dirs):
  - empty list → `null` ✓ (criterion b)
  - non-empty-but-no-match → `null` ✓ (criterion b)
  - ≥1 match → survivors exclude only matched entries; all other declared
    extensions preserved (incl. local exts loaded via `package.json`
    `pi.extensions` and via `index.ts`) ✓

**Left untested** (would need heavier fixtures): full filesystem enumeration
I/O. Optional follow-up if the temp-dir fixture is straightforward.

## Failure-mode walkthroughs

### FM-1: empty disallow list

```
disallowedExt: []  →  resolveFullModeExtArgs() returns null
                   →  spawnAgent full-branch adds NO extension flags
                   →  pi child runs `discoverAndLoadExtensions` normally
```

Result: byte-identical to today. ✓

### FM-2: one scoped disallow entry matches one package

```
disallowedExt: ["@gotgenes/pi-permission-system"]
declared = [
  "npm:pi-neuralwatt-provider", ..., "npm:@gotgenes/pi-permission-system",
  <pi-subagents dir>, <subagent-widget dir>
]
matches = ["npm:@gotgenes/pi-permission-system"]   (1 entry)
survivors = declared − matches
spawn args: --no-extensions -e npm:pi-neuralwatt-provider ... (no @gotgenes) \
            -e <pi-subagents index.ts path> -e <subagent-widget index.ts path>
```

Result: only `pi-permission-system` blocked; the other 7 packages + 2 local
exts loaded. ✓ No silent drop of local exts (D2 resolved by faithful
enumeration).

### FM-3: stale / typo entry matches nothing

```
disallowedExt: ["typo-pkg"]
declared = [...8 packages + 2 local...]
matches = []
→ resolveFullModeExtArgs() returns null   (criterion b)
→ NO extension flags injected
→ pi discovers all (same as FM-1)
```

Result: no surprise `--no-extensions` from a stale list. ✓

### FM-4: continue (`/subcont`) after editing the list

```
turn 1: disallowedExt: ["@gotgenes/pi-permission-system"]  → blocks it
(user edits config.json, removes the entry)
turn 2 (/subcont): resolveFullModeExtArgs() returns null    → loads all
```

Result: config read fresh each spawn; mid-conversation edits take effect on
the next turn. Matches existing `loadLiteExtensions` precedent. ✓

## Risks

- **Discovery drift**: if a future pi version adds a *fourth* discovery
  source beyond (global-local / project-local / `settings.json["packages"]`),
  my enumeration would miss it → silent drop *when disallow is active*.
  Mitigation: faithful port of all three current sources + a README note that
  the snapshot reflects pi 0.80.x discovery (`loader.js`
  `discoverAndLoadExtensions`). Low likelihood; three-source model has been
  stable.
- **Strict matching friction**: scoped packages require the scope in the
  disallow entry (e.g. `@gotgenes/pi-permission-system`, not bare
  `pi-permission-system`). Accepted trade-off for predictability (D1 = ii).
- **`-e npm:spec` / `-e <dir>` / `-e /abs/file.ts` resolution**: proven by the
  existing lite-mode path, which already re-emits `npm:` specs and local paths
  via `-e`. Low risk.

## Out of scope

- Per-spawn parameter on `subagent_create` (chose global config; rejected
  in grilling Q1).
- Applying disallow to lite mode (L1; lite stays on `liteAllowedExt`).
- Unscoped-leaf / substring matching (rejected; D1 = strict ii).
- Agent-definition files / frontmatter `extensions:` field (no persistent
  agents in this widget).
- Enumerating the parent process's own CLI `-e` flags (they never reach the
  child today, so not a regression).

## Pre-implementation checklist

- [x] Grilling complete — all 8 branches resolved.
- [x] Checkpoint commit `53f1d89` created.
- [x] pi discovery verified against `loader.js` source (3 sources).
- [x] Real `settings.json["packages"]` inspected (scoped permission-system
      confirmed → drove D1 strict decision).
- [ ] D1 strict confirmed by user (done — strict).
- [ ] Implement.
- [ ] Run `disallow.test.ts` + manual spawn-args verification (criteria 1–5).
- [ ] README updated.
- [ ] Commit on top of `53f1d89`.
