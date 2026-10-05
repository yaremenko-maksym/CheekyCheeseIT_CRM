# Phase 4 — Deliverable (Skills Migration, 2026-06-03)

**Goal of the Phase 4 ECC migration:** Lift substantive content from `docs/agents/memory/*/lessons.md` (6 files) + `docs/architecture/2026-05-23-dev-flow-rca.md` into **`.claude/skills/<name>/SKILL.md`** ECC knowledge primitives — the discovery surface for agents via Skill tool invocation.

**Source of the viability decisions:** `docs/architecture/2026-06-03-phase4-skills-viability.md`.

## Hidden principle of Phase 4

> **DO NOT MANUFACTURE empty shells.** If lessons.md is thin (<3 substantive lines), better no skill than an empty SKILL.md with no actionable content.

This contradicts the naive "create N skills per ADR §2.4" approach — the Phase 4 viability recon filtered 3 candidate skills (nestjs-patterns, react-patterns, react-testing) as **SKIP** due to insufficient substantive content.

## Inventory of the skills being created

| Skill                       | Path                                                | Substantive patterns lifted | Source                                                                                  |
| --------------------------- | --------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `playwright-patterns`       | `.claude/skills/playwright-patterns/SKILL.md`       | 9 patterns                  | `autotest/lessons.md` + `coder/lessons.md` (strict-mode, Radix, retries, testids, etc.) |
| `code-review-discipline`    | `.claude/skills/code-review-discipline/SKILL.md`    | 5 patterns (delta vs ECC)   | `reviewer/lessons.md` (Verdict:BLOCK, write-then-post, zone-violations)                 |
| `dev-flow-resilience`       | `.claude/skills/dev-flow-resilience/SKILL.md`       | 7 patterns (C1-D4)          | `2026-05-23-dev-flow-rca.md` + 4 lessons.md (chunking, sentinel, intent, etc.)          |
| `ua-tax-compliance`         | `.claude/skills/ua-tax-compliance/SKILL.md`         | 12 patterns                 | `legal/lessons.md` #ua-fop #tax (FOP/Diia City/CFC/banking)                             |
| `ua-crypto-compliance`      | `.claude/skills/ua-crypto-compliance/SKILL.md`      | 5 patterns                  | `legal/lessons.md` #usdt #aml (Law 2074-IX, 361-IX, hard refuse)                        |
| `ua-it-contract`            | `.claude/skills/ua-it-contract/SKILL.md`            | 6 patterns                  | `legal/lessons.md` #it-contract (SENIOR risks, GDPR, lawyer prep)                       |
| `legal-escalation-patterns` | `.claude/skills/legal-escalation-patterns/SKILL.md` | 7 patterns                  | `legal/lessons.md` #escalation + `pm/lessons.md` pm-side                                |
| **TOTAL Phase 4 created**   | **7 new skills** + 1 existing (`pm-dispatching`)    | **51 substantive patterns** | —                                                                                       |

## Inventory of SKIPPED candidates (with reasoning)

| Skill             | ADR §2.4 status | Phase 4 decision | Reasoning                                                                                                                             |
| ----------------- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `nestjs-patterns` | mentioned       | **SKIP**         | 0 substantive NestJS-specific lessons. Stack guidance already via context7 MCP + ECC `typescript-reviewer`. Reassess Phase 6+.        |
| `react-patterns`  | mentioned       | **SKIP**         | 1 substantive item (Tab+ArrowDown autocomplete). Covered by ECC `frontend-design` + `typescript-reviewer`. Reassess Phase 6+.        |
| `react-testing`   | mentioned       | **SKIP**         | 2 substantive items (delay:null + interaction tests autocomplete). Disparate, not a coherent pattern set. ECC `tdd-guide` already scaffolds. |

**Decision rule for the Phase 6 re-assessment:** When lessons.md accumulates ≥ 3 substantive items per candidate skill — reassess. Until then the lessons remain as an append-log.

## Skill discovery flow

**How an agent learns that a skill is relevant:**

1. **The description in frontmatter** (`description:` field) — the Skill tool matches by description.
2. **The mandatory skill table in `<agent>.md`** — explicit trigger → skill mapping.
3. **Cross-references in other skills** (`Related skills:` section).
4. **README.md skills section** (see §"Discovery via README" below).

**Mechanism:**

- An agent session sees the skill `description` automatically through the harness.
- The agent invokes `Skill(skill='<name>')` when the trigger condition is met (see the mandatory table).
- The skill content is loaded into context, the agent applies the patterns.

