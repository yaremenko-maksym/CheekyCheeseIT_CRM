# task-multiagent-docs-architect

## Агент: ai-architect (general-purpose)

## Приоритет: medium

## Ветка: chore/multiagent-docs-refactor

## Зависит от: PR #75 (workflow improvements landed)

## Контекст

В проекте есть мульти-агентная инфраструктура (PM / Coder / AutoTest / Reviewer / DevOps / BA), которая управляется через .md файлы в `docs/agents/`. После 1.5 месяцев использования (5 phases drop role, ~13 PR) накопились проблемы:

### Наблюдаемые симптомы

1. **Token bloat**: `docs/agents/coder.md` ≈ 34KB, `pm.md` ≈ 23KB. Coder читает всё это в каждом dispatch → высокие токенные расходы, рассеянное внимание, важные rules «теряются» среди примеров.
2. **Rules silently ignored**: за сессию 2026-06-02 3 Coder-агента подряд использовали `git push --no-verify` хотя правило явно прописано. После PR #75 я добавил «§ Запрещённые паттерны» в начало CLAUDE-coder.md, но это патч поверх симптома.
3. **Duplication**: одно правило живёт в `CLAUDE-coder.md` + `coder.md` + `memory/coder/lessons.md` одновременно, иногда с расходящимися формулировками.
4. **CLAUDE-X.md vs X.md split**: непонятно когда использовать какой. Изначальная идея (короткий CLAUDE-X для system prompt, полный X для reference) не соблюдается.
5. **Memory rot**: `lessons.md` растёт линейно. После 50+ записей агент перестаёт их читать. Нет ротации / consolidate механизма.
6. **No golden rules**: критичные правила (no --no-verify, proof of push, no fake verification) не выделены — соседствуют с косметическими (используй MCP first).
7. **Cross-agent contracts**: не формализовано когда PM диспатчит Reviewer, когда Coder может попросить PM clarification, какие labels кто ставит.
8. **Session-boundary recovery**: ScheduleWakeup не выживает session boundary, но это упоминается только в одном месте (CLAUDE-pm.md D1). Нет общей session-recovery архитектуры.
9. **Skills hierarchy не интегрирована**: `superpowers:*` skills (brainstorming, verification-before-completion, executing-plans) — мощный механизм, но в agent docs упомянуты эпизодически.
10. **No deprecation tracking**: правила добавляются, но никогда не удаляются. Старые правила про Phase 1 финансов всё ещё в pm.md, хотя не применимы.

### Реальные инциденты сессии 2026-06-02

| Инцидент                                  | Где это должно было предотвратиться                            |
| ----------------------------------------- | -------------------------------------------------------------- |
| 3× `git push --no-verify`                 | Top-of-CLAUDE-coder + lessons + CI hook (только что добавили)  |
| 2× mid-task termination без proof of push | Coder doc «финальный отчёт» (только что добавили)              |
| 1× «pre-existing flake» rationalization   | Coder doc «pre-existing flake без proof» (только что добавили) |
| PDF без visual verify                     | PM doc + Coder doc (visual artifact protocol)                  |
| 4× refactor same file                     | PM doc churn detector                                          |
| ScheduleWakeup на done work               | PM cleanup discipline                                          |

Мои патчи в PR #75 — это локальные fix'ы. Нужна **системная переработка**.

## Цель

Полная рефакторизация .md инфраструктуры multi-agent под:

- **Token efficiency**: критичные rules должны быть наверху, ≤ 200 строк top-of-file. Detail reference выносится в отдельные файлы.
- **Unmissable golden rules**: 5-7 zero-tolerance правил в начале каждого agent doc.
- **No duplication**: каждое правило живёт **в одном месте** (single source of truth).
- **Self-enforcing**: где возможно — CI hooks / skill invocations / system prompt rules вместо «надейся что прочитал».
- **Lessons rotation**: lessons.md → консолидируется в правила при достижении threshold, старые записи архивируются.
- **Cross-agent contracts**: явные диаграммы / state-machines кто кому что когда.
- **Skill-first**: top-level правило — какие superpowers skills обязательны в каких сценариях.
- **Session-boundary resilient**: чёткая sub-section в каждом doc «что делать после compaction».

## Acceptance Criteria

### AC1. Audit phase

