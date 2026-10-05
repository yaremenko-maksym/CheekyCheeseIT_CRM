# Architect Discovery Report — ECC Migration

**Date:** 2026-05-31 (UTC), session 2026-06-03
**Architect:** Migration Architect (first dispatch)
**Status:** Pre-Phase-0 — discovery only. **Do not edit anything in this dispatch except this file.**
**Scope:** Initial deliverable per `docs/agents/architect.md` section "Initial deliverable on first dispatch".

---

## Reading inventory

### Current state (16 files / fully read)

1. `CLAUDE.md` (root) — project memory bank, stack, business rules, all phases
2. `docs/agents/pm.md` — PM orchestrator Mode 1-5 + Legal integration
3. `docs/agents/CLAUDE-pm.md` — operational notes, schedule-wakeup limits, pm-state.json schema v2
4. `docs/agents/pm-snippets.md` — dispatch templates for all agents
5. `docs/agents/coder.md` — Coder workflow, chunking rules, watchdog resilience
6. `docs/agents/autotest.md` — AutoTest 3 modes + dispatch decision D3
7. `docs/agents/reviewer.md` — Reviewer + the Verdict: BLOCK pattern, write-then-post
8. `docs/agents/devops.md` — DevOps zone, CI/CD
9. `docs/agents/legal.md` — Legal 4 modes (consult / pr-review / brief-check / strategic)
10. `docs/agents/CLAUDE-coder.md` — operational notes
11. `docs/agents/CLAUDE-legal.md` — operational notes
12. `docs/agents/memory/README.md` — the lesson format with priority tags
13. `docs/agents/memory/{pm,coder,reviewer,autotest,devops,legal}/lessons.md` — all 6 files (legal the richest — 24 lessons about UA-tax/CFC/crypto/contracts)
14. `docs/architecture/2026-05-23-dev-flow-rca.md` — the RCA on C1-C3 + D1-D4 (a 3-layer watchdog)
15. `docs/architecture/2026-05-31-legal-agent-design.md` — the Legal agent ADR (fresh)
16. `.github/workflows/*` — ci.yml, e2e.yml, auto-merge-on-label.yml, labels-sync.yml, e2e-watchdog.yml + archive/
17. `.github/labels.yml` — 17 declarative labels
18. `.claude/hooks/{safety,block-production-edits,coder-pre-push,coder-progress-marker,eslint-feedback}.sh`
19. `.claude/settings.json` — hooks registration (`PreToolUse` Bash/Edit, `PostToolUse` Edit|Write|MultiEdit)
20. `scripts/coder/coder-intent.sh` — the intent marker for the recovery layer 8.1.1
21. `scripts/pm/{prep-user-testing.sh,pm-schedule.sh}` (sizes confirmed, contracts known from pm.md)

### ECC reference (14 files / read for format + philosophy)

22. **`SOUL.md`** — core identity, 5 core principles
23. **`WORKING-CONTEXT.md`** — current state v1.10.0 + 2.0-rc.1 alpha, sprint focus
24. **`EVALUATION.md`** — **the literal template for the Phase 0 ADR** (current vs ECC inventory table)
25. **`REPO-ASSESSMENT.md`** — 5 install profiles, the recommended `developer` for our profile
26. `RULES.md` — Must Always/Never + format specs (Agent / Skill / Hook / Commit)
27. `CONTRIBUTING.md` — head only (skill/agent/hook templates, PR process)
28. `AGENTS.md` — v2.0.0-rc.1 catalog: 63 agents, 249 skills, 79 commands, 14 MCP configs, 5 core principles
29. `CLAUDE.md` (ECC root) — project structure, command list, dev notes
30. `agents/planner.md` — full read (Implementation Plan template, sizing/phasing)
31. `agents/architect.md` — head (System design, trade-off analysis)
32. `agents/code-reviewer.md` — head (Confidence-based filtering, pre-report gate)
33. `agents/security-reviewer.md` — head (OWASP Top 10, npm audit workflow)
34. `agents/tdd-guide.md` — head (RED→GREEN→IMPROVE workflow)
35. `agents/loop-operator.md` — head (autonomous loops + stop conditions)
36. `skills/nestjs-patterns/SKILL.md` — head (exactly for our stack, a format reference)
37. `hooks/hooks.json` — root structure (Node.js bootstrapping, matcher-based, IDs)
38. `the-shortform-guide.md` — head (author voice + skills-vs-commands narrative)
39. `CHANGELOG.md` — head (1.9 → 1.10 → 2.0-rc.1 evolution)

