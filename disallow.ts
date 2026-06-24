// Extension disallow-list for full-mode subagents.
//
// When `disallowedExt` in config.json is non-empty AND matches at least one
// declared extension, a full-mode subagent is sandboxed to the survivors via
// `--no-extensions -e <each>`. When the list is empty or matches nothing,
// NO extension flags are injected and pi's normal discovery runs untouched
// (criterion b — see PLAN-disallow-list.md).
//
// Pure with respect to process state: the only I/O is reading config.json,
// settings.json, and the extensions dirs. `filterSurvivors` is fully pure and
// unit-tested. `resolveFullModeExtArgs` is the entry point used by index.ts.
//
// Discovery is a faithful port of pi's `loader.js`
// (`discoverAndLoadExtensions` + `resolveExtensionEntries` + `readPiManifest`)
// so the survivor list reproduces what the child would have loaded, minus only
// the disallowed entries — no silent drops.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadDisallowedExtensions } from "./config.ts";

/** A declared extension: `entry` is the `-e`-ready form, `key` is the normalized match key. */
export interface DeclaredExt {
  entry: string;
  key: string;
}

/** The agent dir, matching the widget's homedir-based path convention (session.ts). */
function defaultAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * Parse the package name out of an npm spec. Port of pi-subagents'
 * `parseNpmPackageName`: keeps `@scope`, drops `@version`, lowercases. The
 * caller strips the `npm:` prefix. Returns undefined if unparseable.
 *
 *   pkg                  -> pkg
 *   pkg@2.0              -> pkg
 *   @scope/pkg           -> @scope/pkg
 *   @scope/pkg@2.0       -> @scope/pkg
 */
export function parseNpmName(spec: string): string | undefined {
  const s = spec.trim();
  const match = s.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  const packageName = match?.[1] ?? s;
  return packageName ? packageName.toLowerCase() : undefined;
}

/**
 * One canonical normalizer applied to BOTH sides of the comparison (disallow
 * entries and declared package entries). Strict: strips the `npm:` prefix and
 * any `@<version>`, keeps `@scope`, lowercases. A bare `pkg` does NOT match
 * `@scope/pkg`.
 *
 *   npm:@scope/pkg@2.0  -> @scope/pkg
 *   @scope/pkg@2.0       -> @scope/pkg   (bare versioned form, no npm: prefix)
 *   @scope/pkg           -> @scope/pkg
 *   npm:pkg             -> pkg
 *   git:.../path        -> git:.../path   (URL/path forms lowercased verbatim)
 *
 * URLs/paths are lowercased verbatim — parseNpmName would mis-split an SSH
 * URL's `@host` as a version. Bare package names (incl. @scope/versioned) are
 * parsed so a user can write `@scope/pkg@2.0` to match `npm:@scope/pkg`.
 */
export function normalizeForMatch(entry: string): string {
  let s = entry.trim();
  if (s.startsWith("npm:")) s = s.slice(4).trim();
  if (s.startsWith("git:") || s.startsWith("file:") || s.includes("://")) {
    return s.toLowerCase();
  }
  // Bare package name (possibly @scope/versioned): strip @version, keep @scope.
  return (parseNpmName(s) ?? s).toLowerCase();
}

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

/** Read the `pi` field of a package.json (port of pi's readPiManifest). */
function readPiManifest(packageJsonPath: string): { extensions?: string[] } | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    if (pkg && typeof pkg === "object" && pkg.pi && typeof pkg.pi === "object") {
      const exts = (pkg.pi as { extensions?: unknown }).extensions;
      if (Array.isArray(exts)) {
        return { extensions: exts.filter((e): e is string => typeof e === "string") };
      }
    }
  } catch {}
  return null;
}

