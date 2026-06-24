// Unit tests for the disallow-list pure logic. Run with:
//   node --test test/disallow.test.ts
// Mirrors pi-subagents' `node --test` style. The filesystem enumeration I/O
// (loadDeclaredExtensions/resolveFullModeExtArgs) is left untested here; the
// pure matching + gate logic below is the riskiest part and fully covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNpmName,
  normalizeForMatch,
  filterSurvivors,
  type DeclaredExt,
} from "../disallow.ts";

test("parseNpmName strips version, keeps scope, lowercases", () => {
  assert.equal(parseNpmName("pkg"), "pkg");
  assert.equal(parseNpmName("pkg@2.0"), "pkg");
  assert.equal(parseNpmName("@scope/pkg"), "@scope/pkg");
  assert.equal(parseNpmName("@scope/pkg@2.0"), "@scope/pkg");
  assert.equal(parseNpmName("Pkg@2.0"), "pkg");
  assert.equal(parseNpmName("@Scope/Pkg"), "@scope/pkg");
});

test("parseNpmName handles edge inputs", () => {
  assert.equal(parseNpmName(""), undefined);
  assert.equal(parseNpmName("   "), undefined);
  // A path-like spec: the regex's group 1 still captures it (no @ version).
  assert.equal(parseNpmName("git-repo"), "git-repo");
});

test("normalizeForMatch applies the canonical normalization to both sides", () => {
  // npm: specs: strip prefix, drop version, keep scope.
  assert.equal(normalizeForMatch("npm:pkg"), "pkg");
  assert.equal(normalizeForMatch("npm:pkg@2.0"), "pkg");
  assert.equal(normalizeForMatch("npm:@scope/pkg"), "@scope/pkg");
  assert.equal(normalizeForMatch("npm:@scope/pkg@2.0"), "@scope/pkg");
  // Bare scope form (what a user writes in disallowedExt).
  assert.equal(normalizeForMatch("@scope/pkg"), "@scope/pkg");
  assert.equal(normalizeForMatch("@scope/pkg@2.0"), "@scope/pkg");
  // git:/file forms are lowercased only, no npm parsing.
  assert.equal(normalizeForMatch("git:https://example.com/repo.git"), "git:https://example.com/repo.git");
  assert.equal(normalizeForMatch("PI-LOCAL"), "pi-local");
});

test("filterSurvivors returns null when disallow list is empty (criterion b)", () => {
  const declared: DeclaredExt[] = [{ entry: "npm:pkg", key: "pkg" }];
  assert.equal(filterSurvivors(declared, []), null);
});

test("filterSurvivors returns null when nothing matches (criterion b — stale/typo)", () => {
  const declared: DeclaredExt[] = [
    { entry: "npm:@gotgenes/pi-permission-system", key: "@gotgenes/pi-permission-system" },
    { entry: "/abs/extensions/subagent-widget/index.ts", key: "subagent-widget" },
  ];
  assert.equal(filterSurvivors(declared, ["does-not-exist"]), null);
  // Bare unscoped name must not match a scoped declared key (strict).
  assert.equal(filterSurvivors(declared, ["pi-permission-system"]), null);
});

test("filterSurvivors blocks a scoped disallow entry and keeps the rest", () => {
  const declared: DeclaredExt[] = [
    { entry: "npm:@gotgenes/pi-permission-system", key: "@gotgenes/pi-permission-system" },
    { entry: "npm:pi-rtk-optimizer", key: "pi-rtk-optimizer" },
    { entry: "/abs/extensions/subagent-widget/index.ts", key: "subagent-widget" },
  ];
  const survivors = filterSurvivors(declared, ["@gotgenes/pi-permission-system"]);
  assert.deepEqual(survivors, [
    "npm:pi-rtk-optimizer",
    "/abs/extensions/subagent-widget/index.ts",
  ]);
});

test("filterSurvivors is version-insensitive on the disallow side", () => {
  // The disallow entry carries a version; normalizeForMatch drops it before matching.
  const declared: DeclaredExt[] = [
    { entry: "npm:@gotgenes/pi-permission-system", key: "@gotgenes/pi-permission-system" },
  ];
  // Declared key is the normalized form; disallow entry normalizes to the same.
  assert.equal(normalizeForMatch("npm:@gotgenes/pi-permission-system@2.0"), "@gotgenes/pi-permission-system");
  const survivors = filterSurvivors(declared, ["@gotgenes/pi-permission-system@2.0"]);
  assert.deepEqual(survivors, []);
});