**Anti-pattern:** A mandatory table in `<agent>.md` without up-to-date trigger conditions — the skill becomes "discoverable in theory" but never invoked.

## Mandatory skill tables — diff summary

Per the per-agent diff in the Phase 4 commit `feat(architect): Phase 4 — mandatory skill tables update`:

| Agent                  | Added skill refs                                                                             | Removed / replaced                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `coder.md`             | + `playwright-patterns` (.spec.ts trigger) + `dev-flow-resilience` (long task / silent term) | Phase 4 status note about SKIPPED candidates instead of the "available after Phase 4" placeholder |
| `autotest.md`          | + `playwright-patterns` (replaced the "after Phase 4 stub") + `dev-flow-resilience`           | Frontmatter description updated, the "after Phase 4" references removed                  |
| `code-reviewer.md`     | + `code-review-discipline` (BLOCK / write-then-post / zone) + `dev-flow-resilience`          | —                                                                                       |
| `security-reviewer.md` | + `code-review-discipline` + `dev-flow-resilience`                                           | —                                                                                       |
| `legal.md`             | + 4 UA skills + `dev-flow-resilience`                                                        | —                                                                                       |
| `devops.md`            | + `dev-flow-resilience` (D2 labels + macOS shims + lsof)                                     | —                                                                                       |
| `pm.md`                | + `dev-flow-resilience` (D1 + recovery) + `legal-escalation-patterns`                        | —                                                                                       |

## Discovery via README

`docs/agents/README.md` already has a skills-section note in the "Where to turn for various questions" table ("Which skill to invoke? → `RULES.md` §3 + `<agent>.md`"). Phase 4.E (optional) — may add an explicit Skills directory pointer.

## Cross-skill dependency graph

```
                               ┌──────────────────────┐
                               │ dev-flow-resilience  │ ◄────── (used by all agents
                               │  (D1-D4 + C1-C3)     │           for resilience)
                               └──────────┬───────────┘
                                          │
                ┌─────────────────────────┼────────────────────────┐
                │                         │                        │
                ▼                         ▼                        ▼
   ┌────────────────────┐    ┌─────────────────────┐   ┌───────────────────────┐
   │ code-review-       │    │ playwright-patterns │   │ pm-dispatching        │
   │  discipline        │    │  (CRM cookbook)     │   │  (existing)           │
   │ (delta vs ECC)     │    │                     │   │                       │
   └────────┬───────────┘    └─────────────────────┘   └───────────────────────┘
            │
            └─── used by code-reviewer / security-reviewer

   ┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐
   │ ua-tax-compliance     │  │ ua-crypto-compliance  │  │ ua-it-contract        │
   └───────────┬───────────┘  └───────────┬───────────┘  └───────────┬───────────┘
               │                          │                          │
               └──────────────────────────┼──────────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────────┐
                              │ legal-escalation-patterns │
                              │  (cross-cutting + PM-side) │
                              └──────────────────────────┘
```

## What was done — sub-task summary

- **4.A Reconnaissance** ✅ — `docs/architecture/2026-06-03-phase4-skills-viability.md` created with a decision matrix.
- **4.B Skills creation** ✅ — 7 new SKILL.md files, 51 substantive patterns total.
- **4.C Agent docs update** ✅ — 7 agent .md files, mandatory skill tables updated with references.
- **4.D Deliverable** ✅ — this document.
- **4.E README** (optional) — updating `docs/agents/README.md` with a pointer to the `.claude/skills/` directory.

## What remains for Phase 5 (GHA integration)

**Phase 5 scope (per ADR § 2.3 + § 2.5):**

1. **Wakeup-scheduler skill stub** (`scripts/pm/pm-schedule.sh`) — document in `skills/cross-session-orchestration/SKILL.md`.
2. **User-testing tunnel skill** (`scripts/pm/prep-user-testing.sh`) — document in `skills/user-testing-tunnel/SKILL.md`.
3. **GHA archived workflows shim** (`ai-review.yml`, `coder.yml`, `autotest.yml`, `devops.yml`) — migrate the last references from docs/agents/\*\* to the new ECC-based workflows (ci.yml, e2e.yml, etc.).
4. **GHA labels.yml sync** — verify `.github/workflows/labels-sync.yml` works (sub-task `task-infra-labels-yml-sync.md`).

## What remains for Phase 6 (cleanup)

