// Extension allow-/disallow-lists read from the sidecar config.json.
//
// `liteAllowedExt` (existing): the allow-list for lite subagents — each entry is
// passed to `pi -e` after `--no-extensions`. Read fresh on every lite spawn.
// `disallowedExt` (new): the disallow-list for FULL subagents — when non-empty
// and matching ≥1 declared extension, the spawn is sandboxed to the survivors
// via `--no-extensions -e <each>`; otherwise no flags and pi discovers all.
// See disallow.ts and PLAN-disallow-list.md.
//
// Format: ["npm:pi-neuralwatt-provider", ...] under each key, or a bare array.
// Entries are any form `pi -e` accepts (npm:, git:, or file/dir paths).
import * as fs from "fs";
import * as path from "path";

export function getLiteConfigPath(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "config.json");
}

export function loadLiteExtensions(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(getLiteConfigPath(), "utf8"));
    if (Array.isArray(raw)) return raw.filter((e) => typeof e === "string");
    if (raw && typeof raw === "object" && Array.isArray(raw.liteAllowedExt)) {
      return raw.liteAllowedExt.filter((e: any) => typeof e === "string");
    }
  } catch {}
  return ["npm:pi-neuralwatt-provider"]; // fallback if missing/invalid
}

// Disallow-list for full-mode subagents. Empty fallback = no-op (pi discovers
// all extensions). Read fresh on every full spawn, including /subcont.
export function loadDisallowedExtensions(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(getLiteConfigPath(), "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.disallowedExt)) {
      return raw.disallowedExt.filter((e: any) => typeof e === "string");
    }
  } catch {}
  return []; // no-op fallback — pi's normal discovery runs untouched
}