### Author context (1 item)

40. `gh api users/affaan-m` — Affaan Mustafa, Itô Markets (prediction markets), ECC + ECC-Tools, blog `affaanmustafa.com`, 6.6k followers, 27 repos. Confirmed serious AI engineering profile (Anthropic × Forum Ventures hackathon winner with zenith.chat).

**Not read (intentionally):** the-longform-guide.md, the-security-guide.md, README.md (83 KB), README.zh-CN.md, 200+ remaining skills, agents, commands, rules. **Rationale:** token budget per the architect.md instruction "do not try to inventory all 247 skills".

---

## ECC version target recommendation

**Recommended: pin v2.0.0-rc.1 (the current rc) with monitoring of the CHANGELOG for GA.**

| Criterion                     | v1.10.0 (last stable)                      | v2.0.0-rc.1 (current rc)                                                         |
| ----------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| Stability                     | Production-stable, 1764/1764 tests passing | RC1, active development of the ECC 2.0 control-plane                             |
| Catalog                       | 38 agents / 156 skills / 72 commands       | 63 agents / 249 skills / 79 commands                                             |
| Cross-harness                 | Claude Code + Codex + OpenCode             | Claude Code + Codex + Cursor + OpenCode + Gemini + Hermes operator surface       |
| Hermes operator skills        | Was not present                            | Sanitized import skill surface (our use case — multi-agent orchestration aligns) |
| Hooks complexity              | Simpler matchers                           | Plugin bootstrapping + governance capture + GateGuard fact-force                 |
| ECC 2.0 alpha (control-plane) | Was not present                            | Present in-tree but still alpha — do NOT rely on ecc2/ for our migration         |

**Justification HIGH confidence:**

- 2.0-rc.1 gives us `harness-optimizer`, `code-architect`, `code-explorer`, `code-simplifier`, `conversation-analyzer` — directly relevant to the multi-agent orchestration improvement we are doing
- the `loop-operator` agent solves our D1 (cross-session waits) at a conceptual level
- `nestjs-patterns` + `react-patterns` + `react-testing` skills exist in both — our stack is covered already on 1.10.0, but 2.0-rc.1 gives a shipped surface
- the CHANGELOG 1.10 → 2.0-rc.1 shows velocity (1.10 was 2026-04-05, 2.0-rc.1 was 2026-04-28 — 23 days) — the author actively ships
- Risk: rc1 ≠ GA. If in Phase 1 (skeleton install) we see blocking issues — fall back to the v1.10.0 pin without loss of work (the developer profile is present in both versions)

**Decision criteria for a fallback:** if `node scripts/install-plan.js --profile developer` fails or generates a broken layout — switch to the v1.10.0 pin.

---

## Install profile fit

**Recommended: a `developer` profile base + selective additions from `security` and `research`.**

**Justification HIGH:**

Per REPO-ASSESSMENT.md, the `developer` profile = "default engineering profile for most ECC users, general software development across app codebases". This precisely describes our CRM project.

The `developer` profile contains (in aggregate with the base `core`):

- rules-core + agents-core + commands-core + hooks-runtime + platform-configs + workflow-quality (from `core`)
- framework-language skills (NestJS, React, TypeScript reviewers — our stack)
- database patterns (PostgreSQL + Drizzle — our stack)
- orchestration commands (relevant — we are doing multi-agent ordering)

**Selective additions from `security`:**

- the `security-reviewer` agent — needed for finance / auth / passport-S3 flows (our Legal Mode B zone)
- `secrets-detection` rules — we already have the hook `safety.sh`, but ECC's coverage is wider
- the `defi-amm-security` skill — relevant for the Phase 8 USDT smart contracts (even if not immediate)
- the `evm-token-decimals` skill — relevant for USDT ERC-20

**Selective additions from `research`:**

- No immediate need. Can be skipped in the Phase 0 ADR, added later if the User does competitive analysis or market research through the CRM context.

**What we do NOT take from `full`:**

- 60+ language reviewers (Rust, Go, Java, Kotlin, C++, etc.) — irrelevant to our TS/React/Node stack
- Content/marketing skills (`brand-voice`, `content-engine`, `crosspost`, `investor-outreach`) — out of scope for a CRM project
- ML/AI skills (`pytorch-build-resolver`, `mle-reviewer`) — out of scope
- Operator workflow skills (`customer-billing-ops`, `messages-ops`, `email-ops`) — partially relevant but require a real connector configuration, premature

