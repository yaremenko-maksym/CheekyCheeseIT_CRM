# Rule: Skills invocation policy (mandatory triggers)

**Status:** Always-on
**Applies to:** All agents (PM, BA, Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus ECC-imported agents)
**Source:** ECC AGENTS.upstream §"Workflow Surface Policy" (skills as canonical surface) + Phase 4 deliverable (skills lifted from lessons.md) + superpowers framework expectations.

---

## The rule

Если **trigger applies** — агент **обязан** вызвать skill через `Skill` tool, а не «помнить» pattern. Если skill отсутствует в окружении — `Skill` tool падает с ошибкой, это explicit failure (лучше silent skip).

В финальном отчёте — указать какие skills вызывал. PM проверяет.

## `when_to_use` дублируется в самих скиллах

Каждый `.claude/skills/<name>/SKILL.md` теперь несёт `when_to_use:` во frontmatter
(скиллифай-схема Anthropic: leak `skills/bundled/skillify.ts`). Это поле — отражение
таблицы ниже, чтобы skill-loader мог авто-инвоукать по trigger-фразам. **Источник истины —
таблица «Trigger → Skill mapping» в этом файле**; `when_to_use` в скиллах её зеркалит.
При изменении триггера правь ОБА: строку в таблице и `when_to_use` в скилле
(см. `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` D2).

## Trigger → Skill mapping

| Trigger                                                              | Skill                                        | Agents                  |
| -------------------------------------------------------------------- | -------------------------------------------- | ----------------------- |
| Сессия начинается (любая)                                            | `superpowers:using-superpowers`              | All                     |
| Любая creative задача (фича / UI / behavior change)                  | `superpowers:brainstorming`                  | BA, PM, Coder           |
| Multi-step task — перед implementation                               | `superpowers:writing-plans`                  | Coder, DevOps           |
| Любая feature / fix — перед implementation                           | `superpowers:test-driven-development`        | Coder                   |
| Баг / test failure / unexpected behavior                             | `superpowers:systematic-debugging`           | All                     |
| Перед PR / completion claim                                          | `superpowers:verification-before-completion` | Coder, AutoTest, DevOps |
| PR трогает auth / finance / wallets / transactions / smart-contracts | `superpowers:security-review`                | Coder, Reviewer         |
| Начало каждого review                                                | `superpowers:requesting-code-review`         | Reviewer                |
| Получение review feedback                                            | `superpowers:receiving-code-review`          | Coder                   |
| После написания кода (cleanup)                                       | `superpowers:simplify`                       | Coder                   |
| Новая страница / сложный UI component                                | `frontend-design:frontend-design`            | Coder                   |
| Need isolated workspace (parallel work)                              | `superpowers:using-git-worktrees`            | PM (Coder dispatch)     |
| Implementation plan execution                                        | `superpowers:executing-plans`                | PM, Coder               |
| Multi-task dispatch                                                  | `superpowers:dispatching-parallel-agents`    | PM                      |
| Branch ready to merge (готовится PR)                                 | `superpowers:finishing-a-development-branch` | Coder, PM               |
| Memory consolidation / dedup (после merged PR)                       | `anthropic-skills:consolidate-memory`        | PM                      |

## Project-local skills (Phase 4 lift)

Plus 7 project-local skills под `.claude/skills/` (Phase 4 deliverable):

| Skill                       | Trigger                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `playwright-patterns`       | Coder / AutoTest пишут `.spec.ts` — strict-mode / Radix / retries / testids. |
| `code-review-discipline`    | Reviewer формулирует Verdict / postит review.                                |
| `dev-flow-resilience`       | Long-running ops / MCP > 5s / silent termination / cross-session waits.      |
| `ua-tax-compliance`         | Legal mode A / B / C по теме ФОП / Дія Сіті / CFC / банковские caps.         |
| `ua-crypto-compliance`      | Legal mode A / B при упоминании USDT / VASP / AML.                           |
| `ua-it-contract`            | Legal mode A / B на IT contract review (SENIOR / клиент).                    |
| `legal-escalation-patterns` | Cross-cutting Legal escalation (когда вовлекать external lawyer).            |
| `claude-design-workflow`    | Оркестратор (Master / PM / ui-ux-designer) драйвит Claude Design для UI-задачи / handoff-артефакт (design-gate Tier 1/2). |

Phase 4 заложила 7; `claude-design-workflow` добавлен 2026-06-22 (Claude Design integration) — итого 8.
Все — в `.claude/skills/<name>/SKILL.md`. Phase 4 deliverable: `docs/architecture/2026-06-03-phase4-deliverable.md`.

## Workflow surface policy (ECC alignment)

Per ECC `AGENTS.upstream.md` §"Workflow Surface Policy":

> `skills/` is the canonical workflow surface. New workflow contributions should land in `skills/` first. `commands/` is a legacy slash-entry compatibility surface and should only be added or updated when a shim is still required for migration or cross-harness parity.

В нашем repo: `commands/` НЕ используется. Workflow знания живёт в:

1. `.claude/skills/<name>/SKILL.md` — invocable knowledge primitives.
2. `.claude/agents/<agent>.md` — per-agent workflow / golden rules / mandatory tables.
3. `.claude/rules/common/*.md` — cross-cutting standards (этот файл и соседи).

## Anti-patterns

- **Mandatory table в `<agent>.md` без актуального trigger** — skill становится "discoverable in theory" но never invoked. PM при review агентов проверяет: `grep skill-name .claude/agents/*.md`.
- **«Помнить» pattern вместо `Skill(name)`** — каждый skill content evolves; sessions без invocation работают со stale знанием.
- **Создать SKILL.md с < 3 substantive patterns** — Phase 4 deliverable отфильтровала 3 candidate skills как SKIP. Не создавай empty shells.

## Связанные правила

- `.claude/rules/common/mcp-first.md` — MCP catalog (некоторые skills используют MCP tools).
- `.claude/rules/common/zone-of-write.md` — какие skills доступны кому (per-agent invocation).

## Источники

- ECC `docs/architecture/ecc-reference/AGENTS.upstream.md` §"Workflow Surface Policy"
- Phase 4 deliverable: `docs/architecture/2026-06-03-phase4-deliverable.md`
- Phase 4 viability recon: `docs/architecture/2026-06-03-phase4-skills-viability.md`
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.4 (lessons → skills)
- Superpowers framework: `~/.claude/plugins/cache/claude-plugins-official/superpowers/`