- [ ] Снять inventory всех .md файлов в `docs/agents/` + `CLAUDE.md` + `docs/agents/memory/*/lessons.md`. Размер, last-modified, content overview.
- [ ] Через ast-grep MCP найти все cross-references между .md (где docs ссылаются друг на друга).
- [ ] Снять метрики дублирования: какие правила появляются > 1 раза (по keywords).
- [ ] Зафиксировать в `docs/agents/architect-audit.md` — таблица «правило / места появления / противоречия».

### AC2. Design phase

Создать `docs/agents/architecture-v2.md` (или равнозначный) с предложением:

- [ ] Структура каждого agent-doc (golden rules → workflow → reference → examples → recovery).
- [ ] Решение вопроса CLAUDE-X.md vs X.md (мерж / удаление / уточнение ролей).
- [ ] Скилл-first паттерн (mandatory skill invocation table).
- [ ] Lessons rotation policy (когда consolidate в rules, когда archive).
- [ ] Cross-agent contracts (диаграмма / state-machine).
- [ ] Session-recovery protocol — sub-section с required state в каждом doc.
- [ ] Token budget per doc.
- [ ] **Получить approval от user** (создать draft PR с одним только design doc — НЕ применять изменения без подтверждения).

### AC3. Implementation phase (после approval)

- [ ] Применить новую структуру ко **всем** agent-docs.
- [ ] Удалить дубликаты, оставив single source of truth.
- [ ] Добавить golden-rules секции наверх каждого doc.
- [ ] Архивировать устаревшие правила в `docs/agents/archive/`.
- [ ] Создать (или обновить) cross-agent contract diagram — `docs/agents/contracts.md`.
- [ ] Обновить `CLAUDE.md` если нужно — top-level pointer к новой структуре.
- [ ] Обновить promptы агентов (в .github/workflows/\*.yml где запускаются Coder/Reviewer/AutoTest) на новые paths/snippets если меняются.

### AC4. Migration safety

- [ ] До применения изменений — Coder/PM **должны быть способны прочитать старый формат** (нельзя в один PR поменять всё чтобы next dispatch agent не упал).
- [ ] Если есть staged migration — описать в design doc.
- [ ] Backup старых файлов (через git history; не нужен отдельный backup).

### AC5. Self-test

- [ ] После применения — dispatch одного **тестового** Coder агента на trivial task. Verify что он:
  - Прочитал новые docs.
  - Соблюдает golden rules.
  - Не пытается обойти hooks.
- [ ] Если тестовый Coder fails — пересмотреть design.

### AC6. Documentation

- [ ] `docs/agents/README.md` — обновить как entry point. Новая структура.
- [ ] `docs/agents/CHANGES.md` (новый) — migration log что изменилось, когда, почему.

### AC7. Локально

```bash
# Не должно быть кодовых изменений в apps/**, только docs/agents/** + CLAUDE.md
pnpm typecheck
pnpm lint
pnpm test
```

Все зелёные (хотя ничего не должно сломаться — изменения только в docs).

### AC8. PR

- [ ] Phase 1 PR: только audit + design doc, заголовок `chore(agents): аудит + предложение архитектуры v2`. Ждать user approval.
- [ ] Phase 2 PR: implementation, после approval. Заголовок `refactor(agents): мульти-агент docs v2 — golden rules, no duplication, lessons rotation`.

## Что НЕ нужно

- Менять код агентов в `.github/workflows/coder.yml`/etc. кроме paths.
- Менять `apps/**` — это только docs refactor.
- Удалять lessons / memory без архивации.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`

---

## Промпт для AI Architect agent

```
Ты — AI Architect, специализирующийся на multi-agent infrastructure и Claude-based developer workflows. Тебе нужно провести системную refactor'ку .md инфраструктуры multi-agent setup в репо yaremenko-maksym/CheekyCheeseIT_CRM.

Контекст и задача — docs/specs/tasks/task-multiagent-docs-architect.md.

