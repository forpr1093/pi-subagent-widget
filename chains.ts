// Chain-template discovery (orchestration, spec §4).
//
// Mirrors agents.ts: loadChainsFromDir / findNearestProjectChainsDir /
// discoverChains. Reuses pi's bundled `parseFrontmatter` (utils/frontmatter.js)
// which parses YAML via the `yaml` module — so chain `steps` come back as a
// parsed array of {agent, task}, not a flat string. No separate YAML parser.
//
// Chain files: ~/.pi/agent/chains/*.yaml (+.yml); project .pi/chains/ with scope
// "both"/"project" (project overrides same-name). Read fresh on every call.
// See SPEC-orchestration.md §4.1 (location) and §4.2 (schema).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@mariozechner/pi-coding-agent";

export type ChainScope = "user" | "project" | "both";

/** One step in a chain template. Mirrors the stock `subagent` example's ChainItem. */
export interface ChainStepDef {
  agent: string;
  task: string;
}

export interface ChainTemplate {
  name: string;
  description: string;
  steps: ChainStepDef[];
  body: string; // optional template-level nudge (stored; not applied per-step in v1)
  source: "user" | "project";
  filePath: string;
}

export interface ChainDiscoveryResult {
  chains: ChainTemplate[];
  projectChainsDir: string | null;
}

/** Coerce a parsed `steps` value into ChainStepDef[], dropping invalid entries. */
function coerceSteps(
  raw: unknown,
  filePath: string,
): ChainStepDef[] {
  if (!Array.isArray(raw)) return [];
  const out: ChainStepDef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const agent = (item as Record<string, unknown>).agent;
    const task = (item as Record<string, unknown>).task;
    if (typeof agent === "string" && typeof task === "string") {
      out.push({ agent, task });
    } else {
      console.warn(
        `subagent-widget: chain "${filePath}" has a step missing agent/task; skipped.`,
      );
    }
  }
  return out;
}

function loadChainsFromDir(
  dir: string,
  source: "user" | "project",
): ChainTemplate[] {
  const chains: ChainTemplate[] = [];

  if (!fs.existsSync(dir)) return chains;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return chains;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<{
      name?: string;
      description?: string;
      steps?: unknown;
    }>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const steps = coerceSteps(frontmatter.steps, filePath);
    if (steps.length === 0) continue;

    chains.push({
      name: frontmatter.name,
      description: frontmatter.description,
      steps,
      body,
      source,
      filePath,
    });
  }

  return chains;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from cwd to the nearest `<dir>/.pi/chains/` directory. */
function findNearestProjectChainsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "chains");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * Discover chain templates. User dir = <agentDir>/chains; project dir (when
 * scope includes "project") = nearest .pi/chains walking up from cwd. When
 * scope is "both", project chains override same-name user chains. Fresh per call.
 */
export function discoverChains(
  cwd: string,
  scope: ChainScope,
): ChainDiscoveryResult {
  const userDir = path.join(getAgentDir(), "chains");
  const projectChainsDir = findNearestProjectChainsDir(cwd);

  const userChains =
    scope === "project" ? [] : loadChainsFromDir(userDir, "user");
  const projectChains =
    scope === "user" || !projectChainsDir
      ? []
      : loadChainsFromDir(projectChainsDir, "project");

  const chainMap = new Map<string, ChainTemplate>();
  const addTo =
    scope === "both"
      ? [...userChains, ...projectChains]
      : scope === "user"
        ? userChains
        : projectChains;
  for (const chain of addTo) chainMap.set(chain.name, chain);

  return { chains: Array.from(chainMap.values()), projectChainsDir };
}

export function formatChainList(
  chains: ChainTemplate[],
  maxItems: number,
): { text: string; remaining: number } {
  if (chains.length === 0) return { text: "none", remaining: 0 };
  const listed = chains.slice(0, maxItems);
  const remaining = chains.length - listed.length;
  return {
    text: listed
      .map(
        (c) =>
          `${c.name} (${c.source}): ${c.description} [${c.steps.map((s) => s.agent).join(" → ")}]`,
      )
      .join("; "),
    remaining,
  };
}