**Confidence MED for the selective additions:** the list will be clarified in the Phase 0 ADR after a detailed mapping of current agents → ECC.

---

## Understanding of the ECC philosophy (4 sentences)

1. **Agent-first orchestration with radical specialization.** ECC ships 63 narrow agents (one per language/framework/concern) instead of 6 broad agents because Affaan Mustafa, over 10 months of daily use of Claude Code, saw: monolithic agents lose context on complex tasks, narrow agents with tight tool allowlists and model-fit (opus/sonnet/haiku) work better in parallel and are cheaper in aggregate.

2. **Skills-first workflow surface, commands legacy compatibility.** WORKING-CONTEXT explicitly: "skills/ — canonical workflow surface, commands/ — legacy slash-entry compatibility during migration". Knowledge modules in `skills/<name>/SKILL.md` with YAML frontmatter (`origin: ECC` vs `community`) — the primary durable unit, slash-commands only thin shims when needed for cross-harness parity.

3. **Hooks as enforcement, not aspiration.** From our project's dev-flow-rca the lesson "a textual rule in .md without a mechanism = aspiration" coincides with the ECC approach: hooks.json — serious machinery (a PreToolUse safety scanner, doc-file-warning, suggest-compact, GateGuard fact-force, governance-capture, config-protection, mcp-health-check). Hooks with specific matchers + plugin bootstrapping — not shell scripts but Node.js infrastructure with stable IDs for reinstall idempotency.

4. **Cross-harness portability + the ECC 2.0 control-plane as a long-term substrate.** SOUL.md "Cross-Harness Vision — initial portability layer for ECC's shared identity, governance, and skill catalog". Native agents/commands/hooks remain authoritative in the repo, the manifests `agent.yaml` + `manifests/` + the plugin layer (`.codex-plugin`, `.codex`, `.cursor`, `.gemini`, `.opencode`, `.zed`) — for portability. ECC 2.0 (the alpha Rust control-plane `ecc2/` + the `ecc-tui` CLI) — a future state, **NOT for us in Phase 1-6**.

---

## Critical deltas vs current (top 5 in impact order)

### 1. Catalog scale: 6 → 63 agents, 0 → 249 skills (P0)

Our current setup is closer to ECC's pre-1.9 "minimal install" pattern (see EVALUATION.md "0 agents installed"). We have 6 monolithic agents (PM/Coder/AutoTest/Reviewer/DevOps/Legal). ECC v2.0-rc.1 = 63 specialized. Implication:

- `coder.md` → split into `tdd-guide` + `typescript-reviewer` + a (custom) frontend specialist
- `reviewer.md` → split into `code-reviewer` + `security-reviewer` (two narrow roles)
- `devops.md` → ECC `build-error-resolver` + `harness-optimizer` + a custom GHA layer
- the 24 lessons in `memory/legal/lessons.md` → mapped onto 4-6 ECC skills (`skills/ua-tax-compliance/`, `skills/ua-cfc-rules/`, etc.) per the Phase 4 mapping in architect.md

### 2. Skills as knowledge primitives, not lessons.md (P0)

Currently knowledge lives in free-text `docs/agents/memory/<role>/lessons.md` (an append-log, max 30 lines, rotation into archive). ECC handles the same through `skills/<topic>/SKILL.md` discrete files with frontmatter (`name`, `description`, `origin`) and structured sections ("When to Use", "Workflow", "Tested examples"). Implication:

- Read-side queryability is greater (Claude sees the skill metadata, can decide when to activate)
- Write-side cost is greater (one line of a lesson vs a new SKILL.md file)
- **lessons.md continues as an append-log** in the Phase 4 plan — but the primary surface becomes skills/
- The custom rich legal lessons (24 lines about UA tax) — excellently mappable onto 3-5 specialized UA legal skills

### 3. Hooks: shell scripts → JSON matcher with a Node.js plugin bootstrap (P1)

Our `.claude/settings.json` uses a simple matcher (`"matcher": "Bash"`) + a path to a bash script. ECC v2.0-rc.1 `hooks/hooks.json` uses matcher-style typing (`"matcher": "Bash"` too but with a specific filter) + a Node.js plugin bootstrap for cross-harness installation portability + stable IDs (`id: "pre:bash:dispatcher"`) for an idempotent reinstall. Implication:

- Not a "rip-and-replace" of our 5 .sh hooks — they work. The Phase 2 migration = a rewrite into Node.js JS hooks through the ECC plugin layer
- `safety.sh` → ECC `pre:bash:dispatcher` already covers (force push to main/master, rm -rf — common patterns)
- `block-production-edits.sh` → unique to us (Coder zone enforcement), keep custom but in the ECC JSON format
- `coder-pre-push.sh` → unique (the ac_verified policy), keep custom
- `coder-progress-marker.sh` → there is an ECC `continuous-learning observer` (PreToolUse \*, captures tool use patterns) — may replace it
- `eslint-feedback.sh` → ECC `pre:edit-write:config-protection` + native eslint integration

### 4. PM Mode 1-5 orchestrator — no direct ECC equivalent (P1)

PM "a multidimensional orchestrator" (foreground+background dispatch, pm-state.json schema v2 with events[], User Testing tunnel management through Serveo, Legal 4 modes integration, ScheduleWakeup Layer 1/2 cross-session waits, a review_rounds circuit breaker, pending_fixes batch) — this is custom code specific to our product development. ECC `planner` + `loop-operator` + `harness-optimizer` give parts (planning, autonomous loops, harness config), but **the PM orchestration logic = unique to us**. Implication:

- Keep PM as a project-specific orchestrator
- Port it into the ECC agent format (YAML frontmatter, tool allowlist, model selection)
- Decompose where possible: planning → `planner`, dispatching → custom PM, state management → custom
- Phase 3 (migrate agents) — the most complex for PM specifically

### 5. Russian language + the UA legal/business context — a required exception (P0)

ECC is primarily English. All our agents are strictly in Russian (the rule from CLAUDE.md "All agents communicate with the user exclusively in Russian"). The Legal agent — deep UA tax/contract/GDPR knowledge. Implication:

- ECC agent prompts are ported but **the Russian language is added to each ported agent** (override "Always respond in English" if present)
- The Legal agent — **fully custom** (no ECC equivalent for UA-specific compliance). The knowledge base `docs/legal/` is preserved, lessons.md → UA-specific ECC skills (`skills/ua-tax-compliance/`, etc.)
- `docs/business/` is preserved (the BA zone) — no ECC equivalent for product business docs
- In the adaptation we carry out an explicit analysis: which ECC patterns we override without a loss of intent (e.g., RULES.md "Use English" → "Respond in Russian, comments in English in code")

---

## Top 3 migration risks

### Risk 1 — Active product work disruption (HIGH probability, CRITICAL severity)

**Description:** PM dispatches Coder/Reviewer/AutoTest/Legal daily. If the migration breaks the workflow (for example, the `agents/` ECC directory conflicts with the existing `docs/agents/`), the pipeline will stall.

**Mitigation:**

- Phase 1 — a coexistence layer. The new `agents/` (the ECC location) + the old `docs/agents/` (current) live in parallel. PM continues to dispatch the old ones until Phase 3 validation.
- Each Phase 1-6 PR — a separate branch + an explicit rollback section
- A User approval gate before each phase entry
- If even one phase breaks something — STOP, revert, RCA, propose an adjusted phase
- Do NOT touch `apps/**`, `packages/**` (the Coder zone) at all during the migration — this is the hardest invariant

### Risk 2 — Knowledge loss during the lessons → skills conversion (MED probability, HIGH severity)

**Description:** 46 lessons in `memory/legal/lessons.md` — 24 are P0-rich UA tax/CFC/crypto-regulation insights accumulated in 1 day (2026-05-31). The conversion into the SKILL.md format may lose nuance (a lesson line has a topic-tag + a priority + one meaning, SKILL.md requires "When to Use" + "Workflow" + "Examples" sections — some lessons are too atomic for a full skill).

**Mitigation:**

- Phase 4 — do NOT delete the original lessons.md. The conversion adds a skill, lessons.md continues as an append-log
- Group atomic lessons by topic BEFORE the conversion (5-10 lines → one SKILL.md). Not one-to-one
- A User review of each skill before commit (the Phase 4 user gate)
- If a group does not fit the SKILL.md format — keep it as a lesson, document why in the skill index README

### Risk 3 — ECC version pin drift (MED probability, MED severity)

**Description:** Pin v2.0.0-rc.1 for the migration period. ECC ships weekly (per the author profile + the WORKING-CONTEXT recent edits). By the time Phase 6 is complete (~6-8 weeks) the main ECC may be v2.1+ with new agents/skills that we missed.

