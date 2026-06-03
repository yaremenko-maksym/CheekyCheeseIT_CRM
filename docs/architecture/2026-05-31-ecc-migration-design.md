# ECC Migration Design — Master ADR

**Date:** 2026-05-31 (drafted in session 2026-06-03)
**Architect:** Migration Architect (Phase 0 deliverable)
**Status:** Proposed — awaits User approval before Phase 1 entry
**Supersedes:** none (foundational ADR)
**Companion docs:**

- Discovery Report: `docs/architecture/2026-05-31-architect-discovery-report.md`
- Legal agent design (recent): `docs/architecture/2026-05-31-legal-agent-design.md`
- Dev-flow RCA (D1-D4 fixes): `docs/architecture/2026-05-23-dev-flow-rca.md`
- Architect role spec: `docs/agents/architect.md`

**ECC reference repo:** <https://github.com/affaan-m/ECC>
**ECC version pin (proposed):** `v2.0.0-rc.1` → tag SHA `928076cc08cbb31e8549cea2883b4f51811de1c8`
**ECC main HEAD (informational):** `99baa8250096f2d295583572399a5c9aba2ce312` (2026-06-02, post-rc work)

---

## Executive Summary (TL;DR)

1. **Adopt ECC v2.0.0-rc.1 via `developer` install profile**, augmented with `security` profile selectively for Phase 8 finance/USDT work. Pin to tag SHA, freeze for migration duration, quarterly upstream sync afterwards.
2. **Migration is 6 phases** (Phase 0 = this ADR is the deliverable; Phases 1-6 = ~6-9 weeks of incremental work).
3. **Preserve product workflow throughout.** No Coder zone touched (`apps/**`, `packages/**` off-limits). PM keeps dispatching daily until Phase 3 completes the agent cutover.
4. **Of ~17 mapped artifacts:** 8 Adopt-as-is ECC, 6 Adapt (ECC pattern + local override), 6 Keep custom (no equivalent), 2 Remove (redundant after migration). Numbers refined in Section 2.
5. **Top risks:** active workflow disruption (mitigated by coexistence), knowledge loss in lessons→skills conversion (mitigated by group-by-topic + user review), version pin drift (mitigated by SHA pin + quarterly sync).
6. **Overall confidence:** MED-HIGH. Most decisions HIGH (well-documented ECC patterns); ~3 decisions MED awaiting Phase 1 install POC results; 0 LOW.
7. **Open questions for User:** 7 items in Section 9 — preferred timeline, cross-harness scope, approval gate cadence, security profile additions, BA-as-human placement, monorepo install layout, Russian-language enforcement strategy.

---

## Section 1 — Inventory Table (EVALUATION.md style)

This table mirrors the `EVALUATION.md` structure in the ECC repo, comparing **current Cheeky Cheese IT CRM agent system** against **ECC v2.0.0-rc.1**. Numbers from ECC come from `AGENTS.md` + `WORKING-CONTEXT.md` catalogs (catalogs vary slightly by aggregation methodology — ranges shown).

### 1.1 Core artifact counts

| Component           | Current state                                                                                                                                                                             | ECC v2.0.0-rc.1                                                                                                   | Delta interpretation                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agents**          | 6 LLM agents (PM/Coder/AutoTest/Reviewer/DevOps/Legal) + 1 human role (BA)                                                                                                                | 47-63 specialized agents (varies by profile)                                                                      | We have monolithic broad-scope agents; ECC favors narrow agents with tight tool allowlists. Phase 3 decomposes our 6 into ECC equivalents + ports custom orchestration layer.                                                        |
| **Skills**          | 0 ECC-format skills. Knowledge stored in 6 `lessons.md` files (≤30 lines each, append-log + rotation to archive) + free-text `docs/agents/memory/*`                                       | 181-249 SKILL.md packages (varies by profile)                                                                     | Knowledge in our system is free-text accumulated; ECC formalizes as structured SKILL.md with `When to Activate` + `Workflow` + `Tested examples`. Phase 4 converts lessons→skills (grouped by topic, not 1:1).                       |
| **Commands**        | 0 slash-commands. PM dispatches via `Agent(...)` tool from natural language requests.                                                                                                     | 60-79 slash-entry commands                                                                                        | Commands are legacy compatibility layer in ECC per WORKING-CONTEXT.md ("commands/ — legacy slash-entry compatibility during migration"). Low priority for us — we adopt commands only if needed for cross-harness parity (Phase 5+). |
| **Hooks**           | 5 bash scripts in `.claude/hooks/` registered via `.claude/settings.json` with `matcher: "Bash"` (broad)                                                                                  | JSON matcher-based registration with specific predicates + Node.js plugin bootstrap + stable IDs                  | Our hooks fire on every Bash invocation and parse internally; ECC hooks use predicate matchers (`tool == "Bash" && command matches "git push"`) for efficiency and clarity. Phase 2 rewrites in ECC JSON format.                     |
| **Rules**           | 0 dedicated rules files. Constraints embedded inline in agent prompts (e.g., "не редактировать apps/\*\*" in coder.md, "Confidence policy" in legal.md, "Russian language" in CLAUDE.md). | 60+ rules across `rules/common/` + 12 language-specific subdirectories                                            | We have implicit rules; ECC extracts as portable, reusable `rules/<topic>.md` units. Phase 5 surfaces top 5-8 cross-cutting rules into ECC rules/ directory.                                                                         |
| **MCP configs**     | 8 servers configured in user settings (ast-grep, context7, postgres, eslint, playwright, github, scheduled-tasks, ccd-session)                                                            | 14+ canonical configs in `mcp-configs/` (anthropic-skills, ast-grep, context7, github, playwright, postgres, ...) | Mostly overlapping set. Phase 1 cross-references our 8 against ECC's 14+, adopts canonical configs where shape matches, keeps custom for project-specific servers (e.g., scheduled-tasks usage pattern).                             |
| **Install profile** | Custom monolithic (no profile abstraction)                                                                                                                                                | 5 profiles: `core`, `developer`, `security`, `research`, `full`                                                   | We adopt `developer` (REPO-ASSESSMENT.md recommendation for SaaS+TS+React+NestJS stack) + selective `security` additions for finance/USDT work.                                                                                      |

### 1.2 Workflow artifacts

| Component                       | Current state                                                                                                                                                                                                                              | ECC v2.0.0-rc.1                                                                                                           | Delta interpretation                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GHA workflows**               | 6 active: `ci.yml`, `e2e.yml`, `e2e-watchdog.yml`, `auto-merge-on-label.yml`, `labels-sync.yml`, `check-no-skip-hooks.yml` (+ archived: ai-review.yml, coder.yml, autotest.yml, devops.yml — moved to `archive/`)                          | ECC ships CI examples but does not own our GHA topology. ECC focuses on local Claude Code harness configuration.          | GHA stays Cheeky-Cheese-owned. Phase 5 integrates ECC agent invocations _inside_ existing GHA jobs (e.g., ai-review.yml calls ECC `code-reviewer`), not replaces the workflow files.                                                          |
| **Labels (declarative)**        | `.github/labels.yml` — 17 labels (bug, documentation, awaiting-pm-review, merge-approved, etc.)                                                                                                                                            | ECC has no label syncing tooling                                                                                          | Keep custom. No migration needed.                                                                                                                                                                                                             |
| **Memory/lessons**              | 6 `lessons.md` files at `docs/agents/memory/<role>/lessons.md`. Currently sparse: pm=18 lines, coder=22, reviewer=16, autotest=14, devops=12, legal=46 (skeleton; planned 24 UA-tax lessons not yet accumulated — were in design doc only) | `skills/<topic>/SKILL.md` structured packages with frontmatter                                                            | Phase 4 lifts each `lessons.md` topic-cluster into one or more skills. **Critical correction from Discovery:** legal/lessons.md is currently a 46-line skeleton (header + format example), not 24 accumulated lessons. Reduces Phase 4 scope. |
| **State management**            | `pm-state.json` schema v2 (events array, foreground/background dispatch, review_rounds circuit breaker, pending_fixes batch)                                                                                                               | ECC has no state-store primitive. State is implicit (per-session, file-tree).                                             | Keep custom — unique product workflow management. Phase 5 may surface as ECC skill `skills/pm-state-orchestration/` documenting the schema for future contributors.                                                                           |
| **Recovery scripts**            | `scripts/pm/pm-schedule.sh` (Layer 2 ScheduleWakeup), `scripts/pm/prep-user-testing.sh` (Serveo tunnel + dev-login injection), `scripts/coder/coder-intent.sh` (Layer 8.1.1 intent marker), `scripts/pm/wakeup-prompts/` directory         | ECC has `agents/loop-operator.md` covering autonomous-loop concept but no concrete cross-session ScheduleWakeup primitive | Keep custom. ECC inspires patterns (loop-operator) but the implementation is ours. Phase 5 documents in `skills/cross-session-orchestration/`.                                                                                                |
| **3-layer watchdog resilience** | C1/C3 + D1-D4 RCA fixes from `docs/architecture/2026-05-23-dev-flow-rca.md` — coder intent marker, pre-push hook gating, Reviewer write-then-post, AutoTest D3 dispatch decision                                                           | No ECC equivalent — our project-specific resilience layer                                                                 | Keep custom entirely. Surface as `skills/dev-flow-resilience/` skill for documentation/discoverability.                                                                                                                                       |

### 1.3 Cross-cutting characteristics

| Characteristic                          | Current                                                         | ECC v2.0.0-rc.1                                                                                                                                                            | Migration approach                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Primary harness**                     | Claude Code only                                                | Claude Code primary; ports to Codex, Cursor, OpenCode, Gemini, Zed, GitHub Copilot via `.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.zed/` directories + `manifests/` | Phase 5 creates placeholder cross-harness directories only. Active porting deferred to optional Phase 7+.                                                                            |
| **Primary language (UI/agent prompts)** | Russian (hard requirement per CLAUDE.md)                        | English                                                                                                                                                                    | Adapt: keep ECC structure, prepend "Всегда отвечай на русском" override in each ported agent.                                                                                        |
| **Code comments**                       | English (international team future-proof)                       | English                                                                                                                                                                    | No change.                                                                                                                                                                           |
| **Commit messages**                     | English (conventional commits: `feat(drop):`, `fix:`, `chore:`) | English (RULES.md conventional commits + format spec)                                                                                                                      | Adopt ECC's commit format spec verbatim where stricter than ours.                                                                                                                    |
| **Test framework**                      | Vitest (unit) + Playwright (e2e)                                | Vitest + Playwright + others                                                                                                                                               | Match. No change.                                                                                                                                                                    |
| **TDD enforcement**                     | `superpowers:test-driven-development` skill invoked by Coder    | ECC `agents/tdd-guide.md` agent (RED→GREEN→IMPROVE workflow) + minimum 80% coverage rule                                                                                   | Phase 3 adopts ECC `tdd-guide` as parallel agent invoked by Coder workflow. Existing superpowers skill kept (they coexist — superpowers is harness-level, tdd-guide is ECC catalog). |
| **Tool allowlist enforcement**          | Implicit via prompt + 1 hook (block-production-edits.sh)        | YAML frontmatter `tools: [Read, Edit, Bash, Grep]` per agent + hook enforcement                                                                                            | Phase 3 makes tool allowlists explicit in YAML frontmatter for every ported agent.                                                                                                   |
| **Confidence policy**                   | Defined in legal.md, applied informally elsewhere               | `code-reviewer.md` "Pre-Report Gate", `security-reviewer.md` similar                                                                                                       | Phase 3 generalizes confidence policy to all ported agents via shared rule.                                                                                                          |

### 1.4 Summary counts

| Bucket                                          | Count | Description                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Adopt-as-is** (ECC pattern, no customization) | 8     | Agent YAML frontmatter format, Skill SKILL.md format, Hook JSON matcher syntax, 5 Core Principles (SOUL.md), Confidence-based pre-report gate, Conventional commits format (where stricter than ours), `developer` install profile, `tdd-guide` agent                                                                                                          |
| **Adapt** (ECC pattern + local override)        | 6     | Hooks rewritten to ECC format but logic preserved (5 hooks), `code-reviewer` + `security-reviewer` replace monolithic reviewer.md, Russian language overlay on all ported agents, NestJS/React/TypeScript skill packs (filter to relevant subset), ECC `planner` integrated into PM workflow, GHA jobs invoke ECC agents internally (workflow files stay ours) |
| **Keep custom** (no ECC equivalent justified)   | 6     | PM orchestrator (Mode 1-5 + pm-state.json), Legal agent (UA jurisdictional specificity), BA human role, 3-layer watchdog resilience (D1-D4 fixes), pm-state.json schema v2, prep-user-testing.sh + Serveo tunnel + dev-login injection                                                                                                                         |
| **Remove** (redundant after ECC adoption)       | 2     | Standalone `coder-progress-marker.sh` (subsumed by ECC `continuous-learning` observer hook), informal confidence-policy duplication across agent prompts (replaced by shared rule)                                                                                                                                                                             |

Note: counts in Section 2 may resolve some borderline cases (some agents counted as 1 unit even when decomposed into 2 ECC agents).

---

## Section 2 — Per-Component Mapping

This is the operational core of the ADR. Each current artifact mapped to an action: **Adopt** (use ECC as-is), **Adapt** (ECC base + local override), **Keep custom** (no ECC equivalent worth adopting), or **Remove** (redundant after migration).

### 2.1 Agents

#### 2.1.1 PM agent (`docs/agents/pm.md`)

