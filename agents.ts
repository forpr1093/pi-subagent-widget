// Named-agent discovery + spawn-flag construction (orchestration, spec §3).
//
// Ports the stock `subagent` example's discovery (loadAgentsFromDir,
// findNearestProjectAgentsDir, discoverAgents, formatAgentList) into this
// extension's 2-space style, and EXTENDS the agent-def schema with three
// additive/denylist fields the stock example lacks:
//   extensions      → -e (additive to the mode base; never drops the provider)
//   skills          → --skill (additive; replaces lite's --no-skills)
//   disallowedTools → --exclude-tools (deny-first, then tools allowlist-resolved)
// `agentConfigFlags` is pure so the flag order can be reviewed without a runtime.
//
// See SPEC-orchestration.md §3 (schema) and §3.3 (spawn-flag construction).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@mariozechner/pi-coding-agent";
import { loadDisallowedExtensions } from "./config.ts";
import {
  effectiveDisallowedExtensions,
  normalizeForMatch,
} from "./disallow.ts";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[]; // allowlist → --tools (Q14)
  disallowedTools?: string[]; // denylist → --exclude-tools (NEW, Q21)
  model?: string; // → --model (supports provider/id:thinking)
  extensions?: string[]; // → -e (additive, NEW)
  skills?: string[]; // → --skill (additive, NEW)
  worktree?: boolean; // → §12 override: force a worktree for this agent even when config is "off"
  systemPrompt: string; // → temp file + --append-system-prompt (spec §3.3)
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

/** Split a comma-separated frontmatter list field into trimmed, non-empty entries. */
function parseListField(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(
      content,
    );
    if (!frontmatter.name || !frontmatter.description) continue;

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseListField(frontmatter.tools),
      disallowedTools: parseListField(frontmatter.disallowedTools),
      model: frontmatter.model,
      extensions: parseListField(frontmatter.extensions),
      skills: parseListField(frontmatter.skills),
      worktree: frontmatter.worktree === true || frontmatter.worktree === "true",
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from cwd to the nearest `<dir>/.pi/agents/` directory. */
function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * Discover named agents. User dir = <agentDir>/agents; project dir (when scope
 * includes "project") = nearest .pi/agents walking up from cwd. When scope is
 * "both", project agents override user agents with the same name. Read fresh on
 * every call — no /reload (matches the widget's config.json/disallow pattern).
 */
export function discoverAgents(
  cwd: string,
  scope: AgentScope,
): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents =
    scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir
      ? []
      : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();
  const addTo =
    scope === "both"
      ? [...userAgents, ...projectAgents]
      : scope === "user"
        ? userAgents
        : projectAgents;
  for (const agent of addTo) agentMap.set(agent.name, agent);

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(
  agents: AgentConfig[],
  maxItems: number,
): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed
      .map((a) => `${a.name} (${a.source}): ${a.description}`)
      .join("; "),
    remaining,
  };
}

/**
 * Pure builder for the agent-def CLI flag overlay (spec §3.3). Emits only flags
 * the agent-def actually carries; the spawn path decides base flags per mode.
 * Order: extensions (-e additive), skills (--skill additive), disallowedTools
 * (--exclude-tools, deny-first), tools (--tools, allowlist-resolved), model.
 * The system prompt is NOT included here — it needs a temp file and is appended
 * separately by the spawn path. Pure so the flag order is reviewable offline.
 */
export function agentConfigFlags(a: AgentConfig): string[] {
  // R1 (6.1): filter additive extensions against the disallow list so a
  // confirmed project agent can't re-load subagent-widget (or any disallowed
  // ext) into the child via explicit -e — that path bypasses the trust gate
  // (pi applies additionalExtensionPaths unconditionally). Skills are prompts,
  // not executable code, so they aren't a recursion vector and stay unfiltered.
  // Match is normalized (npm: prefix + @version stripped), mirroring disallow.ts.
  const disallow = new Set(
    effectiveDisallowedExtensions(loadDisallowedExtensions()).map(normalizeForMatch),
  );
  const out: string[] = [];
  for (const e of a.extensions ?? [])
    if (!disallow.has(normalizeForMatch(e))) out.push("-e", e);
  for (const s of a.skills ?? []) out.push("--skill", s);
  if (a.disallowedTools?.length)
    out.push("--exclude-tools", a.disallowedTools.join(","));
  if (a.tools?.length) out.push("--tools", a.tools.join(","));
  // model: "default" is a no-op keyword meaning "defer to pi's default model
  // resolution" (settings.json defaultModel) — identical to omitting the field,
  // just an explicit spelling for agent-defs that want the line present-but-neutral.
  if (a.model && a.model !== "default") out.push("--model", a.model);
  return out;
}
