// Lite-subagent extension allow-list.
//
// Sidecar JSON (sibling of this directory's index.ts) lists extension names
// passed to `pi -e` for lite subagents. Read fresh on every lite spawn, so
// edits take effect immediately (no /reload).
//
// Format: ["npm:pi-neuralwatt-provider", ...] under "liteAllowedExt", or a bare
// array. Entries are any form `pi -e` accepts (npm:, git:, or file/dir paths).
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