- **Current location:** `docs/agents/pm.md` (~30 KB), `docs/agents/CLAUDE-pm.md` (~17 KB operational notes), `docs/agents/pm-snippets.md` (~20 KB dispatch templates)
- **Current purpose:** Daily product-development orchestrator. Mode 1-5 decision tree (manual reply / auto-decompose / parallel dispatch / User Testing tunnel / Legal escalation). Manages `pm-state.json` schema v2 (events, foreground/background queues, review_rounds circuit breaker, pending_fixes batch). Integrates Legal agent 4 modes (A=consult / B=PR-review / C=brief-check / D=strategic).
- **ECC equivalent:** No direct equivalent. ECC `agents/planner.md` covers planning sub-skill. ECC `agents/loop-operator.md` covers autonomous loops with stop conditions. ECC `agents/harness-optimizer.md` covers harness configuration. None map to "daily product workflow orchestrator with state management and User Testing tunnel."
- **Decision:** **Keep custom + Adapt**
- **Justification:** PM business logic (Serveo tunnel, dev-login injection, Legal mode dispatch, review_rounds circuit breaker, pending_fixes batch) is product-specific. No ECC catalog item maps. However, we **adopt ECC agent YAML frontmatter format** (cite RULES.md "Agent Format") and **delegate sub-tasks to ECC agents** internally: PM invokes `planner` for plan drafting, `architect` for design choices, `loop-operator` patterns for cross-session waits.
- **Migration phase:** Phase 3
- **Effort estimate:** **L** (8-16 hours) — large rewrite to ECC agent format while preserving all Mode 1-5 logic, pm-state.json contract, snippet templates, Legal integration. Highest-risk single agent migration.

#### 2.1.2 BA (human role)

- **Current location:** `docs/agents/ba.md` (~12 KB), `docs/agents/CLAUDE-ba.md` (~5 KB)
- **Current purpose:** Business consultant who writes `docs/specs/pm-brief.md` for PM consumption. Human role, not LLM agent.
- **ECC equivalent:** None (ECC catalogs LLM agents only).
- **Decision:** **Keep custom (human role, no migration)**
- **Justification:** Out of LLM scope. Documentation in `docs/agents/ba.md` may stay co-located with LLM agent docs for project clarity, or move to `docs/business/roles/ba.md`. No technical migration needed.
- **Migration phase:** Phase 6 (cleanup — decide on docs location)
- **Effort estimate:** **S** (1-2 hours)

#### 2.1.3 Coder agent (`docs/agents/coder.md`)

- **Current location:** `docs/agents/coder.md` (~34 KB — chunking rules, watchdog resilience, AC verification, intent marker workflow)
- **Current purpose:** Fullstack developer agent. Dispatches via GHA `coder.yml` (archived) or local Agent(...). Implements features, writes tests, uses superpowers TDD skill, follows D1-D4 resilience fixes (intent marker, pre-push hook, chunking, AC verification).
- **ECC equivalent:**
  - `agents/tdd-guide.md` — RED→GREEN→IMPROVE workflow, 80% coverage minimum
  - `agents/typescript-reviewer.md` — TypeScript-specific code review
  - Plus `skills/nestjs-patterns/`, `skills/react-patterns/`, `skills/react-testing/`
- **Decision:** **Adapt** (decompose into multiple ECC agents + custom shell)
- **Justification:** Coder is broad; ECC favors narrow agents. Phase 3 splits as: (1) **Coder shell** stays as project-specific orchestrator agent that knows our chunking rules, intent marker, AC verification policy, and dispatches to ECC sub-agents. (2) ECC `tdd-guide` handles TDD enforcement. (3) ECC `typescript-reviewer` handles per-file linting/typing critique. (4) Stack-specific skills (`nestjs-patterns`, `react-patterns`, `react-testing`) provide knowledge primitives. Cite ECC `AGENTS.md` "Agent-First orchestration with radical specialization."
- **Migration phase:** Phase 3
- **Effort estimate:** **L** (8-12 hours)

#### 2.1.4 AutoTest agent (`docs/agents/autotest.md`)

- **Current location:** `docs/agents/autotest.md` (~15 KB)
- **Current purpose:** E2E test developer agent. 3 modes (new spec / fix flaky / coverage audit) + dispatch decision D3 (per AutoTest after Reviewer suggests test fix).
- **ECC equivalent:** ECC has no dedicated `e2e-runner` agent in v2.0.0-rc.1 catalog at the level of specialization we need. ECC `tdd-guide` covers TDD but not E2E specifics. `skills/playwright-patterns/` likely exists (TBD Phase 1 verification).
- **Decision:** **Adapt** (Keep custom AutoTest shell + use ECC skills for Playwright patterns)
- **Justification:** Our AutoTest has dispatch-decision D3 logic (decide who handles spec change: AutoTest vs Coder) which is unique. Keep agent as ECC-format custom, use ECC `skills/playwright-patterns/` if present in `developer` profile. Cite our `feedback_test_fixing` lesson (Spec changes go to auto-tester not Claude directly).
- **Migration phase:** Phase 3
- **Effort estimate:** **M** (4-6 hours)

#### 2.1.5 Reviewer agent (`docs/agents/reviewer.md`)

- **Current location:** `docs/agents/reviewer.md` (~17 KB)
- **Current purpose:** Code review on PRs. Verdict: BLOCK pattern, write-then-post (avoid editing-while-reviewing). Confidence-based filtering.
- **ECC equivalent:**
  - `agents/code-reviewer.md` — narrow code-review (Pre-Report Gate, confidence-based filtering)
  - `agents/security-reviewer.md` — security-focused review (OWASP Top 10, npm audit)
- **Decision:** **Adapt** (decompose into 2 ECC agents)
- **Justification:** ECC's split into `code-reviewer` + `security-reviewer` is well-justified — different concerns, different optimal models (sonnet for code, opus for security depth), different tool allowlists. Our reviewer.md "Verdict: BLOCK" + "write-then-post" maps directly to ECC `code-reviewer` Pre-Report Gate. For finance/auth/USDT code paths, dispatch ECC `security-reviewer` additionally. Cite `agents/code-reviewer.md` and `agents/security-reviewer.md` from ECC repo.
- **Migration phase:** Phase 3
- **Effort estimate:** **M** (4-6 hours per agent × 2 = ~8-12 hours)

#### 2.1.6 DevOps agent (`docs/agents/devops.md`)

- **Current location:** `docs/agents/devops.md` (~9 KB)
- **Current purpose:** Infrastructure/CI/CD. Maintains GHA workflows, deployment, env config.
- **ECC equivalent:**
  - `agents/build-error-resolver.md` — build issue diagnosis
  - `agents/harness-optimizer.md` — Claude Code harness config tuning
- **Decision:** **Adapt** (decompose: ECC for build/harness issues + custom shell for GHA)
- **Justification:** ECC covers build-error-resolution and harness-config tuning. Our DevOps additionally owns GHA workflow files (ci.yml, e2e.yml, etc.) — that's not in ECC scope. Phase 3 keeps custom DevOps shell for GHA, delegates to ECC sub-agents for build/harness.
- **Migration phase:** Phase 3
- **Effort estimate:** **M** (4-6 hours)

#### 2.1.7 Legal agent (`docs/agents/legal.md`)

- **Current location:** `docs/agents/legal.md` (~17 KB), `docs/agents/CLAUDE-legal.md` (~6 KB)
- **Current purpose:** UA jurisdictional legal advisor. 4 modes: A=consult / B=PR-review / C=brief-check / D=strategic. Knowledge base: `docs/legal/` (UA tax/CFC/crypto/contract regulations).
- **ECC equivalent:** None. ECC has no jurisdictional legal agent in catalog.
- **Decision:** **Keep custom**
- **Justification:** UA-specific regulatory knowledge (ФОП режимы, ПКУ articles, Закон 2074-IX virtual assets, Меморандум НБУ banking caps, CFC ст. 39² ПКУ) is irreducibly local. No ECC pattern to adopt. Phase 3 ports Legal to ECC agent YAML frontmatter format but otherwise preserves all 4 modes and knowledge base unchanged. Phase 4 converts Legal lessons (currently sparse skeleton, but will grow) into UA-specific skills.
- **Migration phase:** Phase 3 (port to YAML) + Phase 4 (lessons→skills)
- **Effort estimate:** **M** (4-6 hours port, +S for skills if lessons accumulate)

### 2.2 Hooks

#### 2.2.1 `safety.sh`

- **Current location:** `.claude/hooks/safety.sh` (952 bytes, registered on `matcher: "Bash"`)
- **Current purpose:** Block dangerous commands (rm -rf / force-push to main / etc.) before execution.
- **ECC equivalent:** ECC ships safety scanning patterns in `hooks/` directory (PreToolUse Bash matcher with dangerous-command predicates). Likely subsumed by ECC `pre:bash:dispatcher` hook (TBD Phase 1 verification).
- **Decision:** **Adapt** (rewrite in ECC JSON matcher format, may dedupe with ECC equivalent)
- **Justification:** Our safety.sh logic is project-specific (it knows our main branch rules, our worktree paths). Port logic, but use ECC JSON matcher format with specific predicates instead of "fires on every Bash invocation." Cite ECC `RULES.md` "Hook Format — matchers should be specific."
- **Migration phase:** Phase 2
- **Effort estimate:** **S** (1-2 hours)

#### 2.2.2 `block-production-edits.sh`

- **Current location:** `.claude/hooks/block-production-edits.sh` (2.4 KB, registered on `matcher: "Edit|Write|NotebookEdit"`)
- **Current purpose:** Block edits to `apps/**`, `packages/**` from non-Coder agents (Architect / PM / Legal must not touch production code).
- **ECC equivalent:** No exact equivalent — this is our zone-of-write enforcement specific to multi-agent architecture.
- **Decision:** **Keep custom** (port to ECC JSON format)
- **Justification:** Zone-of-write enforcement is unique to our multi-agent setup. Rewrite as ECC hook with matcher `tool in ["Edit","Write","MultiEdit","NotebookEdit"] && tool_input.file_path matches "apps/**|packages/**" && agent != "coder"`. Cite our `docs/agents/architect.md` Zone-of-write section.
- **Migration phase:** Phase 2
- **Effort estimate:** **S** (1-2 hours)

#### 2.2.3 `coder-pre-push.sh`

- **Current location:** `.claude/hooks/coder-pre-push.sh` (2.9 KB, registered on `matcher: "Bash"`)
- **Current purpose:** Before `git push`, verify Coder has set ac_verified marker (Layer C3 enforcement from D1-D4 fixes). Prevents pushing un-AC-verified work.
- **ECC equivalent:** No equivalent. This is our project-specific resilience layer.
- **Decision:** **Keep custom** (port to ECC JSON format with specific matcher)
- **Justification:** AC verification is product-specific contract. Port with **specific predicate** `tool == "Bash" && tool_input.command matches "git push"` (currently fires on all Bash, inefficient). Cite `docs/architecture/2026-05-23-dev-flow-rca.md` D3 fix.
- **Migration phase:** Phase 2
- **Effort estimate:** **S** (1-2 hours)

#### 2.2.4 `coder-progress-marker.sh`

- **Current location:** `.claude/hooks/coder-progress-marker.sh` (2.6 KB, registered on `matcher: "Edit|Write|MultiEdit|NotebookEdit"` PostToolUse)
- **Current purpose:** After every file edit, write progress marker to pm-state.json events. Layer for cross-session recovery — PM knows what Coder did.
- **ECC equivalent:** ECC ships `continuous-learning` observer hook concept (PreToolUse \* matcher, captures tool-use patterns for skill discovery). Different purpose but overlapping mechanism.
- **Decision:** **Remove** (after Phase 5 validates ECC observer covers our needs) OR **Adapt** (keep with ECC JSON format)
- **Justification:** Need Phase 1 investigation of exact ECC `continuous-learning` behavior. If it captures sufficient signal for PM event recovery, we remove ours (one less custom hook). If not, port to ECC JSON. **Decision deferred to Phase 2 spike.**
- **Migration phase:** Phase 2 (with Phase 1 spike for ECC observer behavior)
- **Effort estimate:** **S** (1-2 hours either way)

#### 2.2.5 `eslint-feedback.sh`

- **Current location:** `.claude/hooks/eslint-feedback.sh` (1.2 KB, registered on `matcher: "Edit|Write"` PostToolUse)
- **Current purpose:** After editing TS/TSX, run eslint --fix and surface remaining issues.
- **ECC equivalent:** ECC's recommended pattern is `eslint` MCP server for pre-check (faster than post-hook). Plus possible ECC hook `pre:edit-write:config-protection`.
- **Decision:** **Adapt** (move to MCP-first eslint check + lighter ECC hook for fallback)
- **Justification:** Our CLAUDE.md already recommends "eslint MCP first" for pre-check. Phase 2 reduces hook scope to just "trigger eslint MCP server" via ECC JSON matcher. Cite our CLAUDE.md MCP-first policy.
- **Migration phase:** Phase 2
- **Effort estimate:** **S** (1-2 hours)

### 2.3 GHA Workflows

#### 2.3.1 `ci.yml`

- **Current location:** `.github/workflows/ci.yml` (13 KB)
- **Current purpose:** PR CI — typecheck, lint, unit tests, build all packages.
- **ECC equivalent:** ECC CI examples exist but don't own our topology.
- **Decision:** **Keep custom**
- **Justification:** GHA workflow files stay Cheeky-Cheese-owned. ECC may inspire job-level patterns (cache strategy, matrix). Phase 5 may add ECC `code-reviewer` invocation as new job, leaving rest unchanged.
- **Migration phase:** Phase 5 (additive only)
- **Effort estimate:** **S** (1-2 hours for additive job)

#### 2.3.2 `e2e.yml`

