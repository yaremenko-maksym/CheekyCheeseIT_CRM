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

| Trigger                                                              | Skill                                        | Agents                               |
| -------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| Сессия начинается (любая)                                            | `superpowers:using-superpowers`              | All                                  |
| Любая creative задача (фича / UI / behavior change)                  | `superpowers:brainstorming`                  | BA, PM, Coder                        |
| Multi-step task — перед implementation                               | `superpowers:writing-plans`                  | Coder, DevOps                        |
| Любая feature / fix — перед implementation                           | `superpowers:test-driven-development`        | Coder                                |
| Баг / test failure / unexpected behavior                             | `superpowers:systematic-debugging`           | All                                  |
| Перед PR / completion claim                                          | `superpowers:verification-before-completion` | Coder, AutoTest, DevOps              |
| PR трогает auth / finance / wallets / transactions / company-account | `security-review`                            | Coder, Reviewer                      |
| Начало каждого review                                                | `superpowers:requesting-code-review`         | Reviewer                             |
| Получение review feedback                                            | `superpowers:receiving-code-review`          | Coder                                |
| После написания кода (cleanup)                                       | `simplify`                                   | Coder                                |
| Новая страница / сложный UI component                                | `frontend-design:frontend-design`            | Coder                                |
| Пишешь / правишь текст, видимый клиенту или кандидату                | `copywriting`                                | Coder, ui-ux-designer, copy-reviewer |
| Need isolated workspace (parallel work)                              | `superpowers:using-git-worktrees`            | PM (Coder dispatch)                  |
| Implementation plan execution                                        | `superpowers:executing-plans`                | PM, Coder                            |
| Multi-task dispatch                                                  | `superpowers:dispatching-parallel-agents`    | PM                                   |
| Branch ready to merge (готовится PR)                                 | `superpowers:finishing-a-development-branch` | Coder, PM                            |
| Memory consolidation / dedup (после merged PR)                       | `anthropic-skills:consolidate-memory`        | PM                                   |

## Project-local skills (Phase 4 lift)

Project-local + импортированные skills под `.claude/skills/` (16 на диске; Phase 4 заложила 7):