**Mitigation:**

- After Phase 6 is complete — a quarterly upstream sync through a separate Architect dispatch (per architect.md "Upstream update policy")
- Hot fixes from ECC (security patches) — cherry-pick by event, not a planned sync
- The Phase 0 ADR documents the pinned ECC commit SHA (not just a tag) — reproducibility
- A lock file: `ecc-pin.txt` in the repo root with the pinned version + SHA + the adoption date — for a future sync diff

---

## What to preserve as-is from ECC (without customization)

### 1. The agent format (YAML frontmatter + the Prompt Defense Baseline)

```yaml
---
name: <name>
description: <when invoked>
tools: ['Read', 'Edit', 'Bash', 'Grep']
model: opus | sonnet | haiku
---
```

Plus ECC's "Prompt Defense Baseline" — 6 lines about prompt injection protection in each agent. This is the author's distillation from 10 months of daily use vs real-world attacks. **We do not try to improve it.** HIGH confidence.

### 2. The skill format (`skills/<name>/SKILL.md` with structured sections)

```yaml
---
name: <name>
description: <auto-activation cue>
origin: ECC | community | custom
---
# Title

## When to Activate
## Workflow
## Tested examples
```

Currently our "skills" = lessons.md (free text). The ECC format = structured. Adopting as-is. HIGH confidence.

### 3. The hook JSON matcher syntax + the plugin bootstrap pattern

`hooks/hooks.json` with specific matchers + stable IDs + a Node.js bootstrap for cross-harness install portability. Our shell hooks work but are not portable. Adopting the ECC pattern. HIGH confidence.

### 4. The 5 Core Principles (Agent-First / Test-Driven / Security-First / Immutability / Plan Before Execute)

SOUL.md. Coincides with our current practice (especially TDD via `superpowers:test-driven-development`, already used by the Coder). Adopting verbatim as our project's `SOUL.md`. HIGH confidence.

### 5. Confidence-based filtering (the code-reviewer + security-reviewer pre-report gate)

ECC `code-reviewer.md` has an explicit "Pre-Report Gate" — "Can I cite the exact line? Can I describe the failure mode? Have I read the surrounding context?". This DIRECTLY coincides with our reviewer.md Verdict policy + the Confidence policy from legal.md. ECC has already formalized it — adopt. HIGH confidence.

---

## What justifiably requires local adaptation

### 1. Russian language in all agent prompts (justification: a hard project requirement)

CLAUDE.md "All agents communicate with the user exclusively in Russian. No Ukrainian". ECC's "Always respond in English" (if present in some agent) — override. Adaptation pattern:

- Strip the English language directive
- Add "**IMPORTANT: Always respond in Russian.**" at the start of the agent role section
- Code comments — keep English (international team future-proof)
- Lessons.md / docs/business/ — Russian
- Git commit messages — English (conventional commits)

### 2. PM Mode 1-5 + pm-state.json schema v2 (justification: a unique product workflow)

ECC `planner` + `loop-operator` give conceptual primitives but **our PM = an orchestrator with specific business logic** (User Testing tunnel through Serveo, Dev Login button injection, Legal Mode A/B/C/D integration, a review_rounds circuit breaker, a pending_fixes batch flow). Adaptation:

- Keep PM as a custom agent in the ECC format (YAML frontmatter + tool allowlist + model: opus)
- Adopt ECC `planner` for planning sub-tasks within the PM workflow
- `loop-operator` patterns may inspire the pm-state.json events catch-up logic
- pm-state.json schema v2 — preserved as-is. ECC has no state management primitive — this is unique to us

### 3. The UA Legal knowledge base (justification: jurisdictional specificity)

The `docs/legal/` directory + 46 legal lessons — deeply UA-specific (FOP regimes, Tax Code of Ukraine articles, Law 2074-IX on virtual assets, the NBU Memorandum banking caps, CFC rules art. 39² of the Tax Code). There is no ECC equivalent. Adaptation:

- Keep the `docs/legal/` structure as-is (the knowledge base zone — User/PM maintenance)
- The Phase 4 lessons → skills conversion: we create NEW ECC skills `skills/ua-tax-compliance/`, `skills/ua-cfc-rules/`, `skills/ua-crypto-regulation/`, `skills/ua-banking-caps/`, `skills/legal-escalation-patterns/`. All `origin: custom` in the frontmatter.
- The Legal agent remains custom (no ECC equivalent for a jurisdictional legal advisor with a 4-mode dispatch)