- **Current location:** `.github/workflows/e2e.yml` (7 KB)
- **Current purpose:** E2E test run on push to main. Triggers AutoTest workflow upstream.
- **ECC equivalent:** None.
- **Decision:** **Keep custom**
- **Justification:** GHA-specific. No change.
- **Migration phase:** Phase 5 (no change expected)
- **Effort estimate:** **S** (0-1 hour, only if integrating ECC agent invocation)

#### 2.3.3 `e2e-watchdog.yml`

- **Current location:** `.github/workflows/e2e-watchdog.yml` (2.2 KB)
- **Current purpose:** Restart hung e2e jobs (D4 fix).
- **ECC equivalent:** None.
- **Decision:** **Keep custom**
- **Justification:** Project-specific resilience layer.
- **Migration phase:** Phase 5 (no change)
- **Effort estimate:** **S** (0 hours, no migration)

#### 2.3.4 `auto-merge-on-label.yml`

- **Current location:** `.github/workflows/auto-merge-on-label.yml` (2.4 KB)
- **Current purpose:** When `merge-approved` label is added by PM (after user "мерджим" in chat), auto-squash-merge PR.
- **ECC equivalent:** None.
- **Decision:** **Keep custom**
- **Justification:** Product workflow (cite `feedback_approval_from_chat` and `feedback_pr_merge_approval` memory items). No change.
- **Migration phase:** Phase 5 (no change)
- **Effort estimate:** **S** (0 hours)

#### 2.3.5 `labels-sync.yml`

- **Current location:** `.github/workflows/labels-sync.yml` (2.2 KB)
- **Current purpose:** Sync `.github/labels.yml` to GitHub on push.
- **ECC equivalent:** None.
- **Decision:** **Keep custom**
- **Justification:** No change.
- **Migration phase:** Phase 5 (no change)
- **Effort estimate:** **S** (0 hours)

#### 2.3.6 `check-no-skip-hooks.yml`

- **Current location:** `.github/workflows/check-no-skip-hooks.yml` (4.8 KB)
- **Current purpose:** CI guard ensuring no commits used `--no-verify` to skip hooks (security/discipline guard).
- **ECC equivalent:** ECC has equivalent discipline philosophy (RULES.md "Never skip hooks") but no specific GHA workflow.
- **Decision:** **Keep custom**
- **Justification:** GHA-specific. Aligns with ECC philosophy, no migration needed.
- **Migration phase:** Phase 5 (no change)
- **Effort estimate:** **S** (0 hours)

#### 2.3.7 Archived workflows (`ai-review.yml`, `coder.yml`, `autotest.yml`, `devops.yml`)

- **Current location:** `.github/workflows/archive/`
- **Current purpose:** Historical GHA-based agent dispatch (superseded by local Agent(...) dispatch).
- **ECC equivalent:** N/A (archived).
- **Decision:** **Remove** (delete or move to long-term archive)
- **Justification:** Already archived. Phase 6 cleanup moves to `docs/architecture/2026-XX-XX-migration-archive/` for historical record, then deletes from active tree.
- **Migration phase:** Phase 6
- **Effort estimate:** **S** (1 hour)

### 2.4 Memory / lessons.md (6 files)

#### 2.4.1 PM lessons (`docs/agents/memory/pm/lessons.md`)

- **Current location:** `docs/agents/memory/pm/lessons.md` (18 lines)
- **Current purpose:** Accumulated PM operational lessons (dispatch decisions, state-management gotchas).
- **ECC equivalent:** Convert topic-clusters to `skills/pm-orchestration-patterns/SKILL.md` or split into 2-3 skills by topic.
- **Decision:** **Adapt** (lessons.md stays as append-log; skills/ becomes primary surface)
- **Justification:** Phase 4 groups by topic (e.g., "review_rounds circuit breaker", "User Testing tunnel", "Legal mode dispatch"), creates 1-3 skills. Original lessons.md continues as append-log per Discovery mitigation. Cite ECC `RULES.md` Skill Format.
- **Migration phase:** Phase 4
- **Effort estimate:** **S** (1-2 hours given current sparse content)

#### 2.4.2 Coder lessons (`docs/agents/memory/coder/lessons.md`)

- **Current location:** `docs/agents/memory/coder/lessons.md` (22 lines)
- **Current purpose:** Coder operational lessons (chunking, AC verification, watchdog patterns).
- **ECC equivalent:** Map to ECC `skills/<stack-pattern>/SKILL.md` where stack-relevant, or `skills/coder-resilience-patterns/SKILL.md` for project-specific.
- **Decision:** **Adapt**
- **Justification:** Same pattern as PM. Phase 4 conversion. ECC has shipped `skills/nestjs-patterns/`, `skills/react-patterns/` — adopt those for stack knowledge, lift our project-specific patterns to custom skills.
- **Migration phase:** Phase 4
- **Effort estimate:** **S** (1-2 hours)

#### 2.4.3 Reviewer lessons (`docs/agents/memory/reviewer/lessons.md`)

- **Current location:** `docs/agents/memory/reviewer/lessons.md` (16 lines)
- **Current purpose:** Reviewer operational lessons (write-then-post, BLOCK verdict, comment placement).
- **ECC equivalent:** ECC `code-reviewer.md` already has Pre-Report Gate documented. Our lessons reinforce.
- **Decision:** **Adapt** (lift unique patterns into `skills/code-review-discipline/SKILL.md`, drop duplicates of ECC code-reviewer.md)
- **Justification:** ECC's Pre-Report Gate covers ~50% of our reviewer lessons. Phase 4 lifts only delta into custom skill, marks rest as "subsumed by ECC code-reviewer.md."
- **Migration phase:** Phase 4
- **Effort estimate:** **S** (1 hour)

#### 2.4.4 AutoTest lessons (`docs/agents/memory/autotest/lessons.md`)

- **Current location:** `docs/agents/memory/autotest/lessons.md` (14 lines)
- **Current purpose:** AutoTest operational lessons (D3 dispatch decision, flaky-fix patterns).
- **ECC equivalent:** ECC `skills/playwright-patterns/` (if shipped) for stack-side; custom for D3 dispatch.
- **Decision:** **Adapt**
- **Justification:** Same pattern.
- **Migration phase:** Phase 4
- **Effort estimate:** **S** (1 hour)

#### 2.4.5 DevOps lessons (`docs/agents/memory/devops/lessons.md`)

- **Current location:** `docs/agents/memory/devops/lessons.md` (12 lines)
- **Current purpose:** DevOps operational lessons (CI cache, Drizzle migration order).
- **ECC equivalent:** ECC `skills/` may have CI-tuning patterns; rest project-specific.
- **Decision:** **Adapt**
- **Justification:** Same pattern.
- **Migration phase:** Phase 4
- **Effort estimate:** **S** (1 hour)

#### 2.4.6 Legal lessons (`docs/agents/memory/legal/lessons.md`)

- **Current location:** `docs/agents/memory/legal/lessons.md` (46 lines — currently a skeleton header + format example, NOT 24 accumulated lessons as Discovery Report suggested)
- **Current purpose:** Will accumulate UA tax/CFC/crypto/contract lessons over time.
- **ECC equivalent:** None (UA-specific). Will create custom skills: `skills/ua-tax-compliance/`, `skills/ua-cfc-rules/`, `skills/ua-crypto-regulation/`, `skills/ua-banking-caps/`, `skills/legal-escalation-patterns/` once lessons accumulate.
- **Decision:** **Adapt** (defer skill creation until lessons accumulate)
- **Justification:** **Critical correction from Discovery Report:** legal lessons.md is currently a 46-line skeleton (header + format), not a rich corpus of 24 lessons. The 24 lessons were _planned_ in `docs/architecture/2026-05-31-legal-agent-design.md` but not yet captured. Phase 4 creates skill _stubs_ for the 5 planned UA topics with placeholder content, populates as Legal agent consultations actually happen post-migration.
- **Migration phase:** Phase 4 (stubs) + ongoing
- **Effort estimate:** **S** (1-2 hours for stubs)

### 2.5 Scripts

#### 2.5.1 `scripts/pm/pm-schedule.sh`

- **Current location:** `scripts/pm/pm-schedule.sh` (11.7 KB) + `scripts/pm/wakeup-prompts/` directory
- **Current purpose:** Layer 2 cross-session ScheduleWakeup via `mcp__scheduled-tasks`. Schedules PM to resume work after long-running external events (CI completion, user response, etc.).
- **ECC equivalent:** ECC `agents/loop-operator.md` conceptually covers autonomous loops with stop conditions. No concrete cross-session primitive.
- **Decision:** **Keep custom** + document in skill
- **Justification:** This is our project's solution to D1 (cross-session waits) per RCA doc. ECC loop-operator is in-session loops, not cross-session resume. Phase 5 documents in `skills/cross-session-orchestration/SKILL.md` for discoverability/contributor onboarding.
- **Migration phase:** Phase 5
- **Effort estimate:** **S** (1-2 hours for skill doc)

#### 2.5.2 `scripts/pm/prep-user-testing.sh`

- **Current location:** `scripts/pm/prep-user-testing.sh` (30 KB — large, multi-purpose)
- **Current purpose:** User Testing tunnel — spawns Serveo tunnel for remote-phone testing, injects dev-login button, generates user-testing URL with markdown screenshot.
- **ECC equivalent:** None.
- **Decision:** **Keep custom**
- **Justification:** Product-specific user testing flow. Phase 5 surfaces in `skills/user-testing-tunnel/SKILL.md` to make discoverable.
- **Migration phase:** Phase 5
- **Effort estimate:** **S** (1 hour for skill doc)

#### 2.5.3 `scripts/coder/coder-intent.sh`

- **Current location:** `scripts/coder/coder-intent.sh` (4.2 KB)
- **Current purpose:** Layer 8.1.1 intent marker — Coder writes "I'm about to do X" before doing it, for cross-session recovery if interrupted mid-work.
- **ECC equivalent:** ECC has `continuous-learning` observer hook (signal capture) but no intent marker concept.
- **Decision:** **Keep custom**
- **Justification:** Product-specific resilience. Surfaces in `skills/dev-flow-resilience/SKILL.md`.
- **Migration phase:** Phase 5
- **Effort estimate:** **S** (1 hour for skill doc)

### 2.6 State management

#### 2.6.1 `pm-state.json` schema v2

- **Current location:** Repo root or `.claude/` (varies by worktree; PM writes)
- **Current purpose:** State store for PM orchestration: `events[]` (chronological log), foreground/background dispatch queues, review_rounds circuit breaker, pending_fixes batch.
- **ECC equivalent:** None. ECC has no state-store primitive — state is implicit per-session.
- **Decision:** **Keep custom**
- **Justification:** PM orchestration requires persistent state across sessions and dispatches. ECC's per-session model doesn't fit our multi-day product workflows. Schema v2 stays as-is. **Architect-only addition:** add new event types (`architect_phase_started`, `architect_phase_completed`, `migration_rollback_executed`) per architect.md Coordination section — this is a schema _extension_, not redesign.
- **Migration phase:** Phase 0 (this ADR proposes event types) + Phase 6 (verify final usage)
- **Effort estimate:** **S** (1-2 hours for event-type addition in pm.md state schema doc)

### 2.7 MCP configs

#### 2.7.1 Current 8 servers

- **Current location:** User-level `~/.claude/settings.json` (not project-tracked)
- **Current purpose:** ast-grep, context7, postgres, eslint, playwright, github, scheduled-tasks, ccd-session — all 5 active per CLAUDE.md MCP-first policy.
- **ECC equivalent:** `mcp-configs/` directory in ECC repo with 14+ canonical configs (anthropic-skills, ast-grep, context7, github, playwright, postgres, etc.).
- **Decision:** **Adopt + Augment**
- **Justification:** Phase 1 cross-references our 8 against ECC's catalog. For overlapping servers (ast-grep, context7, postgres, github, playwright), adopt ECC canonical config (likely identical or near-identical — ECC patterns are battle-tested). For our project-specific (scheduled-tasks for Layer 2 wakeups, ccd-session, eslint), keep as-is. Net: align to ECC where shape matches.
- **Migration phase:** Phase 1
- **Effort estimate:** **S** (1-2 hours alignment)

### 2.8 Rules

#### 2.8.1 Implicit rules embedded in agent prompts

- **Current location:** Scattered: "Russian language" in CLAUDE.md, "no apps/packages edits" in coder.md, "Confidence policy" in legal.md, "Verdict: BLOCK" in reviewer.md.
- **Current purpose:** Cross-cutting constraints applied per-agent.
- **ECC equivalent:** ECC ships `rules/common/` + 12 language-specific subdirs (60+ rules total). Rules are portable, reusable units.
- **Decision:** **Adapt** (extract top cross-cutting rules to ECC `rules/` directory)
- **Justification:** Top candidates for extraction: (1) Russian language responses, (2) Zone-of-write per agent, (3) Confidence policy (HIGH/MED/LOW), (4) Conventional commits, (5) AC verification before push, (6) No --no-verify hook skip, (7) Hard escalation zones (legal/finance/auth). Extracted rules can be referenced from agent prompts via shorter directives. Cite ECC `rules/common/` structure.
- **Migration phase:** Phase 5
- **Effort estimate:** **M** (4-6 hours)

### 2.9 Summary mapping table