**Phase 6 scope:**

1. **Trim lessons.md** — after the lift, P2 entries older than 90 days can be trimmed into lessons.archive.md (per the existing rotation policy).
2. **Re-assess SKIPPED skills** — `nestjs-patterns`, `react-patterns`, `react-testing` — if lessons.md accumulates ≥ 3 substantive items, create them.
3. **Deprecate redirect stubs** — the `reviewer.md` / `CLAUDE-*.md` stubs are ready for removal.
4. **Memory rotation** — automate via PM dispatch + the consolidate-memory skill at the threshold > 20 lines.

## ECC compliance check

- `AGENTS.upstream.md` §"Workflow Surface Policy": "skills/ — canonical workflow surface. New workflow contributions should land in skills/ first." ✅ Phase 4 creates skills in `.claude/skills/<name>/SKILL.md` with YAML frontmatter (name + description).
- ECC upstream ships a `nestjs-patterns/`, `react-patterns/`, `react-testing/`, `playwright-patterns/` slot — we overrode only `playwright-patterns` (custom delta), leaving the rest upstream (SKIP per the viability recon).
- `pm-dispatching` remains local (project-specific, not ECC).
- The 6 new skills are all custom (project-specific knowledge not covered upstream).

## Verification — after push

- `find .claude/skills -name SKILL.md` should show **8 skills** (7 new + 1 existing `pm-dispatching`).
- `head -10 .claude/skills/<name>/SKILL.md` — each frontmatter valid (name + description ≥ 50 chars).
- `grep -E "playwright-patterns|code-review-discipline|dev-flow-resilience|ua-tax-compliance|ua-crypto-compliance|ua-it-contract|legal-escalation-patterns" docs/agents/*.md | wc -l` — ≥ 10 references in agent files.
- `git log origin/main..HEAD --oneline` — ≥ 12 commits on the rolling branch (6 from 3a-3e + 6 from Phase 4).
- `gh pr checks 94` — required checks green.

## Risk + mitigations

| Risk                                                         | Mitigation                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Agent does not find a relevant skill via `description` matching | The descriptions are written conversationally ("When ... is used ..."), with strict trigger conditions in when-to-invoke |
| Skill content drifts from the actual lessons.md              | lessons.md is preserved as a historical record; on a new lesson → PM updates both lessons.md + the relevant skill |
| The 4 UA skills overlap                                      | Cross-references in the `Related skills:` section, distinct trigger zones per skill                          |
| Mandatory tables in agent.md become outdated after a rename / move | The Phase 4 deliverable doc serves as source-of-truth, future updates via ADR + deliverable revision        |

## Files touched

**Created (new):**

- `docs/architecture/2026-06-03-phase4-skills-viability.md`
- `docs/architecture/2026-06-03-phase4-deliverable.md` (this file)
- `.claude/skills/playwright-patterns/SKILL.md`
- `.claude/skills/code-review-discipline/SKILL.md`
- `.claude/skills/dev-flow-resilience/SKILL.md`
- `.claude/skills/ua-tax-compliance/SKILL.md`
- `.claude/skills/ua-crypto-compliance/SKILL.md`
- `.claude/skills/ua-it-contract/SKILL.md`
- `.claude/skills/legal-escalation-patterns/SKILL.md`

**Modified (agent docs):**

- `docs/agents/coder.md` — mandatory skill table + Phase 4 status note
- `docs/agents/autotest.md` — playwright-patterns reference activated, dev-flow-resilience added, frontmatter
- `docs/agents/code-reviewer.md` — code-review-discipline + dev-flow-resilience
- `docs/agents/security-reviewer.md` — code-review-discipline + dev-flow-resilience
- `docs/agents/legal.md` — 4 UA skills + dev-flow-resilience
- `docs/agents/devops.md` — dev-flow-resilience
- `docs/agents/pm.md` — dev-flow-resilience + legal-escalation-patterns

**Optional (Phase 4.E):**

- `docs/agents/README.md` — skills section pointer

## References

- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.4
- Viability recon: `docs/architecture/2026-06-03-phase4-skills-viability.md`
- Source RCA: `docs/architecture/2026-05-23-dev-flow-rca.md`
- ECC upstream policy: `docs/architecture/ecc-reference/AGENTS.upstream.md` §"Workflow Surface Policy"
- Phase 3 prior work: `docs/architecture/2026-06-03-phase3{b,c,d,e}-deliverable.md`