Жизненно важные предварительные шаги:
1. Прочитай docs/agents/coder.md, CLAUDE-coder.md, pm.md, CLAUDE-pm.md, reviewer.md, CLAUDE-reviewer.md (и аналогичные для autotest, devops, ba). Это ≈ 200KB текста — структурируй чтение.
2. Прочитай docs/agents/memory/*/lessons.md.
3. Прочитай CLAUDE.md в корне.
4. Прочитай docs/agents/README.md (если есть).
5. Прочитай docs/agents/CHANGES.md или CHANGELOG (если есть).
6. Через ast-grep MCP найди все cross-references между .md файлами.

Принципы рефакторинга (НЕ выбирать произвольно — следовать им как ограничениям):

A. **Token efficiency over completeness**. Лучше короткий doc + ссылка на reference, чем 30KB stuffed file. Top-of-file ≤ 200 строк критичной информации.

B. **Golden rules unmissable**. 5-7 zero-tolerance правил наверху каждого agent doc. Формат:
```

## 🔴 Golden rules (zero tolerance)

1.  NEVER `git push --no-verify` ...
2.  NEVER claim "verified" without ...

````

C. **Single source of truth**. Каждое правило живёт в ОДНОМ месте. Если правило применимо к нескольким агентам — выносится в общий файл и линкуется.

D. **Skill-first где возможно**. Вместо «помни прочитать X» — «обязан вызвать skill Y в случае Z». Это эксплицитный механизм.

E. **Self-enforcing где возможно**. Если правило можно превратить в CI hook / lint rule / commit hook — это лучше чем doc-only.

F. **Lessons rotation**. lessons.md > 30 записей → консолидировать в правила. Старые записи в archive/.

G. **Session-boundary resilience**. Каждый agent doc должен иметь sub-section «Recovery after compaction»: что прочитать, какие state-файлы проверить, какие команды запустить.

H. **Cross-agent contracts эксплицитны**. State-machine / sequence diagram кто кому что когда. Где-то в одном месте (contracts.md).

Этапы работы:

ЭТАП 1 — AUDIT (foreground, обязательно завершить ПЕРЕД ЭТАПОМ 2):

1.1. Inventory всех .md в docs/agents/ + CLAUDE.md. Таблица: файл, размер, last-modified, краткое содержание.
1.2. Граф cross-references через ast-grep (паттерн: ссылки `docs/agents/*.md` в других .md).
1.3. Дедупликация: keyword-based анализ повторяющихся правил.
1.4. Inventory inconsistencies / противоречий.
1.5. Создать docs/agents/architect-audit.md — таблица, граф, выводы.

ЭТАП 2 — DESIGN (foreground):

2.1. Создать docs/agents/architecture-v2.md с:
- Новая структура каждого agent-doc (golden rules → workflow → reference → recovery).
- Решение CLAUDE-X.md vs X.md (merge/keep separate/rename).
- Skill-first таблица (mandatory skill invocation в каких сценариях).
- Lessons rotation policy (threshold + consolidation rules).
- Cross-agent contracts diagram (mermaid или ASCII).
- Session-recovery protocol.
- Token budget per agent doc.
2.2. **PR с одним только design doc + audit doc**. Title: `chore(agents): аудит + предложение архитектуры v2`. **Ждать user approval перед ЭТАПОМ 3.**

ЭТАП 3 — IMPLEMENTATION (после approval, foreground):

3.1. Создать новую структуру каждого agent-doc по design.
3.2. Удалить дубликаты, single source of truth.
3.3. Golden rules секции наверх каждого doc.
3.4. Архивация устаревших в docs/agents/archive/.
3.5. Создать docs/agents/contracts.md с диаграммами.
3.6. Обновить CLAUDE.md (top-level pointer).
3.7. Обновить promptы в .github/workflows/*.yml если paths изменились.
3.8. Обновить docs/agents/README.md как entry point.
3.9. Создать docs/agents/CHANGES.md (migration log).

ЭТАП 4 — SELF-TEST:

4.1. Dispatch тестового Coder агента на trivial task (например, минимальный typo fix в comment в apps/web).
4.2. Verify: Coder прочитал новые docs, соблюдает golden rules, не пытается --no-verify.
4.3. Если fail — пересмотреть design + повторить.

ЭТАП 5 — PR + handoff:

5.1. PR с implementation. Title: `refactor(agents): мульти-агент docs v2 — golden rules, no duplication, lessons rotation`.
5.2. Body: подробное описание изменений, миграция guide, что прочитать первым.
5.3. Финальный отчёт с включёнными выводами:
```bash
git log origin/<branch> -1 --oneline
gh pr view <PR_NUM> --json number,headRefName,state
````

Что НЕ делать:

- Не редактировать apps/\*\* (это docs refactor).
- Не использовать --no-verify (zero tolerance, см. CLAUDE-coder.md если работаешь под coder identity).
- Не сводить всё к одному mega-doc — token efficiency.
- Не удалять lessons без архивации.
- Не пушить implementation до user approval design'а.

Repo: yaremenko-maksym/CheekyCheeseIT_CRM. Все edits — отдельные коммиты, осмысленные сообщения.

```

```