| Skill                         | Trigger                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright-patterns`         | Coder / AutoTest пишут `.spec.ts` — strict-mode / Radix / retries / testids.                                                          |
| `code-review-discipline`      | Reviewer формулирует Verdict / postит review.                                                                                         |
| `dev-flow-resilience`         | Long-running ops / MCP > 5s / silent termination / cross-session waits.                                                               |
| `ua-tax-compliance`           | Legal mode A / B / C по теме ФОП / Дія Сіті / CFC / банковские caps.                                                                  |
| `ua-crypto-compliance`        | Legal mode A / B при упоминании USDT / VASP / AML.                                                                                    |
| `ua-it-contract`              | Legal mode A / B на IT contract review (SENIOR / клиент).                                                                             |
| `legal-escalation-patterns`   | Cross-cutting Legal escalation (когда вовлекать external lawyer).                                                                     |
| `claude-design-workflow`      | Оркестратор (Master / PM / ui-ux-designer) драйвит Claude Design для UI-задачи / handoff-артефакт (design-gate Tier 1/2).             |
| `pm-dispatching`              | PM диспатчит агента / запускает PR / CI / User Testing — загрузка `pm-snippets.md`. **(project-local)**                               |
| `accessibility`               | UI/UX Designer / Coder: WCAG 2.2 AA — ARIA / focus / contrast / target size. **(origin: ECC)**                                        |
| `design-system`               | UI/UX Designer Mode B / C: 10-dimension visual audit + AI-slop detection. **(origin: ECC)**                                           |
| `frontend-design-direction`   | UI/UX Designer Mode A: purpose / audience / tone / memorable detail. **(origin: community)**                                          |
| `make-interfaces-feel-better` | UI/UX Designer Mode D / Coder polish: concentric radius / tabular-nums / motion / hit areas. **(origin: community)**                  |
| `codebase-audit`              | Master / PM: read-only breadth-first аудит ≥3 независимых модулей (fan-out → synth). **(project-local, 2026-06-22)**                  |
| `security-review`             | security-reviewer (каждый dispatch) / Coder до написания endpoint'а на auth-finance-RBAC путях. **(project-local, 2026-07-28)**       |
| `copywriting`                 | Любой текст для клиента/кандидата: заголовки, CTA, микрокопия, вакансии. Мультиязычно en/uk/ru/es/pt. **(project-local, 2026-08-04)** |

Phase 4 заложила 7 (`playwright-patterns` … `legal-escalation-patterns`); далее добавлены/импортированы:
`pm-dispatching` (project-local snippet-loader), `claude-design-workflow` (2026-06-22) и 4 дизайн/a11y-скилла
(`accessibility`/`design-system` — origin ECC; `frontend-design-direction`/`make-interfaces-feel-better` —
origin community); `codebase-audit` (project-local, 2026-06-22 — read-only audit-fanout, см.
`orchestration-routing.md` Решение 2); `security-review` (project-local, 2026-07-28 — см. ниже).
**Итого 16 на диске** (`ls .claude/skills/`); таблица выше —
источник истины. Каждый — в `.claude/skills/<name>/SKILL.md`. Phase 4 deliverable: `docs/architecture/2026-06-03-phase4-deliverable.md`.

## Дрейф таблицы относительно установленных паков (проверять при обновлении плагинов)

**Инцидент 2026-07-28.** Таблица триггеров предписывала `superpowers:security-review`
и `superpowers:simplify`. Обоих скиллов **нет** в установленном `superpowers@6.0.3`
(пак несёт 14 других). То есть mandatory-триггер был невыполним ровно на тех PR
(finance / auth), которые он и должен защищать: `Skill` падал с «not found», а по
правилу выше это explicit failure — но по факту агенты просто продолжали без него.
Сломанные ссылки успели расползтись по 7 рабочим файлам (`RULES.md` + 4 агентских
дока + этот файл).

**Корневая причина:** таблица писалась в Phase 4 (2026-06-03) против тогдашнего
состава пака. Обновление upstream-пака молча инвалидирует строки — ничто не связывает
таблицу с тем, что реально лежит на диске.

**Как чинилось:** `superpowers:security-review` → project-local `security-review`
(проектная дельта поверх OWASP, паттерны подтверждены инцидентами #110 / #159-#161 / #164);
`superpowers:simplify` → безпрефиксный `simplify` (встроенный, существует).

**Проверка при каждом обновлении плагинов** (и вообще при правке этой таблицы):

```bash
# что реально несёт пак superpowers
ls "$(find ~/.claude/plugins -maxdepth 6 -type d -path '*superpowers*' -name skills | head -1)"
# что лежит project-local
ls .claude/skills/
# все ссылки на скиллы в рабочих файлах
grep -rn '`[a-z-]*:\?[a-z-]*`' .claude/rules/common/skills-invocation.md
```

Сверять построчно. Учитывать два подвоха:

1. **Скилл может существовать, но не подходить.** Встроенный `security-review`
   — это **slash-команда** `/security-review` (в исходнике Claude Code —
   `commands/security-review.ts`), а не bundled skill. Её промпт гоняет
   `git diff origin/HEAD...` и падает
   (`fatal: ambiguous argument 'origin/HEAD...'`) в агентском окружении, где
   `origin/HEAD` не настроен — проверено фактическим вызовом из субагента.
   **Коллизии имён нет:** slash-команды и `Skill(<name>)` — разные реестры
   инвокации, поэтому `Skill('security-review')` однозначно резолвится в наш
   project-local `.claude/skills/security-review/`. Для сравнения, `simplify`
   из строки таблицы — наоборот, настоящий bundled skill
   (`skills/bundled/simplify.ts`), поэтому на него ссылаться можно.
2. **CI это не поймает.** Раннеры не имеют `~/.claude/plugins` оператора, поэтому
   guard-скрипт (в духе `check-e2e-shard-coverage.py`) смог бы верифицировать только
   project-local ссылки, а не `<pak>:<skill>`. Отсюда — процедурная проверка, а не гейт.

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