/**
 * Resolve extension entry points from a directory. Faithful port of pi's
 * `resolveExtensionEntries`:
 *   1. package.json with `pi.extensions` field -> the declared paths
 *   2. else index.ts
 *   3. else index.js
 *   4. else null
 * Returns resolved absolute paths, or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
  const packageJsonPath = path.join(dir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const manifest = readPiManifest(packageJsonPath);
    if (manifest?.extensions?.length) {
      const entries: string[] = [];
      for (const extPath of manifest.extensions) {
        const resolvedExtPath = path.resolve(dir, extPath);
        if (fs.existsSync(resolvedExtPath)) entries.push(resolvedExtPath);
      }
      if (entries.length > 0) return entries;
    }
  }
  const indexTs = path.join(dir, "index.ts");
  if (fs.existsSync(indexTs)) return [indexTs];
  const indexJs = path.join(dir, "index.js");
  if (fs.existsSync(indexJs)) return [indexJs];
  return null;
}

/**
 * Discover extensions in a directory. Faithful port of pi's
 * `discoverExtensionsInDir`: direct `*.ts`/`*.js` files plus subdirectories
 * resolved via `resolveExtensionEntries`. One level deep.
 *
 * Returns `{ entry, key }` pairs where `key` is the discovery name (bare file
 * name without extension, or the subdirectory name) — the form a user writes in
 * `disallowedExt` to block a local extension.
 */
function discoverInExtDir(extDir: string): DeclaredExt[] {
  if (!fs.existsSync(extDir)) return [];
  const out: DeclaredExt[] = [];
  try {
    const entries = fs.readdirSync(extDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(extDir, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
        // Direct file `extensions/foo.ts` -> key = "foo" (extension stripped).
        const key = entry.name.replace(/\.(ts|js)$/, "").toLowerCase();
        out.push({ entry: entryPath, key });
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        const resolved = resolveExtensionEntries(entryPath);
        if (resolved) {
          for (const e of resolved) out.push({ entry: e, key: entry.name.toLowerCase() });
        }
      }
    }
  } catch {}
  return out;
}

/** Read `packages` from settings.json (accepts string or {source} entries). */
function readSettingsPackages(settingsPath: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const pkgs = (raw as { packages?: unknown }).packages;
  if (!Array.isArray(pkgs)) return [];
  const out: string[] = [];
  for (const entry of pkgs) {
    const src =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string"
          ? (entry as { source: string }).source
          : null;
    if (src) out.push(src);
  }
  return out;
}

/**
 * Enumerate every extension a full-mode child would load: global-local +
 * project-local (discovered) + `settings.json["packages"]`. Each `entry` is
 * `-e`-ready (npm:/git: spec verbatim, or resolved local file path); each
 * `key` is the normalized match key. Dedup by resolved entry path.
 */
export function loadDeclaredExtensions(
  cwd: string,
  opts: { agentDir?: string; settingsPath?: string } = {},
): DeclaredExt[] {
  const globalExtDir = path.join(opts.agentDir ?? defaultAgentDir(), "extensions");
  const localExtDir = path.join(cwd, ".pi", "extensions");
  const settingsPath = opts.settingsPath ?? path.join(defaultAgentDir(), "settings.json");

  const out: DeclaredExt[] = [];
  const seen = new Set<string>();
  const push = (d: DeclaredExt) => {
    const id = path.resolve(d.entry);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(d);
    }
  };

  for (const d of discoverInExtDir(globalExtDir)) push(d);
  for (const d of discoverInExtDir(localExtDir)) push(d);
  for (const spec of readSettingsPackages(settingsPath)) {
    push({ entry: spec, key: normalizeForMatch(spec) });
  }
  return out;
}

/**
 * Pure gate: given declared extensions and a disallow list, return survivors or
 * null. Returns null (no-op) when disallowed is empty OR when nothing matched
 * (criterion b — stale/typo entries never trigger `--no-extensions`).
 */
export function filterSurvivors(
  declared: DeclaredExt[],
  disallowed: string[],
): string[] | null {
  if (disallowed.length === 0) return null;
  const disallowKeys = new Set(disallowed.map(normalizeForMatch));
  const survivors: string[] = [];
  let matched = 0;
  for (const d of declared) {
    if (disallowKeys.has(d.key)) {
      matched++;
      continue;
    }
    survivors.push(d.entry);
  }
  return matched === 0 ? null : survivors;
}

/**
 * Entry point for full-mode spawns. Returns the `-e` survivor list to inject
 * after `--no-extensions`, or null when no flags should be added. Reads
 * `disallowedExt` and the declared extensions fresh on every call (so edits to
 * config.json take effect on the next spawn, including `/subcont` — no freeze).
 */
export function resolveFullModeExtArgs(cwd: string): string[] | null {
  const disallowed = loadDisallowedExtensions();
  if (disallowed.length === 0) return null;
  const declared = loadDeclaredExtensions(cwd);
  return filterSurvivors(declared, disallowed);
}