| Artifact                                  | Decision                               | Phase | Effort           |
| ----------------------------------------- | -------------------------------------- | ----- | ---------------- |
| **Agents (6 LLM + 1 human)**              |                                        |       |                  |
| PM                                        | Keep custom + Adapt                    | 3     | L                |
| BA (human)                                | Keep custom                            | 6     | S                |
| Coder                                     | Adapt (decompose)                      | 3     | L                |
| AutoTest                                  | Adapt                                  | 3     | M                |
| Reviewer                                  | Adapt (decompose into code+security)   | 3     | M-L              |
| DevOps                                    | Adapt (decompose)                      | 3     | M                |
| Legal                                     | Keep custom (port format)              | 3     | M                |
| **Hooks (5)**                             |                                        |       |                  |
| safety.sh                                 | Adapt                                  | 2     | S                |
| block-production-edits.sh                 | Keep custom (port format)              | 2     | S                |
| coder-pre-push.sh                         | Keep custom (port format)              | 2     | S                |
| coder-progress-marker.sh                  | Remove or Adapt (decide Phase 1 spike) | 2     | S                |
| eslint-feedback.sh                        | Adapt                                  | 2     | S                |
| **GHA Workflows (6 active + 4 archived)** |                                        |       |                  |
| ci.yml                                    | Keep custom (additive ECC job)         | 5     | S                |
| e2e.yml                                   | Keep custom                            | 5     | S                |
| e2e-watchdog.yml                          | Keep custom                            | 5     | S                |
| auto-merge-on-label.yml                   | Keep custom                            | 5     | S                |
| labels-sync.yml                           | Keep custom                            | 5     | S                |
| check-no-skip-hooks.yml                   | Keep custom                            | 5     | S                |
| Archived workflows                        | Remove (delete)                        | 6     | S                |
| **Memory/lessons (6)**                    |                                        |       |                  |
| PM lessons                                | Adapt                                  | 4     | S                |
| Coder lessons                             | Adapt                                  | 4     | S                |
| Reviewer lessons                          | Adapt                                  | 4     | S                |
| AutoTest lessons                          | Adapt                                  | 4     | S                |
| DevOps lessons                            | Adapt                                  | 4     | S                |
| Legal lessons (skeleton)                  | Adapt (stubs)                          | 4     | S                |
| **Scripts (3)**                           |                                        |       |                  |
| pm-schedule.sh                            | Keep custom (skill doc)                | 5     | S                |
| prep-user-testing.sh                      | Keep custom (skill doc)                | 5     | S                |
| coder-intent.sh                           | Keep custom (skill doc)                | 5     | S                |
| **State management**                      |                                        |       |                  |
| pm-state.json schema v2                   | Keep custom (extend event types)       | 0+6   | S                |
| **MCP configs**                           |                                        |       |                  |
| 8 active servers                          | Adopt + Augment (align to ECC catalog) | 1     | S                |
| **Rules**                                 |                                        |       |                  |
| Implicit cross-cutting                    | Adapt (extract to rules/)              | 5     | M                |
| **Total effort estimate**                 |                                        |       | **~58-92 hours** |

Translation: **~6-9 weeks at moderate Architect dispatch cadence** (1-2 dispatches per week, 4-8 hours per phase + user approval gates between phases).

---

## Section 3 — Install Profile Recommendation

### 3.1 Primary profile: `developer`

**Recommendation:** Use ECC `developer` profile as base.

**Justification (HIGH confidence):**
Per ECC `REPO-ASSESSMENT.md`, `developer` profile = "default engineering profile for most ECC users, general software development across app codebases." This exactly describes our CRM project: SaaS application, TypeScript-everywhere, React frontend, NestJS backend, PostgreSQL + Drizzle ORM, Vitest + Playwright testing.

**`developer` profile aggregates (from REPO-ASSESSMENT.md):**

The profile pulls from base `core` (rules-core, agents-core, commands-core, hooks-runtime, platform-configs, workflow-quality) and adds:

- Framework-language skills: NestJS, React, TypeScript reviewers (matches our stack exactly)
- Database patterns: PostgreSQL + ORM patterns (matches Drizzle usage)
- Orchestration commands: relevant to our multi-agent dispatching work
- TDD-guide agent (matches our existing `superpowers:test-driven-development` invocation pattern)
- Code-reviewer + security-reviewer agents (replaces our monolithic reviewer.md)
- Build-error-resolver agent (for DevOps decomposition)
- Harness-optimizer agent (for Claude Code config tuning we don't currently formalize)

**Concrete install command (Phase 1):**

```bash
# In the worktree for Phase 1 branch:
git clone --depth=1 --branch v2.0.0-rc.1 https://github.com/affaan-m/ECC ../ECC-source

# ECC ships install scripts per REPO-ASSESSMENT.md
node ../ECC-source/scripts/install-plan.js --profile developer --target .
# Review proposed plan (dry-run output)
node ../ECC-source/scripts/install-apply.js
```

**Fallback if install scripts incompatible with our monorepo:**

Manually copy ECC reference directories cherry-picked for `developer` profile:

- `agents/` (subset matching profile)
- `skills/` (subset)
- `hooks/` (subset)
- `rules/` (subset)
- `manifests/`
- `mcp-configs/`

Phase 1 deliverable PR will document which path was taken and why.

### 3.2 Selective additions

#### From `security` profile (Phase 8 finance/USDT preparation)

We're entering PHASE 8 (USDT ERC-20 smart contracts + AML compliance) within the next 1-3 months. ECC `security` profile is highly relevant:

| ECC item                                                 | Why we need it                                                                       | Phase to adopt                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `agents/security-reviewer.md`                            | OWASP Top 10 review for auth/finance/USDT code paths. Already in our reviewer split. | 3 (with code-reviewer split)                 |
| `rules/security/secrets-detection.md`                    | Our `.claude/hooks/safety.sh` covers some patterns; ECC's coverage is broader.       | 2 (with hook migration) or 5 (rules extract) |
| `skills/defi-amm-security/SKILL.md` (if shipped)         | Relevant for Phase 8 smart contract review.                                          | 5 (additive)                                 |
| `skills/evm-token-decimals/SKILL.md` (if shipped)        | USDT ERC-20 has 6-decimal vs 18-decimal trap. Direct relevance.                      | 5 (additive)                                 |
| `skills/wallet-address-validation/SKILL.md` (if shipped) | Profile editing flow (USDT wallet entry, validation).                                | 5 (additive)                                 |

**Confidence MED** on exact skill names — Phase 1 enumerates actual `security` profile contents.

#### From `research` profile (deferred)

Not immediately needed. ECC `research` profile contains skills like competitive analysis, market research. We currently don't have a research/competitive-analysis workflow in CRM scope. Defer.

**If user later adds CRM features around competitor tracking or market research, revisit Phase 7+.**

### 3.3 Excluded ECC components (rationale)

Things in `full` profile we explicitly do NOT take:

| ECC item                                                                                     | Why excluded                                                                                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Language reviewers for Rust/Go/Java/Kotlin/C++/Python/Ruby/PHP/Swift/etc.                    | Our stack is TS/JS only. Irrelevant noise.                                                                 |
| Content/marketing skills (`brand-voice`, `content-engine`, `crosspost`, `investor-outreach`) | Out of scope for CRM product.                                                                              |
| ML/AI skills (`pytorch-build-resolver`, `mle-reviewer`)                                      | Out of scope.                                                                                              |
| Operator workflow skills (`customer-billing-ops`, `messages-ops`, `email-ops`)               | Require real connector configs (Stripe, email providers, etc.) we don't have. Premature.                   |
| Hermes operator surface skills (advanced)                                                    | Multi-agent orchestration relevance, but specific use-cases (sanitized import) don't match ours. Deferred. |
| `ecc2/` Rust control-plane                                                                   | ALPHA per WORKING-CONTEXT.md. Not for migration period.                                                    |

### 3.4 Install layout question (OPEN — see Section 9 Q6)

ECC native layout places `agents/`, `skills/`, `hooks/`, `rules/` at repo root. Our repo is a Turborepo monorepo (`apps/web`, `apps/api`, `packages/shared`). Top-level pollution is a concern.

Options:

1. **Root install** (ECC native) — clean ECC pattern, top-level directory growth
2. **`.claude/ecc/` install** — keep ECC contained, may break some ECC tooling assumptions
3. **Symlink approach** — install at `.claude/ecc/`, symlink to root paths ECC expects

**Architect recommendation:** Option 1 (root install) for Phase 1 — least friction, most ECC-pattern-aligned. If monorepo cleanliness concerns emerge, refactor in Phase 6. Listed as open Q6 for User decision.

### 3.5 Profile selection confidence breakdown

| Decision                                                      | Confidence                                   |
| ------------------------------------------------------------- | -------------------------------------------- |
| Base = `developer`                                            | HIGH (REPO-ASSESSMENT.md explicit fit)       |
| Add `security-reviewer` agent                                 | HIGH (Phase 8 imminent + finance code paths) |
| Add specific `security` skills (defi-amm, evm-token-decimals) | MED (skill existence in v2.0.0-rc.1 TBD)     |
| Defer `research` profile                                      | HIGH (no current need)                       |
| Exclude `full` profile components                             | HIGH (stack mismatch)                        |
| Root install layout                                           | MED (open Q6)                                |

---

## Section 4 — Identified Gaps + Local Adaptations

ECC is comprehensive but not omniscient. Below: explicit gaps where ECC patterns do not cover our use cases, with concrete adaptation plans.

### 4.1 Russian language requirement

- **Gap:** ECC primary language is English. All agent prompts, skill descriptions, hook messages, RULES.md, AGENTS.md content are English. Our CLAUDE.md hard requirement: "Все агенты общаются с пользователем исключительно на русском языке. Никакого украинского."
- **Why ECC doesn't cover this:** ECC is upstream English-first. Author Affaan Mustafa operates in English.
- **Adaptation plan:**
  1. Phase 3 — When porting each agent to ECC format, prepend `**ВАЖНО: Всегда отвечай на русском языке.**` to each agent's role section (immediately after YAML frontmatter).
  2. Phase 3 — Strip any "respond in English" directives if present in ECC source agent.
  3. Phase 5 — Add a project-level rule `rules/common/russian-language.md` referenced by all our ported agents. (Cite our `feedback_*` memory items showing this is hard requirement.)
  4. Code comments and commit messages stay English (international future-proof). Lessons.md and `docs/business/` stay Russian. Git commit messages use Conventional Commits in English.
  5. ECC native agents (if we keep any unchanged, e.g., `tdd-guide`) — left in English, since we invoke them programmatically not user-facing.
- **Confidence:** HIGH

### 4.2 UA legal/tax jurisdictional context

- **Gap:** Legal agent has deep UA-specific knowledge (ФОП режимы, ПКУ articles, Закон 2074-IX virtual assets, Меморандум НБУ banking caps, CFC ст. 39² ПКУ, GDPR territorial scope for UA companies). ECC has no jurisdictional legal agent.
- **Why ECC doesn't cover this:** Legal advice is jurisdictionally bound; ECC is global tooling.
- **Adaptation plan:**
  1. Phase 3 — Keep Legal agent fully custom. Port to ECC YAML frontmatter format only. Preserve 4-mode dispatch (A/B/C/D), knowledge base references, escalation patterns.
  2. Phase 4 — Create custom skill stubs:
     - `skills/ua-tax-compliance/` (ФОП режимы, налоговые ставки)
     - `skills/ua-cfc-rules/` (контрольованих іноземних компаній, ст. 39² ПКУ)
     - `skills/ua-crypto-regulation/` (Закон 2074-IX, НКЦБФР virtual assets)
     - `skills/ua-banking-caps/` (Меморандум НБУ, limits)
     - `skills/legal-escalation-patterns/` (when to engage external lawyer)
       All with `origin: custom` in frontmatter. Empty/stub content initially, populates as lessons accumulate post-migration.
  3. Phase 6 — Documentation note in CONTRIBUTING.md that legal skills are project-internal, not for upstream ECC PR.
- **Confidence:** HIGH

### 4.3 PM Mode 1-5 orchestration

- **Gap:** Our PM is a multi-modal orchestrator (manual reply / auto-decompose / parallel dispatch / User Testing tunnel / Legal mode dispatch) with state management across sessions (`pm-state.json` schema v2: events, queues, circuit breakers, batch flows). ECC has `planner` (planning), `loop-operator` (in-session loops), `harness-optimizer` (config tuning) — pieces but no integrated orchestrator.
- **Why ECC doesn't cover this:** ECC focuses on coding workflows, not product-development orchestration with team-of-agents management.
- **Adaptation plan:**
  1. Phase 3 — Keep PM as custom orchestrator agent. Port to ECC YAML frontmatter format (`model: opus`, `tools: [Read, Edit, Bash, Agent, ...]`).
  2. PM internally invokes ECC sub-agents: `planner` for planning sub-tasks, `architect` for design choices, `loop-operator` patterns for cross-session waits.
  3. pm-state.json schema v2 stays. Phase 0 adds new event types (`architect_phase_started`, `architect_phase_completed`, `migration_rollback_executed`) per architect.md Coordination section.
  4. Phase 5 — Document PM orchestration pattern in `skills/pm-mode-orchestration/SKILL.md` for discoverability.
- **Confidence:** HIGH

### 4.4 pm-state.json schema v2

- **Gap:** Cross-session persistent state. ECC has no state-store primitive; ECC state is per-session implicit.
- **Why ECC doesn't cover this:** Single-developer workflows don't need cross-session state; ours does (multi-day product backlogs, User Testing async cycles, CI completion waits).
- **Adaptation plan:**
  1. Phase 0 — This ADR proposes schema v2 extension: add 3 new event types for Architect coordination.
  2. Phase 3 — Update pm.md state schema documentation to reflect new event types.
  3. Phase 5 — Skill doc `skills/pm-state-schema/SKILL.md` documents schema v2 for contributors.
- **Confidence:** HIGH

### 4.5 GHA-specific workflows

- **Gap:** Our `.github/workflows/*.yml` files (ci/e2e/auto-merge/labels-sync/check-no-skip-hooks/e2e-watchdog) embody product workflow. ECC examples exist but don't own topology.
- **Why ECC doesn't cover this:** GHA workflow design is project-specific. ECC inspires patterns but doesn't prescribe workflow files.
- **Adaptation plan:**
  1. Phase 5 — Keep all workflow files. Add ECC agent invocations as additive jobs where useful (e.g., new job in ci.yml that runs ECC `code-reviewer` on PR changes).
  2. Phase 6 — Delete archived workflows after final confirmation no rollback needed.
- **Confidence:** HIGH

### 4.6 BA (human role, not LLM agent)

- **Gap:** BA writes `docs/specs/pm-brief.md` based on user conversation. Human role. ECC catalogs LLM agents only.
- **Why ECC doesn't cover this:** ECC scope is LLM tooling.
- **Adaptation plan:**
  1. Phase 6 — Move BA docs (ba.md, CLAUDE-ba.md) to `docs/business/roles/ba.md` for clarity. Or keep in `docs/agents/` with note "human role, not LLM."
  2. No technical migration.
- **Confidence:** HIGH

### 4.7 Recruitment/staffing business model knowledge

- **Gap:** Our CRM is for an outsource/outstaffing recruiting agency. Business rules: max 10 teams, 1 active JUNIOR per project, RBAC matrix (ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT). ECC has no recruitment domain knowledge.
- **Why ECC doesn't cover this:** Domain-specific.
- **Adaptation plan:**
  1. Phase 4 — Custom skill: `skills/recruiting-domain-rules/SKILL.md` documents key business invariants (max 1 active junior per project, team composition rules, RBAC matrix). Helps future Coder agents recall constraints.
  2. Reference from PM-brief template + Coder agent prompt.
- **Confidence:** HIGH

### 4.8 3-layer watchdog resilience (D1-D4 fixes)

- **Gap:** Our `docs/architecture/2026-05-23-dev-flow-rca.md` documents C1/C3 + D1-D4 fixes: Coder intent marker (D2), pre-push AC verification (D3), Reviewer write-then-post (D1), AutoTest D3 dispatch decision (decision-tree). ECC has no equivalent multi-layer resilience system because ECC doesn't operate in our multi-agent + GHA + cross-session setup.
- **Why ECC doesn't cover this:** ECC primarily local-developer, single Claude Code instance. Our setup is multi-agent + remote (GHA) + cross-session.
- **Adaptation plan:**
  1. Phase 5 — Custom skill: `skills/dev-flow-resilience/SKILL.md` documents D1-D4 fixes for contributor onboarding.
  2. Skill references all relevant scripts/hooks (coder-intent.sh, coder-pre-push.sh) and explains the _why_.
- **Confidence:** HIGH

### 4.9 Active product PHASE work in parallel with migration

- **Gap:** Per CLAUDE.md, "Следующий шаг: PHASE 6 — Документы." PM dispatches Coder daily. Migration must not block this.
- **Why ECC doesn't cover this:** Cross-cutting project management; ECC tooling.
- **Adaptation plan:**
  1. Migration phases never touch `apps/**` or `packages/**` (hard rule per architect.md).
  2. Phase 1-3 use coexistence: new ECC `agents/`, `skills/`, `hooks/` live alongside legacy `docs/agents/`. Both work.
  3. PM agent unchanged until Phase 3 explicit cutover, dispatched as usual.
  4. User approval gate between every phase enforces no surprises.
- **Confidence:** HIGH

### 4.10 Summary of gaps + adaptations

| Gap                     | Adaptation type                           | Phase | Confidence |
| ----------------------- | ----------------------------------------- | ----- | ---------- |
| Russian language        | Prepend override + rule                   | 3+5   | HIGH       |
| UA legal context        | Keep Legal custom + UA skills             | 3+4   | HIGH       |
| PM Mode 1-5             | Keep PM custom + ECC sub-agent delegation | 3     | HIGH       |
| pm-state.json schema v2 | Keep custom + extend event types          | 0+6   | HIGH       |
| GHA workflows           | Keep custom + additive ECC jobs           | 5     | HIGH       |
| BA human role           | Doc placement decision                    | 6     | HIGH       |
| Recruitment domain      | Custom skill                              | 4     | HIGH       |
| 3-layer watchdog        | Custom skill (documentation)              | 5     | HIGH       |
| Active product work     | Coexistence pattern                       | 1-3   | HIGH       |

---

## Section 5 — Risk Matrix

### 5.1 Per-phase risks

| Phase                                       | Regression risk                                                                                      | State loss risk                                                                         | Workflow disruption                                 | Mitigation                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 (Discovery + ADR)**                     | NONE — docs only                                                                                     | NONE                                                                                    | NONE                                                | This ADR is the deliverable. User reviews + approves. No code touched.                                                                                                                                                                                                                             |
| **1 (Skeleton install)**                    | LOW — new dirs created alongside existing                                                            | LOW — pm-state.json untouched                                                           | LOW — PM keeps dispatching old agents               | Coexistence: ECC `agents/` lives next to `docs/agents/`. Validate `pnpm dev/test` passes. Rollback = `git revert PR` (single PR per phase).                                                                                                                                                        |
| **2 (Hooks migration)**                     | MED — hooks fire on tool use; bad matcher could block legitimate ops or fail to block dangerous ones | LOW — hooks are stateless                                                               | MED — if new hook misfires, agents may be blocked   | Each hook ports individually with regression test (manually trigger condition that should/shouldn't fire). Coexistence: old hooks stay in `.claude/hooks/` for 1 week after new validated. Rollback = remove new hook registration.                                                                |
| **3 (Agent migration)**                     | HIGH — agents are PM's primary tool; bad port breaks dispatch                                        | MED — pm-state.json contract changes (new event types) need testing                     | HIGH — PM dispatches new agents starting at cutover | Phase 3 sub-divided per-agent (7 sub-PRs: PM, Coder, AutoTest, Reviewer-code, Reviewer-security, DevOps, Legal). Per agent: test dispatch in isolation before PM cutover. Old agents in `docs/agents/_legacy/` for 1 week post-cutover. Rollback = pin PM to old `docs/agents/` paths via env var. |
| **4 (Lessons → skills)**                    | LOW — knowledge addition, agents start consulting skills                                             | MED — knowledge nuance loss possible (lesson syntax → skill structure may drop context) | LOW — agents continue working                       | User review of each created skill before commit. Group atomic lessons by topic before conversion (5-10 lessons → 1 skill, not 1:1). Lessons.md kept as append-log indefinitely (not deleted). Rollback = delete skill files, lessons.md untouched.                                                 |
| **5 (Workflows + GHA integration + rules)** | MED — GHA changes can break CI; rules extraction may have invisible coupling                         | LOW — config-level changes                                                              | MED — CI failure halts merges                       | GHA changes: each PR triggers full CI on itself (self-validating). Rules extraction: tested via dispatching agents and verifying rule-bound behavior unchanged. Rollback = `git revert PR`.                                                                                                        |
| **6 (Cleanup + retrospective)**             | LOW — deletions only after validation                                                                | MED — deleted legacy can't be easily restored                                           | LOW                                                 | Delete only what has been migrated AND verified for 2+ weeks. Use `git mv` not `git rm` where possible (preserves history). `_legacy/` content moved to `docs/architecture/2026-XX-XX-migration-archive/` first, then deleted from active tree. Rollback = `git revert PR`.                        |

### 5.2 Cross-cutting risks (orthogonal to phases)

| Risk                                                     | Probability | Severity | Mitigation                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ECC version drift during migration**                   | MED         | MED      | Pin to tag SHA `928076cc...` (v2.0.0-rc.1), not main. Quarterly upstream sync deferred to post-Phase-6 (separate Architect dispatch). Hot security fixes cherry-picked event-driven. Document pin in `ecc-pin.txt` at repo root for reproducibility.                            |
| **Contributor unfamiliarity with ECC patterns**          | MED         | LOW      | Phase 6 deliverable includes updated CONTRIBUTING.md + retrospective. PM/Architect agent prompts explicitly reference ECC RULES.md format. New contributors onboard via ECC `developer` profile docs first, then project-specific deltas.                                       |
| **Hidden coupling in current system**                    | MED         | MED      | Discovery Report + Section 2 mapping intentionally exhaustive (every artifact mapped, no "etc."). Phase 1 dry-run + Phase 2 hook spike surface unknowns early. Each phase has explicit rollback before next starts.                                                             |
| **ECC v2.0.0-rc.1 → GA breaking changes**                | LOW         | MED      | rc.1 → GA may introduce config schema changes. Mitigation: track ECC CHANGELOG.md weekly during migration. If GA ships before Phase 6 complete, decide adopt-now vs finish-pinned. Likely finish-pinned (don't change pin mid-migration), upgrade in first post-migration sync. |
| **Token budget exhaustion in long Architect dispatches** | LOW         | LOW      | Phase deliverables are file-saved incrementally. Recovery: next dispatch reads previous output, continues. ADR explicitly designed with section-by-section save (this file is incrementally Edited, not single Write).                                                          |
| **User unavailability for approval gates**               | MED         | LOW      | Phase 7+ deliverables have batched approval (multiple phases at once if user prefers). Default: per-phase gate, but flexible if user signals "batch next 2 phases."                                                                                                             |
| **Migration runs out of steam mid-way (Phase 4-5)**      | MED         | MED      | Each phase deliverable is independently valuable. If migration pauses indefinitely at e.g. Phase 3, ECC agents are operational; only the skill/rule polish is deferred. No "all-or-nothing" wager.                                                                              |
| **Conflict with daily product work (Coder zone)**        | LOW         | HIGH     | Hard rule: Architect never touches `apps/**`, `packages/**`. Enforced by `block-production-edits.sh` hook (kept active throughout migration).                                                                                                                                   |
| **Russian-language regression in ported agents**         | MED         | MED      | Phase 3 per-agent port includes explicit verification: dispatch ported agent with sample prompt, confirm Russian response. Add to AC checklist.                                                                                                                                 |
| **Loss of D1-D4 watchdog resilience during port**        | MED         | HIGH     | Phase 2 hook migration is risky here (D3 = coder-pre-push gating, D2 = coder-intent marker). Mitigation: keep custom logic 100% intact, only change registration format. Smoke test each: simulate the failure case D1-D4 originally fixed, confirm new hooks still block.      |

### 5.3 Risk summary

- **2 HIGH-severity risks:** Phase 3 agent migration disruption (mitigated by sub-division + coexistence), Coder zone conflict (mitigated by hard rule + hook enforcement).
- **8 MED-severity risks:** all with concrete mitigations.
- **Cross-cutting bias:** All risks favor coexistence/incremental over rip-and-replace. Aligned with architect.md "Hard rule #1: запрещено big bang migration."

---

## Section 6 — Phase Plan (0 → 6)

Each phase: name + timing + AC + PR title format + Deliverable (files) + Sub-tasks (checklist) + ECC patterns referenced + Verification + Rollback + Dependencies + Risks specific.

### Phase 0 — Discovery & Mapping (COMPLETED by this ADR)

- **Status:** Completed by submission of this document.
- **Timing:** 2-3 days actual (Discovery Report + this ADR).
- **AC:**
  - [x] Discovery Report published: `docs/architecture/2026-05-31-architect-discovery-report.md`
  - [x] Master ADR published: `docs/architecture/2026-05-31-ecc-migration-design.md` (this file)
  - [x] ECC version pin recommended with SHA
  - [x] Per-component mapping complete (Section 2)
  - [x] Install profile recommendation justified (Section 3)
  - [x] Risk matrix complete (Section 5)
  - [x] Phase 1-6 plan drafted (Section 6 below)
  - [x] Open questions for User raised (Section 9)
- **Deliverable:** This ADR document (`docs/architecture/2026-05-31-ecc-migration-design.md`)
- **PR title format:** N/A (Phase 0 produces ADR only, may or may not need its own PR)
- **ECC patterns referenced:** `EVALUATION.md` (table-driven inventory style), `REPO-ASSESSMENT.md` (install profile recommendation), `SOUL.md` (5 Core Principles), `RULES.md` (format specs), `WORKING-CONTEXT.md` (current state baseline)
- **Verification:** User reviews and signals "approve Phase 0" or "revise [X]" or "decide [open question Y]"
- **Rollback:** N/A (documents only, no system change)
- **Dependencies:** None — foundational
- **Risks specific:** Misjudged scope of Phase 4 (legal lessons sparser than Discovery Report suggested — corrected here).

### Phase 1 — ECC Skeleton via `developer` Install Profile (1 week target)

- **Status:** Pending User approval
- **Timing:** 1 week (4-8 hours Architect dispatch + User approval gate)
- **AC:**
  - [ ] ECC `v2.0.0-rc.1` tag SHA pinned in `ecc-pin.txt` at repo root
  - [ ] ECC `developer` profile installed (via ECC's install scripts OR cherry-pick if scripts fail in monorepo context)
  - [ ] ECC reference directories present at repo root (or `.claude/ecc/` per Q6 outcome): `agents/`, `skills/`, `hooks/`, `rules/`, `manifests/`, `mcp-configs/`
  - [ ] ECC reference files adapted to our project: `AGENTS.md` (project version with Russian language note + Legal agent listing), `RULES.md` (merge of ECC standard + our project-specific zone-of-write + Russian language + Conventional commits), `SOUL.md` (project identity: CRM for recruiting agency, multi-agent mission), `WORKING-CONTEXT.md` (current sprint, blockers, active queues)
  - [ ] MCP configs aligned: cross-reference our 8 servers vs ECC's `mcp-configs/`, adopt canonical where shape matches, keep custom where project-specific
  - [ ] Coexistence verified: existing `docs/agents/` untouched, existing `.claude/hooks/` untouched, all current workflows (PM dispatch, Coder, Reviewer, etc.) continue working
  - [ ] `pnpm dev` + `pnpm typecheck` + `pnpm test` pass without regression
- **Deliverable:**
  - PR title: `feat(architect): bootstrap ECC v2.0.0-rc.1 skeleton via developer profile`
  - Branch: `architect/phase-1-ecc-skeleton`
  - Files created: ~50-150 (depending on `developer` profile contents — exact count TBD by install)
  - Files modified: none in `docs/agents/`, `.claude/hooks/`, `apps/**`, `packages/**` (hard rule)
  - Files modified: possibly `.claude/settings.json` for MCP config alignment if needed
- **Sub-tasks:**
  1. Clone ECC at `v2.0.0-rc.1` tag (shallow clone, separate directory)
  2. Investigate `scripts/install-plan.js` compatibility with our Turborepo monorepo
  3. Execute install plan (dry-run) OR cherry-pick (if install incompatible)
  4. Decide layout per Q6 (root vs `.claude/ecc/`)
  5. Adapt 4 ECC reference files (AGENTS.md, RULES.md, SOUL.md, WORKING-CONTEXT.md) to project
  6. Align MCP configs
  7. Spike: investigate `continuous-learning` observer hook (informs Phase 2 decision on coder-progress-marker.sh)
  8. Spike: enumerate actual `security` profile skill names (informs Phase 5 add list)
  9. Verify coexistence: dispatch existing PM/Coder/etc., confirm no regression
  10. Document the install path taken (root vs `.claude/ecc/`) and why in PR description
- **ECC patterns referenced:** `REPO-ASSESSMENT.md` (install profiles), `CONTRIBUTING.md` (file templates), `WORKING-CONTEXT.md` (adaptation template)
- **Verification:**
  - Run all existing test suites: `pnpm test`
  - Manually dispatch PM with a sample task (e.g., "check status"), confirm normal response
  - Manually dispatch Coder with a small task, confirm normal flow
  - File diff inspection: confirm no changes in `apps/**`, `packages/**`, `docs/agents/**`, `.claude/hooks/**`
- **Rollback strategy:**
  - PR-level: `git revert <commit>` on main, branch deleted
  - Filesystem cleanup: `rm -rf agents/ skills/ hooks/ rules/ manifests/ mcp-configs/ ecc-pin.txt AGENTS.md SOUL.md WORKING-CONTEXT.md` (or `.claude/ecc/` if that layout chosen)
  - Restore: `git checkout main && git pull`
  - Verification: re-run baseline `pnpm test` + manual dispatch
- **Dependencies:** Phase 0 ADR approved
- **Risks specific:**
  - ECC install script monorepo incompatibility — mitigation: manual cherry-pick fallback documented
  - MCP config alignment may surface naming conflicts — mitigation: preserve our custom names if conflict, document in PR

### Phase 2 — Migrate Hooks (1 week target)

- **Status:** Pending Phase 1 completion + User approval
- **Timing:** 1 week (4-6 hours Architect + User approval)
- **AC:**
  - [ ] Each of 5 hooks ported to ECC JSON matcher format with specific predicates (not catch-all)
  - [ ] `safety.sh` → ECC PreToolUse hook (matcher: specific dangerous-command predicates)
  - [ ] `block-production-edits.sh` → ECC PreToolUse hook (matcher: `tool in ["Edit","Write","MultiEdit","NotebookEdit"] && file_path matches "apps/**|packages/**"`)
  - [ ] `coder-pre-push.sh` → ECC PreToolUse hook (matcher: `tool == "Bash" && command matches "git push"`)
  - [ ] `coder-progress-marker.sh` → REMOVED (if Phase 1 spike confirms ECC continuous-learning covers) OR ECC PostToolUse hook (otherwise)
  - [ ] `eslint-feedback.sh` → reduced scope ECC PostToolUse hook (trigger eslint MCP), MCP-first per CLAUDE.md
  - [ ] Each migrated hook tested: trigger condition that should fire + condition that should NOT fire
  - [ ] D1-D4 watchdog resilience preserved (smoke test: simulate D3 failure case, confirm new hook still blocks)
  - [ ] Old `.claude/hooks/*.sh` kept in repo for 1 week coexistence (delete in Phase 6)
  - [ ] `.claude/settings.json` updated to use ECC-format hooks
- **Deliverable:**
  - PR title: `feat(architect): migrate hooks to ECC JSON matcher format`
  - Branch: `architect/phase-2-hooks-migration`
  - Files created: `hooks/<name>.json` per hook (or single `hooks/hooks.json` per ECC pattern, TBD)
  - Files modified: `.claude/settings.json` (hook registration), `docs/agents/coder.md` (reference new hook paths)
  - Files kept (coexistence): `.claude/hooks/*.sh` (deleted in Phase 6)
- **Sub-tasks:**
  1. Read ECC `hooks/hooks.json` and 3-4 representative hooks for format reference
  2. Port `safety.sh` first (lowest risk): write hook JSON, test with dangerous + safe commands
  3. Port `block-production-edits.sh`: test with edits to apps/** (should block) and docs/** (should allow)
  4. Port `coder-pre-push.sh`: test with git push (should check AC) and other bash (should not fire)
  5. Decide on `coder-progress-marker.sh` based on Phase 1 spike: remove or port
  6. Port `eslint-feedback.sh` (reduced scope per MCP-first policy)
  7. Update `.claude/settings.json` to use ECC hook paths
  8. D1-D4 smoke tests: replay each original failure case, confirm new hook still blocks
  9. Document migration in PR description with before/after JSON snippets
- **ECC patterns referenced:** `hooks/hooks.json` (format), `RULES.md` "Hook Format" section (specific matcher requirement)
- **Verification:**
  - Trigger conditions for each hook (block/allow test pairs)
  - D1-D4 smoke tests
  - Full PM/Coder dispatch with hooks active
- **Rollback strategy:**
  - Revert `.claude/settings.json` to point back at `.claude/hooks/*.sh`
  - `git revert PR`
  - Verification: original hook behavior restored
- **Dependencies:** Phase 1 complete (ECC `hooks/` directory exists)
- **Risks specific:**
  - Hook misfire blocking legitimate dispatch — mitigation: per-hook test pairs before merge
  - D1-D4 resilience loss — mitigation: explicit smoke tests in AC
  - `coder-progress-marker.sh` decision uncertain — mitigation: Phase 1 spike + AC defers if unclear

### Phase 3 — Migrate Agents (2-3 weeks target)

- **Status:** Pending Phase 2 completion + User approval
- **Timing:** 2-3 weeks (16-24 hours Architect across multiple sub-PRs + User approval per agent)
- **AC:**
  - [ ] All 6 LLM agents ported to ECC YAML frontmatter format
  - [ ] Each ported agent has: `name`, `description`, `tools: [...]`, `model: opus|sonnet|haiku`
  - [ ] Russian language override added to every ported agent
  - [ ] Confidence policy applied consistently (HIGH/MED/LOW) per ECC code-reviewer pattern
  - [ ] Each agent test-dispatched independently before PM cutover
  - [ ] PM Mode 1-5 updated to dispatch new ECC-format agents
  - [ ] Old agent files moved to `docs/agents/_legacy/<name>.md` (preserved, not deleted)
  - [ ] No regression: dispatch flows that worked before still work
- **Deliverable:**
  - Multiple PRs (one per agent for risk isolation):
    - PR 3.1: `feat(architect): port PM agent to ECC format` (largest, highest risk)
    - PR 3.2: `feat(architect): port Coder agent + ECC sub-agent integration` (decompose to tdd-guide + typescript-reviewer)
    - PR 3.3: `feat(architect): port AutoTest agent`
    - PR 3.4: `feat(architect): split Reviewer into code-reviewer + security-reviewer`
    - PR 3.5: `feat(architect): port DevOps agent + build-error-resolver integration`
    - PR 3.6: `feat(architect): port Legal agent to ECC YAML format`
  - Branch per PR: `architect/phase-3-<agent-name>`
- **Sub-tasks (per PR template):**
  1. Read ECC equivalent agent files (e.g., for Coder PR: read `agents/tdd-guide.md`, `agents/typescript-reviewer.md`)
  2. Write new ECC-format agent file at `agents/<name>.md` with YAML frontmatter
  3. Add Russian language override
  4. Port unique custom logic preserved 100% (PM Mode 1-5, Coder watchdog, Reviewer write-then-post, Legal 4 modes)
  5. Test-dispatch new agent with sample prompts, confirm correct behavior
  6. Update PM dispatch logic (pm.md / pm-snippets.md) to invoke new ECC agent
  7. Move old `docs/agents/<name>.md` to `docs/agents/_legacy/<name>.md`
  8. Validate full workflow (PM dispatches new agent in product flow)
  9. Document in PR: before/after agent prompt, behavioral validation evidence
- **ECC patterns referenced:** `agents/planner.md`, `agents/architect.md`, `agents/code-reviewer.md`, `agents/security-reviewer.md`, `agents/tdd-guide.md`, `agents/build-error-resolver.md`, `agents/harness-optimizer.md`, `agents/loop-operator.md`, `RULES.md` "Agent Format"
- **Verification:**
  - Per-agent: dispatch sample prompts (Russian), validate response style/structure
  - Integration: PM dispatches each new agent in normal product workflow, confirm no regression
  - Migration safety: revert any sub-PR if downstream tests fail, fix forward in next iteration
- **Rollback strategy:**
  - Per sub-PR: `git revert <commit>`, branch deleted, PM dispatch points back to `docs/agents/<name>.md` (legacy preserved during phase)
  - Phase-level: revert all Phase 3 sub-PRs in reverse order
- **Dependencies:** Phase 2 complete (hooks ported, agents will use new hooks correctly)
- **Risks specific:**
  - PM port is highest single-agent risk (largest, most logic) — mitigation: dedicated sub-PR, extra User review time
  - Russian language regression — mitigation: AC checklist explicit verification
  - Tool allowlist too narrow → agent can't complete task — mitigation: start with same allowlist as current agent, narrow incrementally post-Phase-3
  - Reviewer split into 2 agents may double-review (both code + security review every PR) — mitigation: PM dispatch logic decides when to invoke security-reviewer (for finance/auth/USDT code paths only)

### Phase 4 — Lessons → ECC Skills (1-2 weeks target)

- **Status:** Pending Phase 3 completion + User approval
- **Timing:** 1-2 weeks (4-8 hours Architect + User review per skill)
- **AC:**
  - [ ] Each of 6 `lessons.md` files analyzed for topic clusters
  - [ ] Topic clusters with ≥3 atomic lessons converted to `skills/<topic>/SKILL.md`
  - [ ] Skills follow ECC structure: `name`, `description`, `origin` frontmatter + `## When to Activate` / `## Workflow` / `## Tested examples` sections
  - [ ] 5 UA-legal skill stubs created (per Section 4.2)
  - [ ] 1 recruiting-domain skill created (per Section 4.7)
  - [ ] Each created skill reviewed by User before commit
  - [ ] Original `lessons.md` files preserved as append-log (NOT deleted)
  - [ ] `docs/agents/memory/README.md` updated: "skills/ is primary; lessons.md remains append-log for new observations"
- **Deliverable:**
  - PR title: `feat(architect): convert lessons to ECC skills (Phase 4)`
  - Branch: `architect/phase-4-lessons-to-skills`
  - Files created: ~10-15 SKILL.md files
  - Files modified: `docs/agents/memory/README.md`
  - Files unchanged: all `lessons.md` files
- **Sub-tasks:**
  1. Per lessons.md file, identify topic clusters (group atomic lessons by tag)
  2. For clusters with ≥3 lessons: create skill
  3. For singleton lessons: leave in lessons.md (skills format overhead not justified for 1 lesson)
  4. Create UA-legal skill stubs with planned topics (empty/placeholder content for future fill)
  5. Create `skills/recruiting-domain-rules/SKILL.md` (business invariants)
  6. Update README.md
  7. PR description includes mapping table: which lessons → which skills, which lessons stayed in lessons.md
- **ECC patterns referenced:** `RULES.md` "Skill Format", `skills/nestjs-patterns/SKILL.md` (format reference), `the-shortform-guide.md` (skills-vs-commands narrative)
- **Verification:**
  - User reviews each skill for content fidelity
  - Sample agent dispatch references new skill (does agent activate correctly?)
- **Rollback strategy:**
  - `git revert PR` — lessons.md untouched so no data loss
  - Skill files deleted, lessons.md remains primary
- **Dependencies:** Phase 3 complete (agents in ECC format ready to consume skills)
- **Risks specific:**
  - Knowledge nuance loss in conversion — mitigation: User review per skill, group-by-topic (not 1:1), lessons.md preserved
  - Skill files grow stale if lessons.md continues as append-log (drift) — mitigation: document policy in README that new patterns can flow either direction (lesson → skill consolidation periodic in Phase 6)

### Phase 5 — Workflows + GHA Integration + Rules + Cross-Harness Placeholders (1 week target)

- **Status:** Pending Phase 4 completion + User approval
- **Timing:** 1 week (4-6 hours Architect + User approval)
- **AC:**
  - [ ] Top 5-8 cross-cutting rules extracted to ECC `rules/` directory
  - [ ] Rules referenced from ported agent prompts (replacing inline directives)
  - [ ] `.github/workflows/ci.yml` adds optional ECC `code-reviewer` invocation job (additive, not replacing)
  - [ ] Cross-harness placeholder directories created (`.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.zed/`) with README explaining they are placeholders until Phase 7+
  - [ ] `agent.yaml` manifests exported for cross-harness portability per ECC pattern
  - [ ] 3 custom skills created to document project-specific patterns: `skills/cross-session-orchestration/SKILL.md`, `skills/user-testing-tunnel/SKILL.md`, `skills/dev-flow-resilience/SKILL.md`, `skills/pm-mode-orchestration/SKILL.md`
- **Deliverable:**
  - PR title: `feat(architect): rules extraction + GHA integration + cross-harness placeholders`
  - Branch: `architect/phase-5-workflows-rules`
  - Files created: ~10-15 (rules + skill docs + cross-harness placeholders)
  - Files modified: agent prompts (replace inline rules with `@rule` references), `.github/workflows/ci.yml` (additive job)
- **Sub-tasks:**
  1. Extract top cross-cutting rules: Russian language, zone-of-write, confidence policy, conventional commits, AC verification, no --no-verify, hard escalation zones
  2. Write `rules/common/<name>.md` per rule following ECC format
  3. Update each ported agent to reference rules instead of inlining (shorter prompts, single source of truth)
  4. Add `.github/workflows/ci.yml` additive job: `ecc-code-review` (invokes ECC code-reviewer on PR diff)
  5. Create cross-harness placeholder directories with README
  6. Generate `manifests/<agent>.yaml` per ECC manifest pattern for our custom agents
  7. Create 4 documentation skills for project-specific patterns
- **ECC patterns referenced:** `rules/common/`, `rules/typescript/` (format reference), `manifests/` (cross-harness pattern), `.codex/` `.cursor/` etc. (cross-harness directories)
- **Verification:**
  - Dispatch agent, confirm rules are followed (Russian response, zone-of-write respected, confidence labels applied)
  - CI runs successfully on PR (new job passes)
  - Cross-harness directories present but no active use yet
- **Rollback strategy:**
  - `git revert PR`
  - Agents revert to inline rules (still functional)
- **Dependencies:** Phase 4 complete (skills exist, rules can cross-reference them)
- **Risks specific:**
  - Rule extraction may miss nuance from inline context — mitigation: side-by-side review, test agent dispatches
  - GHA additive job may fail (false negatives) — mitigation: start as informational (don't block merge), promote to blocking later
  - Cross-harness placeholders may bit-rot if Phase 7 never happens — mitigation: README clearly states "placeholder, not active"

### Phase 6 — Cleanup + Retrospective (1 week target)

- **Status:** Pending Phase 5 completion + User approval
- **Timing:** 1 week (3-5 hours Architect + User final approval)
- **AC:**
  - [ ] `docs/agents/_legacy/` content moved to `docs/architecture/2026-XX-XX-migration-archive/`
  - [ ] Old `.claude/hooks/*.sh` deleted (after Phase 2 coexistence period elapsed + no rollbacks needed)
  - [ ] Archived GHA workflows in `.github/workflows/archive/` deleted (history in git)
  - [ ] `CLAUDE.md` updated to reference ECC structure (new sections, links)
  - [ ] `CONTRIBUTING.md` updated with ECC agent/skill/hook conventions for new contributors
  - [ ] Final `RULES.md` reflects merged ECC standards + project-specific (Russian language, UA legal context, zone-of-write)
  - [ ] Migration retrospective document: `docs/architecture/2026-XX-XX-ecc-migration-retrospective.md` (lessons learned, what worked, what would do differently)
  - [ ] BA docs decision implemented (move to `docs/business/roles/ba.md` or annotate in place per Section 4.6)
  - [ ] pm-state.json schema v2 documentation updated with new event types (`architect_phase_started`, `architect_phase_completed`, `migration_rollback_executed`)
  - [ ] `lessons.md` files reviewed for any new lessons added during migration → consolidated into skills if cluster forms
- **Deliverable:**
  - PR title: `chore(architect): cleanup legacy structures + retrospective (Phase 6)`
  - Branch: `architect/phase-6-cleanup`
  - Files deleted: `docs/agents/_legacy/`, `.claude/hooks/*.sh`, `.github/workflows/archive/`
  - Files moved: legacy to migration-archive
  - Files modified: CLAUDE.md, CONTRIBUTING.md, RULES.md, pm.md (state schema)
  - Files created: migration-retrospective.md
- **Sub-tasks:**
  1. Verify no active code references `_legacy/` paths (grep + visual inspection)
  2. Move `_legacy/` to `migration-archive/` for historical preservation
  3. Delete `.claude/hooks/*.sh` (Phase 2 coexistence period elapsed)
  4. Delete `.github/workflows/archive/` (history in git, no recovery needed)
  5. Update CLAUDE.md sections: replace references to `docs/agents/<name>.md` with `agents/<name>.md`, add ECC structure overview
  6. Update CONTRIBUTING.md with ECC patterns guide
  7. Merge final RULES.md (ECC + project)
  8. BA docs final placement decision implementation
  9. pm-state.json schema documentation update
  10. Lessons review (post-migration consolidation)
  11. Write retrospective: what worked, what would do differently, ECC version sync recommendation for next quarter
- **ECC patterns referenced:** `CHANGELOG.md` (versioning reference for ECC sync planning)
- **Verification:**
  - Full `pnpm test` + `pnpm typecheck` + sample dispatch of every agent (smoke)
  - No references to deleted paths
  - Documentation links intact
- **Rollback strategy:**
  - `git revert PR`
  - Legacy files restored from archive (but since git history intact, can also `git show <commit>:<path>`)
- **Dependencies:** Phase 5 complete + 2+ week stability period (no issues from any prior phase)
- **Risks specific:**
  - Premature deletion of legacy → cannot rollback Phase 3 if issue emerges later — mitigation: 2+ week stability gate + git history fallback
  - CLAUDE.md / CONTRIBUTING.md may have stale references — mitigation: grep + manual review

### Phase plan summary

| Phase     | Title                      | Timing        | Effort     | Risk             |
| --------- | -------------------------- | ------------- | ---------- | ---------------- |
| 0         | Discovery + ADR            | 2-3 days      | 8-12h      | NONE (docs only) |
| 1         | Skeleton install           | 1 week        | 4-8h       | LOW              |
| 2         | Hooks migration            | 1 week        | 4-6h       | MED              |
| 3         | Agent migration            | 2-3 weeks     | 16-24h     | HIGH             |
| 4         | Lessons → skills           | 1-2 weeks     | 4-8h       | LOW              |
| 5         | Rules + GHA + placeholders | 1 week        | 4-6h       | MED              |
| 6         | Cleanup + retro            | 1 week        | 3-5h       | LOW              |
| **Total** |                            | **6-9 weeks** | **43-69h** |                  |

User approval gate between every phase. Pause/resume freely per architect.md Pause/resume policy.

---

## Section 7 — ECC Version Pin + Upstream Sync Policy

### 7.1 Pin selection

**Pinned version:** `v2.0.0-rc.1`
**Tag SHA:** `928076cc08cbb31e8549cea2883b4f51811de1c8` (verified via `gh api repos/affaan-m/ECC/git/refs/tags`)
**Pin date:** 2026-05-31
**Pin file:** `ecc-pin.txt` at repo root (created in Phase 1)

**Why pin the tag SHA, not the tag name:** Tags can be moved (force-pushed). SHA is immutable. Reproducibility absolute.

**Why v2.0.0-rc.1, not main HEAD:**

- main HEAD as of 2026-06-02 = `99baa825...` ("define ECC platform value loop #2119") — post-rc work in progress, may be unstable
- rc.1 is a tagged release candidate, more stable than HEAD
- HIGH confidence per Discovery Report: rc.1 ships agents directly relevant to our multi-agent orchestration work (`harness-optimizer`, `code-architect`, `code-explorer`, `loop-operator`)
- Fallback to v1.10.0 (`846ffb75...`) cheap if Phase 1 install reveals blocking issues

**Fallback decision criteria (during Phase 1):**

- Trigger: `node scripts/install-plan.js --profile developer` fails OR generates broken layout in our monorepo
- Action: re-pin to `v1.10.0` SHA `846ffb75da9a5f4e677d927af1ad4a1951652267`, document in PR description
- Mitigation tradeoff: lose access to rc.1's harness-optimizer + loop-operator, but `developer` profile present in 1.10.0 too

### 7.2 During migration (Phase 1-6): freeze

- **Policy:** Pin frozen for entire migration duration (~6-9 weeks)
- **No mid-migration version changes** except:
  - Critical security patch from ECC upstream → cherry-pick into our pin, document in `ecc-pin.txt` revision note
  - Phase 1 fallback to v1.10.0 (one-time, documented above)
- **Rationale:** Migration is incremental and assumes stable ECC base. Version churn during migration multiplies risk.

### 7.3 Post-migration upstream sync (after Phase 6)

- **Policy:** Quarterly upstream sync via separate Architect dispatch
- **Sync workflow:**
  1. New Architect dispatch with task: `task-architect-ecc-sync-<quarter>.md`
  2. Architect compares pinned SHA vs current ECC main
  3. Reviews CHANGELOG.md for breaking changes since pin
  4. Drafts mini-ADR: which new agents/skills/rules adopt, which to defer, breaking changes mitigation
  5. User approval gate
  6. Phased sync (similar pattern to Phase 1-6 micro-scale)
- **First sync date target:** Q1 2026 post-migration (estimated ~2026-Q4 if migration starts now)

### 7.4 Hot-fix policy (security patches)

- **Trigger:** Security advisory from ECC upstream (e.g., a hook vulnerability, prompt injection in shipped agent)
- **Action:**
  - Cherry-pick fix commit into our pinned snapshot
  - Update `ecc-pin.txt` with "+ cherry-pick <sha> for CVE-XXXX"
  - Brief Architect dispatch to verify fix integrated correctly
  - Skip quarterly batch gate (security warrants immediate action)
- **Frequency expectation:** Rare. ECC author maintains security focus per SOUL.md principles.

### 7.5 Version range testing strategy

- **No multi-version testing during migration.** Lock to pin.
- **Post-migration sync testing:**
  - Create branch with proposed sync changes
  - Run full test suite + dispatch every agent for smoke
  - Compare behavior diff (regression hunt)
  - Document in sync ADR

### 7.6 `ecc-pin.txt` schema (proposed)

```
ECC_VERSION_TAG=v2.0.0-rc.1
ECC_VERSION_SHA=928076cc08cbb31e8549cea2883b4f51811de1c8
ECC_PIN_DATE=2026-05-31
ECC_PIN_ADOPTED_BY=Architect dispatch (Phase 0 master ADR)
ECC_REPO_URL=https://github.com/affaan-m/ECC
ECC_CHERRY_PICKS=
  # Format: <sha> <date> <reason>
  # (empty until first cherry-pick)
ECC_NEXT_SYNC_DATE=2026-12-XX  # Q4 2026 quarterly sync
```

---

## Section 8 — Confidence Breakdown

Per major decision in this ADR. Format: `Decision | Confidence | Rationale`.

### 8.1 Strategic decisions

| Decision                                                    | Confidence | Rationale                                                                                                       |
| ----------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| Adopt ECC v2.0.0-rc.1 (vs 1.10.0)                           | **HIGH**   | rc.1 ships agents directly relevant to multi-agent orchestration. Fallback to 1.10.0 is cheap if install fails. |
| Install profile = `developer` base                          | **HIGH**   | REPO-ASSESSMENT.md explicit recommendation for SaaS+TS+React+NestJS stack.                                      |
| Add `security-reviewer` from security profile               | **HIGH**   | Phase 8 (USDT smart contracts) imminent + finance code paths warrant.                                           |
| Add specific security skills (defi-amm, evm-token-decimals) | **MED**    | Skill existence in v2.0.0-rc.1 catalog TBD by Phase 1 enumeration.                                              |
| Defer `research` profile                                    | **HIGH**   | No current research workflow.                                                                                   |
| Exclude `full` profile non-applicable components            | **HIGH**   | Stack mismatch (Rust/Go/Java/Python reviewers, content/marketing/ML skills, operator workflows).                |

### 8.2 Component-level decisions

| Decision                                                                    | Confidence   | Rationale                                                                                            |
| --------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| Keep PM as custom orchestrator                                              | **HIGH**     | No ECC equivalent for daily product workflow management.                                             |
| Keep Legal as custom agent                                                  | **HIGH**     | UA jurisdictional specificity — no ECC equivalent.                                                   |
| Keep BA as human role (unchanged)                                           | **HIGH**     | Out of LLM scope.                                                                                    |
| Decompose Coder into ECC `tdd-guide` + `typescript-reviewer` + custom shell | **MED-HIGH** | Decomposition pattern justified by ECC philosophy; tool allowlist tuning may need Phase 3 iteration. |
| Split Reviewer into `code-reviewer` + `security-reviewer`                   | **HIGH**     | ECC pattern well-documented; matches our existing Verdict: BLOCK + write-then-post.                  |
| Decompose DevOps into ECC `build-error-resolver` + custom GHA shell         | **MED**      | ECC build-error-resolver scope vs our DevOps responsibilities not fully verified; Phase 3 spike.     |
| Keep AutoTest as custom shell with ECC playwright skills                    | **MED**      | D3 dispatch decision logic unique; playwright skills in v2.0-rc.1 catalog TBD.                       |
| Port hooks to ECC JSON format (preserve logic)                              | **HIGH**     | Format change, logic preserved. Low risk if smoke tested.                                            |
| Remove `coder-progress-marker.sh` if ECC continuous-learning covers         | **LOW**      | Pending Phase 1 spike on ECC observer behavior. May Adapt instead.                                   |
| Convert lessons → skills (group by topic)                                   | **MED-HIGH** | Knowledge nuance preservation via grouping + User review. Lessons.md preserved as fallback.          |
| Russian language overlay on all ported agents                               | **HIGH**     | Clear adaptation pattern, project hard requirement.                                                  |
| Create UA-legal skill stubs (defer content)                                 | **HIGH**     | Lessons sparse currently; stubs populate organically post-migration.                                 |
| Keep all GHA workflow files (additive ECC integration)                      | **HIGH**     | GHA topology is ours; ECC inspires job patterns.                                                     |
| Cross-harness placeholder directories                                       | **MED**      | Placeholders may bit-rot; clearly documented as "not active."                                        |
| Extract top 5-8 rules to ECC `rules/`                                       | **MED-HIGH** | Pattern straightforward; exact rule list refined in Phase 5.                                         |
| pm-state.json schema v2 extension (3 new event types)                       | **HIGH**     | Additive change, no breaking. Architect Coordination per architect.md.                               |

### 8.3 Process decisions

| Decision                                                       | Confidence | Rationale                                                                 |
| -------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| Per-phase User approval gates                                  | **HIGH**   | Architect.md hard rule #4.                                                |
| Coexistence layers (Phase 1-3)                                 | **HIGH**   | Standard incremental migration practice.                                  |
| 1 PR per agent (Phase 3 sub-division)                          | **HIGH**   | Risk isolation; per-agent rollback granularity.                           |
| Lessons.md preserved as append-log after skill conversion      | **HIGH**   | Discovery Report mitigation accepted.                                     |
| Legacy moved to `_legacy/` then `migration-archive/` (Phase 6) | **HIGH**   | Standard archival pattern.                                                |
| 6-9 week timeline estimate                                     | **MED**    | Depends on User approval cadence; pause/resume flexible per architect.md. |
| ECC version pin = tag SHA (not tag name)                       | **HIGH**   | Reproducibility absolute.                                                 |
| Quarterly post-migration sync schedule                         | **MED**    | First sync rhythm TBD by actual usage.                                    |

### 8.4 Open uncertainty (LOW confidence)

Single LOW item: **`coder-progress-marker.sh` future** (subsumed by ECC continuous-learning, or keep). Resolved by Phase 1 spike.

Otherwise: 0 LOW. Most decisions HIGH; ~7 MED awaiting Phase 1 install POC or Phase 3 dispatch tuning.

### 8.5 Overall ADR confidence

**MED-HIGH.** Strategic direction HIGH. Operational specifics need Phase 1-3 iteration but rollback paths preserve safety throughout.

---

## Section 9 — Open Questions for User

These are decisions the Architect cannot make alone and require User input before Phase 1 entry (or, for some, can be decided during Phase 1).

### Q1. Migration timeline & cadence

**Context:** Architect estimates 6-9 weeks total (Phase 1-6) at 1-2 dispatches per week + User approval gates between phases.

**Options:**

- **A. Standard cadence** — 6-9 weeks, per-phase approval gate, normal pace. Allows full product work in parallel (PHASE 6 Documents proceeds under PM dispatch unchanged).
- **B. Accelerated cadence** — 4-6 weeks, batched approvals (approve Phase 1+2 together, Phase 3+4 together, etc.). Higher Architect dispatch frequency. Slight risk increase (less time to detect issues).
- **C. Slow burn** — 10-14 weeks, single-phase-per-week strict, extra User review time. Lower risk, more parallel product work.

**Architect recommendation:** **A (Standard)**. Balances safety with progress. User can downgrade to C at any point ("pause migration" per architect.md).

**Impact if wrong:** Wrong choice = either workflow disruption (B too fast) or migration becomes "always tomorrow" stale (C too slow). A is the safe default.

### Q2. Cross-harness scope

**Context:** ECC supports 7 harnesses (Claude Code, Codex, Cursor, OpenCode, Gemini, Zed, GitHub Copilot). Our current setup is Claude Code only.

**Options:**

- **A. Claude Code only** — Phase 5 creates placeholder cross-harness directories but no active porting. Phase 7+ optional if User wants.
- **B. Add Codex parity** — Phase 5 actively populates `.codex/` with agent ports. ~+1 week effort.
- **C. Full cross-harness** — All 5 alternate harnesses active. ~+3 weeks effort. Significant ongoing maintenance cost.

**Architect recommendation:** **A (Claude Code only)**. Cross-harness expansion is a separate scope decision; no current need.

**Impact if wrong:** If User actually uses Codex/Cursor, Phase 5 placeholders are dead weight. Easy to add later.

### Q3. Approval gate cadence

**Context:** Default = User approves each phase before Architect proceeds.

**Options:**

- **A. Per-phase approval** (default per architect.md)
- **B. Batched approval** (approve Phase 1+2 together, 3+4 together, etc.)
- **C. Full pre-approval** (User approves entire 6-phase plan once at Phase 0 end; Architect proceeds autonomously with milestone notifications)

**Architect recommendation:** **A**. Per-phase gates surface issues earlier. Aligns with hard rule #4 + Discipline > speed principle.

**Impact if wrong:** Wrong = either User overhead (C if user wants involvement) or runaway migration without checkpoints (C if user wants control).

### Q4. Security profile additions specificity

**Context:** Section 3.2 proposes adding `security-reviewer` agent + 3 security skills (defi-amm-security, evm-token-decimals, wallet-address-validation). Skill existence in v2.0.0-rc.1 catalog is MED confidence (TBD Phase 1 enumeration).

**Options:**

- **A. Add all proposed security items** (commit to list now, adjust during Phase 1 if skills don't exist)
- **B. Defer all security additions** until Phase 8 (USDT phase) actually starts; minimal Phase 5 only adds security-reviewer
- **C. Adopt full `security` profile** (oversize but exhaustive)

**Architect recommendation:** **A**. Phase 8 is in roadmap (CLAUDE.md current status), prep is valuable. List adjusts if skills don't exist in pin version.

**Impact if wrong:** B = scrambling to add security tooling later when Phase 8 starts. C = noise. A = best balance.

### Q5. BA documentation placement

**Context:** BA is a human role (writes pm-brief.md). Currently docs are co-located with LLM agents in `docs/agents/ba.md`. Phase 6 cleanup decision.

**Options:**

- **A. Keep in `docs/agents/ba.md`** with note "human role, not LLM"
- **B. Move to `docs/business/roles/ba.md`** to disambiguate
- **C. Move to `docs/agents/_human/ba.md`** to keep `docs/agents/` thematically related but disambiguated

**Architect recommendation:** **B**. Clearest separation. BA is a business role not an agent.

**Impact if wrong:** Cosmetic. Easy to move later.

### Q6. ECC install layout (monorepo concern)

**Context:** ECC native layout places `agents/`, `skills/`, `hooks/`, `rules/`, `manifests/`, `mcp-configs/` at repo root. Our repo is a Turborepo monorepo (`apps/web`, `apps/api`, `packages/shared`).

**Options:**

- **A. Root install** (ECC native) — clean ECC pattern, ~6-7 new top-level directories
- **B. `.claude/ecc/` containment** — keeps ECC contained; may break ECC tooling assumptions
- **C. Symlink approach** — install at `.claude/ecc/`, symlinks at root paths ECC tooling expects

**Architect recommendation:** **A (root install)**. ECC tooling designed for root layout. Phase 1 dry-run will reveal compatibility issues. Top-level pollution acceptable cost for ECC native compatibility.

**Impact if wrong:** B/C may break ECC tooling; A may feel cluttered. Easy to refactor in Phase 6 if needed.

### Q7. Russian-language enforcement strategy

**Context:** Russian language is hard requirement (CLAUDE.md). Section 4.1 proposes adapting via prepended override + project rule.

**Options:**

- **A. Per-agent prepend** (architect.md current pattern) — every ported agent has `**ВАЖНО: Всегда отвечай на русском языке.**` at top of role section
- **B. Single shared rule** — `rules/common/russian-language.md`, agents reference via `@rule` syntax
- **C. Both** (belt-and-suspenders) — prepend in agent + shared rule

**Architect recommendation:** **C** for Phase 3, reduce to B in Phase 5 once rule extraction proves effective.

**Impact if wrong:** A alone has duplication. B alone risks agent forgetting if rule reference fails. C is safe overkill, easy to trim.

### Q8. (NEW — surfaced during ADR drafting) Legal lessons.md status

**Context:** Discovery Report referenced "24 P0-rich UA tax lessons in legal/lessons.md." Verification during ADR drafting reveals legal/lessons.md is currently a 46-line skeleton (header + format example), not 24 accumulated lessons. The 24 lessons were _planned_ in `docs/architecture/2026-05-31-legal-agent-design.md` but not yet captured.

**Question:** Does this change Phase 4 scope?

**Architect's interpretation:** Yes — reduces Phase 4 legal-skills work. Section 2.4.6 already corrects to "create skill stubs with placeholder content, populate as Legal agent consultations actually happen post-migration." Confirmation requested.

**User decision:**

- **A. Confirm Architect interpretation** — proceed as Section 2.4.6
- **B. Backfill the 24 planned lessons before Phase 4** — Legal agent activity needed first
- **C. Skip UA-legal skills entirely until lessons actually accumulate** (defer to post-migration)

**Architect recommendation:** **A**. Stubs are useful scaffolding; content can fill as lessons happen.

### Q9. (NEW) Should this ADR be its own PR before Phase 1?

**Context:** Architect docs are in `docs/architecture/` which is Architect zone-of-write. This ADR is a foundational document.

**Options:**

- **A. Commit as part of Phase 0 (this dispatch)** — single commit on `claude/loving-leavitt-dd9b53` branch, no PR
- **B. Open ADR PR for User review** before Phase 1 starts
- **C. Include in Phase 1 PR** — bundled with skeleton install

**Architect recommendation:** **B**. ADR is foundational; explicit PR gives User review surface. Phase 1 PR then references this ADR as its design basis.

**Impact:** A is fastest but less explicit. B is clearer audit trail. C bundles concerns.

### Q10. (NEW) Should new event types in pm-state.json schema v2 wait for Phase 6, or be proposed now?

**Context:** Section 2.6.1 proposes adding `architect_phase_started`, `architect_phase_completed`, `migration_rollback_executed` event types.

**Options:**

- **A. Propose now in Phase 0 ADR** (this document), implement in pm.md update in Phase 6
- **B. Defer entirely to Phase 6** — no Phase 0 mention
- **C. Implement in pm.md now** (this dispatch) since pm.md is in Architect zone-of-write

**Architect recommendation:** **A**. Document the proposal here; implementation later. C is tempting but mixes Phase 0 deliverable with operational change.

**Impact:** Low — purely process question.

---

## Section 10 — Approval & Next Steps

### What Architect needs from User

1. **Approval of overall direction** (this ADR sections 1-8): Yes / No / Revise
2. **Decisions on open questions** (Section 9, especially Q1, Q2, Q4, Q6, Q7, Q8)
3. **Signal to proceed Phase 1** OR signal to revise specific sections of this ADR

### Architect's next action upon approval

Phase 1 dispatch with task:

- Clone ECC at pinned SHA
- Investigate install-plan.js compatibility with our monorepo
- Execute install (or cherry-pick fallback)
- Create coexistence layer
- Open PR: `feat(architect): bootstrap ECC v2.0.0-rc.1 skeleton via developer profile`

Phase 1 deliverable estimated: 4-8 hours Architect work, single PR.

### Architect's next action if revision requested

- Identify revision scope
- Re-edit this ADR sections incrementally
- Resubmit for approval

### Architect's next action if Phase 0 rejected

- Document rejection rationale
- Propose alternative migration strategy OR recommend status quo (no migration)
- Final dispatch outcome: archive ADR with status: **Superseded** or **Rejected**

---

## Appendix A — Cross-references

- **Discovery Report:** `docs/architecture/2026-05-31-architect-discovery-report.md` (baseline understanding)
- **Architect role spec:** `docs/agents/architect.md` (this dispatch's authority)
- **Dev-flow RCA (D1-D4):** `docs/architecture/2026-05-23-dev-flow-rca.md` (resilience patterns to preserve)
- **Legal agent design:** `docs/architecture/2026-05-31-legal-agent-design.md` (recent ADR, mentioned for context)
- **ECC repository:** <https://github.com/affaan-m/ECC> (tag `v2.0.0-rc.1`, SHA `928076cc...`)
- **ECC EVALUATION.md:** template inspiration for this ADR's structure
- **ECC REPO-ASSESSMENT.md:** install profile recommendation source
- **ECC SOUL.md:** 5 Core Principles
- **ECC RULES.md:** agent/skill/hook format specs
- **ECC AGENTS.md:** v2.0.0-rc.1 catalog

## Appendix B — Glossary

- **ECC:** Everything Claude Code, AI coding plugin framework by Affaan Mustafa
- **ADR:** Architecture Decision Record
- **Coexistence:** Multi-phase pattern where new ECC artifacts live alongside legacy artifacts until validated
- **Zone-of-write:** Architect-defined writeable paths per agent (Architect cannot touch `apps/**`, `packages/**`; Legal cannot touch agent prompts; etc.)
- **Mode 1-5:** PM dispatch decision tree (manual reply / auto-decompose / parallel dispatch / User Testing tunnel / Legal escalation)
- **D1-D4:** Dev-flow RCA fixes (D1: Reviewer write-then-post, D2: Coder intent marker, D3: pre-push AC verification, D4: e2e-watchdog)
- **pm-state.json schema v2:** Cross-session state store for PM (events, queues, circuit breakers, batch flows)
- **Confidence policy:** HIGH/MED/LOW labels per decision; LOW on critical = STOP and discuss with User

---

**End of master ADR. Status: Proposed. Awaiting User approval for Phase 1 entry + Section 9 open question decisions.**