test("filterSurvivors accepts the npm: prefix on the disallow entry", () => {
  const declared: DeclaredExt[] = [
    { entry: "npm:@gotgenes/pi-permission-system", key: "@gotgenes/pi-permission-system" },
    { entry: "npm:pi-rtk-optimizer", key: "pi-rtk-optimizer" },
  ];
  assert.equal(normalizeForMatch("npm:@gotgenes/pi-permission-system"), "@gotgenes/pi-permission-system");
  const survivors = filterSurvivors(declared, ["npm:@gotgenes/pi-permission-system"]);
  assert.deepEqual(survivors, ["npm:pi-rtk-optimizer"]);
});

test("filterSurvivors blocks multiple matches and preserves order", () => {
  const declared: DeclaredExt[] = [
    { entry: "npm:pkg-a", key: "pkg-a" },
    { entry: "npm:pkg-b", key: "pkg-b" },
    { entry: "npm:pkg-c", key: "pkg-c" },
  ];
  const survivors = filterSurvivors(declared, ["pkg-a", "pkg-c"]);
  assert.deepEqual(survivors, ["npm:pkg-b"]);
});

test("filterSurvivors blocks a local extension by dir-basename key", () => {
  const declared: DeclaredExt[] = [
    { entry: "/home/u/.pi/agent/extensions/subagent-widget/index.ts", key: "subagent-widget" },
    { entry: "/home/u/.pi/agent/extensions/pi-subagents/src/extension/index.ts", key: "pi-subagents" },
  ];
  const survivors = filterSurvivors(declared, ["pi-subagents"]);
  assert.deepEqual(survivors, ["/home/u/.pi/agent/extensions/subagent-widget/index.ts"]);
});

test("normalizeForMatch does not collapse bare SSH URLs to \"git\"", () => {
  // Without the SSH guard, parseNpmName would split at the first @ and return "git".
  assert.equal(normalizeForMatch("git@github.com:user/repo"), "git@github.com:user/repo");
  // A package literally named "git" must NOT be matched by a bare SSH disallow entry.
  const declared: DeclaredExt[] = [{ entry: "npm:git", key: "git" }];
  assert.equal(filterSurvivors(declared, ["git@github.com:user/repo"]), null);
});

test("loadDeclaredExtensions reads packages from BOTH global and project settings", async () => {
  // Regression guard for the silent-drop bug: pi's package-manager reads
  // <cwd>/.pi/settings.json packages; the enumeration must too.
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "disallow-test-"));
  const agentDir = path.join(tmp, "agent");
  const projectDir = path.join(tmp, "project");
  const extDir = path.join(agentDir, "extensions", "my-local-ext");
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, "index.ts"), "export default function(){}");
  fs.mkdirSync(path.join(agentDir), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: ["npm:global-pkg"],
  }));
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({
    packages: ["npm:project-pkg"],
  }));

  const { loadDeclaredExtensions } = await import("../disallow.ts");
  const declared = loadDeclaredExtensions(projectDir, { agentDir });
  const keys = declared.map((d) => d.key).sort();
  assert.ok(keys.includes("global-pkg"), "global settings package enumerated");
  assert.ok(keys.includes("project-pkg"), "PROJECT settings package enumerated (D1 fix)");
  assert.ok(keys.includes("my-local-ext"), "local auto-discovered extension enumerated");

  // All three must survive when disallowing only the project package.
  const survivors = filterSurvivors(declared, ["project-pkg"]);
  assert.ok(survivors !== null);
  assert.ok(!survivors.some((e) => e === "npm:project-pkg"), "project-pkg blocked");
  assert.ok(survivors.some((e) => e === "npm:global-pkg"), "global-pkg preserved (not dropped)");

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("filterSurvivors does not mutate the declared input", () => {
  const declared: DeclaredExt[] = [
    { entry: "npm:pkg-a", key: "pkg-a" },
    { entry: "npm:pkg-b", key: "pkg-b" },
  ];
  const snapshot = declared.map((d) => ({ ...d }));
  filterSurvivors(declared, ["pkg-a"]);
  assert.deepEqual(declared, snapshot);
});
