# Phase 4 — Deliverable (Skills Migration, 2026-06-03)

**Цель Phase 4 ECC-migration:** Лифтнуть substantive content из `docs/agents/memory/*/lessons.md` (6 файлов) + `docs/architecture/2026-05-23-dev-flow-rca.md` в **`.claude/skills/<name>/SKILL.md`** ECC-knowledge primitives — discovery surface для агентов через Skill tool invocation.

**Источник viability decisions:** `docs/architecture/2026-06-03-phase4-skills-viability.md`.

## Скрытый принцип Phase 4

> **DO NOT MANUFACTURE empty shells.** Если lessons.md тощий (<3 substantive строк), лучше нет skill чем pustoy SKILL.md без actionable content.

Это противоречит naive "create N skills per ADR §2.4" подходу — Phase 4 viability recon отфильтровала 3 candidate skills (nestjs-patterns, react-patterns, react-testing) как **SKIP** через insufficient substantive content.

## Inventory создаваемых skills

| Skill                       | Path                                                | Substantive patterns lifted | Source                                                                                  |
| --------------------------- | --------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `playwright-patterns`       | `.claude/skills/playwright-patterns/SKILL.md`       | 9 patterns                  | `autotest/lessons.md` + `coder/lessons.md` (strict-mode, Radix, retries, testids, etc.) |
| `code-review-discipline`    | `.claude/skills/code-review-discipline/SKILL.md`    | 5 patterns (delta vs ECC)   | `reviewer/lessons.md` (Verdict:BLOCK, write-then-post, zone-violations)                 |
| `dev-flow-resilience`       | `.claude/skills/dev-flow-resilience/SKILL.md`       | 7 patterns (C1-D4)          | `2026-05-23-dev-flow-rca.md` + 4 lessons.md (chunking, sentinel, intent, etc.)          |
| `ua-tax-compliance`         | `.claude/skills/ua-tax-compliance/SKILL.md`         | 12 patterns                 | `legal/lessons.md` #ua-fop #tax (ФОП/Дія Сіті/CFC/banking)                              |
| `ua-crypto-compliance`      | `.claude/skills/ua-crypto-compliance/SKILL.md`      | 5 patterns                  | `legal/lessons.md` #usdt #aml (Закон 2074-IX, 361-IX, hard refuse)                      |
| `ua-it-contract`            | `.claude/skills/ua-it-contract/SKILL.md`            | 6 patterns                  | `legal/lessons.md` #it-contract (SENIOR risks, GDPR, lawyer prep)                       |
| `legal-escalation-patterns` | `.claude/skills/legal-escalation-patterns/SKILL.md` | 7 patterns                  | `legal/lessons.md` #escalation + `pm/lessons.md` pm-side                                |
| **TOTAL Phase 4 created**   | **7 new skills** + 1 existing (`pm-dispatching`)    | **51 substantive patterns** | —                                                                                       |

## Inventory SKIPPED candidates (с reasoning)

| Skill             | ADR §2.4 status | Phase 4 decision | Reasoning                                                                                                                             |
| ----------------- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `nestjs-patterns` | mentioned       | **SKIP**         | 0 substantive NestJS-specific lessons. Stack guidance уже через context7 MCP + ECC `typescript-reviewer`. Reassess Phase 6+.          |
| `react-patterns`  | mentioned       | **SKIP**         | 1 substantive item (Tab+ArrowDown autocomplete). Перекрывается ECC `frontend-design` + `typescript-reviewer`. Reassess Phase 6+.      |
| `react-testing`   | mentioned       | **SKIP**         | 2 substantive items (delay:null + interaction tests autocomplete). Disparate, не coherent pattern set. ECC `tdd-guide` уже scaffolds. |

**Decision rule для Phase 6 re-assessment:** Когда lessons.md накопит ≥ 3 substantive items per candidate skill — переоценить. До тех пор lessons остаются как append-log.

## Skill discovery flow

**Как agent узнаёт что skill релевантна:**

1. **Описание в frontmatter** (`description:` field) — Skill tool матчит по описанию.
2. **Mandatory skill table в `<agent>.md`** — explicit trigger → skill mapping.
3. **Cross-references в other skills** (`Related skills:` section).
4. **README.md skills section** (см. ниже §"Discovery via README").

**Mechanism:**

- Agent сessии видит skill `description` automatically через harness.
- Agent инвоукает `Skill(skill='<name>')` когда trigger condition met (см. mandatory table).
- Skill content загружается в context, agent применяет patterns.

**Anti-pattern:** Mandatory table в `<agent>.md` без актуальных trigger conditions — skill становится "discoverable in theory" но never invoked.

## Mandatory skill tables — diff summary

Per agent diff в Phase 4 commit `feat(architect): Phase 4 — mandatory skill tables update`:

| Agent                  | Added skill refs                                                                             | Removed / replaced                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `coder.md`             | + `playwright-patterns` (.spec.ts trigger) + `dev-flow-resilience` (long task / silent term) | Phase 4 status note про SKIPPED candidates вместо "available after Phase 4" placeholder |
| `autotest.md`          | + `playwright-patterns` (заменил "after Phase 4 stub") + `dev-flow-resilience`               | Frontmatter description обновлён, references «after Phase 4» удалены                    |
| `code-reviewer.md`     | + `code-review-discipline` (BLOCK / write-then-post / zone) + `dev-flow-resilience`          | —                                                                                       |
| `security-reviewer.md` | + `code-review-discipline` + `dev-flow-resilience`                                           | —                                                                                       |
| `legal.md`             | + 4 UA skills + `dev-flow-resilience`                                                        | —                                                                                       |
| `devops.md`            | + `dev-flow-resilience` (D2 labels + macOS shims + lsof)                                     | —                                                                                       |
| `pm.md`                | + `dev-flow-resilience` (D1 + recovery) + `legal-escalation-patterns`                        | —                                                                                       |

## Discovery via README

`docs/agents/README.md` уже имеет skills-section примечание в "Куда обращаться при разных вопросах" таблице («Какие skill вызвать? → `RULES.md` §3 + `<agent>.md`»). Phase 4.E (опционально) — может добавить explicit Skills directory pointer.

## Cross-skill dependency graph

```
                               ┌──────────────────────┐
                               │ dev-flow-resilience  │ ◄────── (used by all agents
                               │  (D1-D4 + C1-C3)     │           для resilience)
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

## Что сделано — sub-task summary

- **4.A Reconnaissance** ✅ — `docs/architecture/2026-06-03-phase4-skills-viability.md` создан с decision matrix.
- **4.B Skills creation** ✅ — 7 new SKILL.md файлов, 51 substantive patterns total.
- **4.C Agent docs update** ✅ — 7 agent .md файлов mandatory skill tables обновлены с references.
- **4.D Deliverable** ✅ — этот документ.
- **4.E README** (опционально) — обновление `docs/agents/README.md` с pointer на `.claude/skills/` directory.

## Что осталось для Phase 5 (GHA integration)

**Phase 5 scope (per ADR § 2.3 + § 2.5):**

1. **Wakeup-scheduler skill stub** (`scripts/pm/pm-schedule.sh`) — задокументировать в `skills/cross-session-orchestration/SKILL.md`.
2. **User-testing tunnel skill** (`scripts/pm/prep-user-testing.sh`) — задокументировать в `skills/user-testing-tunnel/SKILL.md`.
3. **GHA archived workflows shim** (`ai-review.yml`, `coder.yml`, `autotest.yml`, `devops.yml`) — миграция последних references из docs/agents/\*\* на новые ECC-based workflows (ci.yml, e2e.yml, etc.).
4. **GHA labels.yml sync** — verify `.github/workflows/labels-sync.yml` working (sub-task `task-infra-labels-yml-sync.md`).

## Что осталось для Phase 6 (cleanup)

**Phase 6 scope:**

1. **Trim lessons.md** — после lift, можно trim P2 entries старше 90 дней в lessons.archive.md (per existing rotation policy).
2. **Re-assess SKIPPED skills** — `nestjs-patterns`, `react-patterns`, `react-testing` — если lessons.md накопит ≥ 3 substantive items, создать.
3. **Deprecate redirect stubs** — `reviewer.md` / `CLAUDE-*.md` стабы готовы к removal.
4. **Memory rotation** — automate via PM dispatch + consolidate-memory skill при threshold > 20 строк.

## ECC compliance check

- `AGENTS.upstream.md` §"Workflow Surface Policy": "skills/ — canonical workflow surface. New workflow contributions should land in skills/ first." ✅ Phase 4 создаёт skills в `.claude/skills/<name>/SKILL.md` со YAML frontmatter (name + description).
- ECC upstream ships `nestjs-patterns/`, `react-patterns/`, `react-testing/`, `playwright-patterns/` slot — мы overriden только `playwright-patterns` (custom delta), остальные оставляем upstream (SKIP per viability recon).
- `pm-dispatching` остаётся local (project-specific, не ECC).
- 6 new skills все custom (project-specific knowledge не покрыто upstream).

## Verification — после push

- `find .claude/skills -name SKILL.md` должен показать **8 skills** (7 new + 1 existing `pm-dispatching`).
- `head -10 .claude/skills/<name>/SKILL.md` — каждый frontmatter валиден (name + description ≥ 50 chars).
- `grep -E "playwright-patterns|code-review-discipline|dev-flow-resilience|ua-tax-compliance|ua-crypto-compliance|ua-it-contract|legal-escalation-patterns" docs/agents/*.md | wc -l` — ≥ 10 references в agent files.
- `git log origin/main..HEAD --oneline` — ≥ 12 commits на rolling branch (6 от 3a-3e + 6 от Phase 4).
- `gh pr checks 94` — required зелёные.

## Risk + mitigations

| Risk                                                         | Mitigation                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Agent не находит relevant skill через `description` matching | Описания написаны conversationally ("When ... используется ..."), strict trigger conditions в when-to-invoke |
| Skill content drifts от actual lessons.md                    | lessons.md preserved as historical record, при new lesson → PM updates both lessons.md + relevant skill      |
| 4 UA skills overlap                                          | Cross-references в `Related skills:` секции, distinct trigger zones per skill                                |
| Mandatory tables в agent.md outdated после rename / move     | Phase 4 deliverable doc служит source-of-truth, future updates через ADR + deliverable revision              |

## Файлы touched

**Created (новые):**

- `docs/architecture/2026-06-03-phase4-skills-viability.md`
- `docs/architecture/2026-06-03-phase4-deliverable.md` (этот файл)
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
