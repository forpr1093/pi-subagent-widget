# HANDOFF — `subagent-widget`

**For:** a fresh agent picking this up in a new session.
**Extension:** `/Users/anv/.pi/agent/extensions/subagent-widget/`
**Date:** 2026-06-27

Read this first. It orients you on (1) what this is, (2) the latest state + what's next, (3) where every doc lives. For the full audit trail + setup guide, dive into [`docs/SESSION-HISTORY.md`](./docs/SESSION-HISTORY.md).

---

## 1. What this is

A pi extension that adds **background subagents** + a **named-agent orchestration layer**: reusable agent definitions (`~/.pi/agent/agents/*.md`), multi-agent **chains** with auto-advance (`{previous}`/`{input}` substitution), a `subagent_catalog` discovery tool, optional **git-worktree isolation**, and — just added — a `subagent_build` tool to scaffold agents.

Auto-discovered by pi (it loads `.ts` directly, no build step). Config lives in sibling `config.json`. Per-repo trust gates separate user-installed (trusted) from repo-controlled (untrusted) agents/chains.

---

## 2. Latest state — where we left off

### Just built (this session, end of work)
- **`subagent_build` tool** — write/overwrite a named agent file from the model. Validated name (`^[a-z0-9][a-z0-9-]*$`), required `description`+`systemPrompt`, optional overlay (`tools`/`disallowedTools`/`model`/`extensions`/`skills`/`worktree`), `force` opt-in overwrite, self-verifies via `discoverAgents`. **Verified: load-clean + unit 25/25 round-trip through the real `discoverAgents`.** **NOT yet live-verified by the user** — they opted out of the reload-and-test step before opening this new session. ← This is the single open thread.

### Earlier this session (the "U" round — user-exploration findings)
Four issues surfaced during live use, all fixed + live-verified (full detail in `docs/SESSION-HISTORY.md` §3):
- **U1** `subagent_inspect` *tool* now returns a plain-text transcript (was: opened a TUI panel, unreadable by the model). `/subinspect` *command* still opens the panel for the user.
- **U2** Inspector now shows a `prompt:` block (the prompt the subagent *received*) — was captured but never rendered.
- **U3** Inline `/subchain` step-2 now auto-prepends the handoff when the task lacks the literal `{previous}` token (was: silent no-op → step 2 got zero prior context).
- **U4** Every chain step's **system prompt** now includes its role (`You are step N of M. Previous/Next: X/none`); handoff envelope relabeled `[Source: step N]` (describes the source, not the recipient — eliminates a contradiction step 2 found).

### Before that
Two reviewer-driven hardening rounds (B/M then R1–R6 + minors) — security/data-loss + correctness. All live- or unit-verified. Full audit in `docs/SESSION-HISTORY.md` §2–3.

### Current health
- **Load-clean:** `pi` loads the extension with 9 commands + 8 tools (incl. the new `subagent_build`) without errors.
- **No test artifacts:** debug session files cleaned, no orphan temp dirs, `config.json` `worktree: "off"`.
- **Known blockers:** none.

---

## 3. What's next (open threads, in priority order)

1. **Live-verify `subagent_build`** (the one pending verification). User reloads TUI → asks "build me a test agent called `probe`" → expects `✓ Agent "probe" written to ~/.pi/agent/agents/probe.md. Discoverable via subagent_catalog`. Then `/subchain probe "say hi"` to confirm spawn. Clean up after.

2. **Real multi-agent run (not yet exercised):** the verification so far used toy chains (`echo-chain`, inline greetings). A substantive `recon-and-synth` run (`scout` reads files → `synthesizer` condenses) hasn't been done — that's the actual use case and would surface any real-content edge cases in the handoff/auto-advance machinery.

3. **Documented limitations still deferred** (not bugs, deliberate deferrals — see `docs/SESSION-HISTORY.md` §3 "Acceptable / documented limitations"):
   - **6.5** worktree/branch accumulation across pi crashes (no auto-GC — risky; use `/subchain-doctor` + `git worktree prune`).
   - **7.1** `proc.on("error")` vs `close` divergence (low-risk; would need a shared `finishStep` refactor).

4. **Spec↔code drift lesson:** the deleted `PLAN-disallow-list.md` had unchecked boxes ("not yet implemented") despite the feature being fully shipped. If you add features, tick plans closed or delete them — stale "todo" headers mislead.

---

## 4. Doc map (new layout)

```
extensions/subagent-widget/
  README.md                      ← feature reference (commands, tools, schemas, §12 worktree)
  HANDOFF.md                     ← THIS file (read first: state + next + pointers)
  config.json                    ← runtime config (liteAllowedExt, disallowedExt, worktree)
  docs/
    SESSION-HISTORY.md           ← full audit trail (B/M + R + U rounds) + setup/usage guide
    SPEC-orchestration.md        ← locked design spec (§1–12, incl. §11 research ADOPTED/REJECT table)
    SPEC-inspector.md            ← inspector design (dataset model, scroll model)
  *.ts                           ← source (index.ts is the center; agents/chains/disallow/config/
                                    inspector/session/types/widget/worktree.ts are pure modules)
  test/disallow.test.ts          ← disallow-list unit tests
```

**Reading order for a new agent:**
1. This `HANDOFF.md` (where we are).
2. `README.md` (what the features do + how to invoke).
3. `docs/SESSION-HISTORY.md` §4 (full setup & usage guide) if you need config details, frontmatter schemas, or troubleshooting.
4. `docs/SPEC-orchestration.md` / `docs/SPEC-inspector.md` only if you're modifying the design.

---

## 5. Quick verify (sanity check before any work)

```
/subchain-doctor        # should show: 2 agents (scout, synthesizer), 2 chains (echo-chain, recon-and-synth),
                        #              neuralwatt ✓ present in both lite + full spawn
```
If that's green, the extension is loaded + discovering correctly. Then `subagent_catalog` (scope: both) to list available agents/chains. If you're picking up thread #1, reload the TUI first so `subagent_build` is registered.