---

## Recommendation for the Phase 0 entry

**PROCEED Phase 0** — drafting the master ADR (an EVALUATION.md-inspired format).

Discovery is complete, there are no blockers. The ECC repo is accessible via `gh api`, all 31 mandatory files are read or covered by samples representative for a format reference.

**Phase 0 deliverable preview (for approval before drafting):**

The `docs/architecture/2026-XX-XX-ecc-migration-design.md` master ADR (estimated 800-1500 lines) contains:

1. **Inventory table** (EVALUATION.md style) — current vs ECC v2.0-rc.1 for each component (agents, skills, commands, hooks, rules, MCP configs, install profile)
2. **Per-component mapping** — each of the 6 current agents → an ECC equivalent OR keep custom OR redundant remove. Each of the 5 hooks. Each of the 46 lessons (grouped by topic). Each GHA workflow.
3. **Install profile selection** with justified additions from security (for PHASE 8 USDT) and research (opt.)
4. **Identified gaps** where ECC does not cover — an explicit list (Russian language, UA legal, PM custom orchestration, GHA-specific workflows, pm-state.json schema)
5. **Risk matrix** per phase × risk type
6. **Phase plan 1-6** with timing + AC + a rollback strategy + ECC reference patterns
7. **ECC version pin** with a commit SHA reference + an upstream sync policy
8. **Confidence breakdown** per major decision

**Estimated time for the Phase 0 ADR:** 1 dispatched session (~2-3 hours of the architect in interactive mode). A User approval gate before the Phase 1 start.

**Before proceeding — potential user clarification questions (optional, optionally raised before Phase 0):**

1. Who is the User for the approval gates? The project owner (yaremenkomaksym99@gmail.com) or a team member? The Phase 0 ADR awaits approval before Phase 1.
2. Are we sure that in Phase 1-6 we do NOT replace the product daily workflow? PM continues dispatching the Coder for PHASE 6 (documents), in parallel with the migration. Confirm: parallel tracks OK.
3. Timeline expectation? Per architect.md "each phase ≤ 1 week" + 6 phases = 6 weeks minimum. Plus discovery + the ADR review = ~8 weeks total. OK or do we need to compress (with tradeoffs)?
4. Cross-harness scope? Phase 0-6 = Claude Code only. Phase 7+ optionally expands to Codex/Cursor. Confirm the initial scope.

If the user signals "proceed Phase 0" without a clarification — I proceed to the ADR draft with reasonable defaults (parallel tracks, 6-8 weeks, Claude Code only initially).

---

## Confidence breakdown per sub-decision

| Decision                                                   | Confidence | Rationale                                                                                                                                                |
| ---------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin v2.0.0-rc.1 (vs 1.10.0)                                | HIGH       | 2.0-rc.1 ships agents directly relevant to our multi-agent orchestration; the fallback path to 1.10.0 is cheap                                           |
| Install profile = `developer` base                         | HIGH       | REPO-ASSESSMENT.md explicit recommendation for our profile                                                                                               |
| Selective additions: security (USDT phase), research (opt) | MED        | Security clear, research future-deferred                                                                                                                 |
| Preserve PM as a custom orchestrator                       | HIGH       | No ECC equivalent for daily product workflow management                                                                                                  |
| Preserve Legal as a custom agent                           | HIGH       | UA jurisdictional specificity — no ECC equivalent                                                                                                        |
| Adopt the agent YAML frontmatter format                    | HIGH       | Standard, well-documented, tested in ECC                                                                                                                 |
| Adopt the skill SKILL.md format                            | HIGH       | Same — adopt as-is                                                                                                                                       |
| Adopt the hooks.json matcher format with a node bootstrap  | MED        | More complex than the current shell hooks; a POC is needed in Phase 2 that our custom hooks (coder-pre-push, block-production-edits) work in this format |
| Russian language adaptation                                | HIGH       | A hard project requirement; a clear adaptation pattern                                                                                                   |
| Lessons → skills conversion (Phase 4)                      | MED        | A risk of losing nuance; mitigation via a User review of each skill                                                                                      |
| Cross-harness Phase 7+ defer                               | HIGH       | Out of the immediate scope per the architect.md anti-scope                                                                                               |
| 6-week timeline estimate                                   | MED        | Depends on the user availability for the approval gates; may stretch out                                                                                 |

---

**End of the Discovery Report. Awaiting a User signal for the Phase 0 ADR drafting.**
