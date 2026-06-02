# Architecture v2 — multi-agent docs

**Date:** 2026-06-02
**Status:** Draft (awaiting user approval before implementation)
**Author:** AI Architect
**Branch:** `chore/multiagent-docs-refactor`
**Source audit:** [`architect-audit.md`](architect-audit.md) (read this first)

Этот файл — **proposal**. Изменения в agent docs делать **только после approval** пользователя.

---

## 0. Goals (по task spec)

Полная рефакторизация под:

- **Token efficiency**: критичные rules наверху, ≤ 200 строк top-of-file. Detail reference выносится отдельно.
- **Unmissable golden rules**: 5-7 zero-tolerance правил в начале каждого agent doc.
- **No duplication**: каждое правило живёт **в одном месте** (single source of truth).
- **Self-enforcing**: где можно — CI hooks / skill invocations / system prompt rules вместо «надейся что прочитал».
- **Lessons rotation**: lessons.md → консолидируется в правила при threshold, старые в archive.
- **Cross-agent contracts**: явные диаграммы кто кому что когда.
- **Skill-first**: какие skills mandatory в каких сценариях.
- **Session-boundary resilient**: чёткая sub-section в каждом doc «что делать после compaction».

---

## 1. Новая структура каждого agent doc

Стандартный template для всех 5 agent docs (`coder.md`, `pm.md`, `reviewer.md`, `autotest.md`, `devops.md`, `ba.md`). Total ≤ 200 строк top-of-file.

```
# <Agent> — system prompt

## Роль
<1-3 sentence purpose>

## Golden rules (zero tolerance)
1. NEVER ...
2. NEVER ...
3. ALWAYS ...
4. ...
(5-7 rules max)

## Session-recovery checklist
After compaction / new session start, before any other work:
1. Read pm-state.json (or task-file)
2. Run `tail -5 .claude/coder-activity.log`
3. Check ...

## Mandatory skill invocation
Trigger → Skill mapping:
| Trigger | Skill |
| ... | ... |

## Workflow (high-level — link out for detail)
1. Setup branch (link to common-rules.md)
2. Read task / brief
3. Implement (link to reference.md sections)
4. Verify (link to common-rules.md)
5. Commit & push (link to common-rules.md)
6. Final report (link to common-rules.md)

## Reference (on-demand)
- [Detailed workflow](<agent>-reference.md)
- [Code conventions](common-rules.md#code-conventions)
- [Memory / lessons](memory/<agent>/lessons.md)
- [Session recovery — long version](common-rules.md#session-recovery)

## Zone-of-write / off-limits
- Can edit: ...
- Cannot edit: ...

## Quick links
- ...
```

**Rationale**:

- **Golden rules первыми** — даже если агент не читает дальше, эти 5-7 точек он увидит.
- **Session recovery в top section** — потому что agent может стартовать в середине: после compaction, после dispatch с минимальным prompt.
- **Mandatory skill invocation** — explicit table «когда вызвать skill» (не «возможно надо»). Это enforcement-friendly.
- **Workflow краткий**, detail в reference. Token saving.
- **Zone-of-write эксплицитен** в каждом doc — это zero-overhead enforcement (Reviewer проверит).

### 1.1. Top section длина

| Doc           | Target lines top-of-file |
| ------------- | ------------------------ |
| `coder.md`    | ≤ 180                    |
| `pm.md`       | ≤ 200                    |
| `reviewer.md` | ≤ 150                    |
| `autotest.md` | ≤ 150                    |
| `devops.md`   | ≤ 150                    |
| `ba.md`       | ≤ 150                    |

Текущий coder.md = 580 строк. Цель: 180 + reference в `coder-reference.md` (~ 300-400). Total **не увеличивается**, но dispatch грузит меньше.

---

## 2. CLAUDE-X.md vs X.md — decision: merge + rename

### 2.1. Анализ ситуации

Per audit (section 4.2):

- CLAUDE-X.md изначально задумывался как короткая system-prompt версия. Это **не соблюдается**: CLAUDE-pm.md (16KB) и CLAUDE-devops.md (16KB) ≈ pm.md/devops.md.
- В реальности `CLAUDE-X.md` содержит **гибрид** из agent notes + technical facts проекта + state-recovery.
- Никто из агентов не использует CLAUDE-X.md как "system prompt summary" — они читают **оба** файла.

### 2.2. Решение

**Merge CLAUDE-X.md в X.md** для каждого агента, с сохранением "agent notes" контента как append-only section в конце.

**Перенос фактов проекта** (миграции, версии, бизнес-модель, статус фаз) — **из CLAUDE-X.md в common project state** (новые файлы):

- `docs/agents/common-rules.md` — cross-agent правила (commit hygiene, MCP order, skills full table, session-recovery long form)
- `docs/agents/project-state.md` — снимок проекта (миграции, фазы, версии). Single source of truth, обновляется PM/BA. Все agent docs ссылаются.

### 2.3. Mapping (что куда переезжает)

| Старый файл          | Куда                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE-coder.md`    | Команды → `common-rules.md`; gotchas → `coder-reference.md`; статус → `project-state.md`                                            |
| `CLAUDE-pm.md`       | Secrets → `common-rules.md`; durations → `pm-reference.md`; ScheduleWakeup → `pm-reference.md`; pm-state schema → `pm-reference.md` |
| `CLAUDE-reviewer.md` | Architecture facts → `project-state.md`; inline-comments → `reviewer-reference.md`                                                  |
| `CLAUDE-autotest.md` | Seed users → `project-state.md`; antipatterns → `autotest-reference.md`                                                             |
| `CLAUDE-devops.md`   | Pipeline architecture → `devops-reference.md`; secrets → `common-rules.md`; archived plugin notes → удалить (устарели)              |
| `CLAUDE-ba.md`       | Бизнес-модель → `project-state.md`; pipeline → `architecture-v2.md` (этот файл, секция 4)                                           |
| `CLAUDE-tools.md`    | Полная таблица MCP/native → `common-rules.md` (section)                                                                             |

После migration CLAUDE-X.md **удаляются**. Все ссылки в agent docs пересобираются.

### 2.4. Альтернатива (отвергнута)

«Оставить CLAUDE-X.md как есть, переименовать в `X-notes.md`» — отвергнута. Проблема не в имени, а в дубликации фактов проекта. Без extraction в `project-state.md` дубликаты сохранятся.

---

## 3. Single source of truth — где каждое правило живёт

Per audit section 3, дубликаты в 10 категориях. Решение — таблица «правило → один файл».

### 3.1. Cross-agent rules (`common-rules.md` — новый)

| Правило                                                       | Section в common-rules.md      |
| ------------------------------------------------------------- | ------------------------------ |
| MCP priority (MCP → нативные → Bash)                          | `## Tool priority`             |
| Полная таблица MCP/native/skills                              | `## Tool catalog`              |
| Git workflow (явный `git add <files>`, никогда `git add .`)   | `## Git commit hygiene`        |
| `--no-verify` запрещён (golden rule везде)                    | `## Forbidden patterns`        |
| `ac_verified:` в commit message                               | `## Commit format`             |
| Worktree hygiene (не подметать debug-артефакты)               | `## Git commit hygiene`        |
| Версии (Vite 6.4, TanStack 1.168, Node 20, pnpm 7.32.4)       | `## Version pins`              |
| Session-recovery long form (compaction, schedule, state.json) | `## Session recovery`          |
| Skill catalog (полная таблица всех 8 skills + when to invoke) | `## Skill catalog`             |
| Zone-of-write общая декларация                                | `## Zone-of-write contract`    |
| Lessons format (P0/P1/P2, format, rotation rules)             | `## Memory & lessons protocol` |

### 3.2. Per-agent prompts (X.md)

Содержат **только agent-specific** правила. Общие — линкуются.

Пример coder.md после refactor:

```
## Golden rules
1. NEVER `git push --no-verify` / `git commit -n` / hooks bypass. See: common-rules.md#forbidden-patterns
2. NEVER claim "verified" без visual + AC-in-diff check
3. NEVER `git add .` — only explicit files
4. ALWAYS wip-push after 2 files OR 5 minutes
5. ALWAYS write `ac_verified:` in final commit
6. RESPECT zone-of-write — see common-rules.md#zone-of-write-contract for full table; Coder may edit only apps/api, apps/web, apps/e2e, packages/, docs/specs/tasks/<my-task>.progress.md, .blocked.md
7. STOP and create .blocked.md if business logic ambiguous
```

### 3.3. Project state (`project-state.md` — новый)

Single source of truth для **factual state of the project**:

| Информация                          | Update owner             |
| ----------------------------------- | ------------------------ |
| Текущий статус фаз 1-9              | PM/BA после каждой merge |
| Drizzle миграции 0000-N             | PM/BA при db:generate    |
| RBAC матрица (5 ролей)              | BA при изменении логики  |
| Канонические версии                 | DevOps при upgrade       |
| Shared schemas inventory            | Coder/BA при добавлении  |
| Tech gotchas (Vite/Fastify/dnd-kit) | Coder при discovery      |

Все agent docs **линкуют** на этот файл, не дублируют.

### 3.4. Перевод корневого CLAUDE.md

`CLAUDE.md` корневой (project memory bank) **сохраняется**, но:

- Бизнес-правила (lines 439-449) → ссылка на `project-state.md#rbac-and-business-rules`
- Phase status (lines 185-204) → ссылка на `project-state.md#phases`
- Drizzle migrations (lines 491-498) → ссылка на `project-state.md#migrations`

Это убирает 4-кратное дублирование (см. audit section 3.4, 3.7, 3.8).

---

## 4. Skill-first table — mandatory skill invocation

В `common-rules.md` секция «Skill catalog» — единственная таблица для всех агентов.

| Trigger                                                              | Skill                                        | Agents impacted           |
| -------------------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| Сессия начинается (любая)                                            | `superpowers:using-superpowers`              | All                       |
| Любая creative задача (фича / UI / behavior change)                  | `superpowers:brainstorming`                  | BA, PM, Coder             |
| Перед написанием implementation для multi-step task                  | `superpowers:writing-plans`                  | Coder, DevOps             |
| Перед написанием implementation any feature/fix                      | `superpowers:test-driven-development`        | Coder                     |
| Любой баг / test failure / unexpected behavior                       | `superpowers:systematic-debugging`           | All                       |
| Перед PR / completion claim                                          | `superpowers:verification-before-completion` | Coder, AutoTest, DevOps   |
| Перед PR с auth / finance / transactions / wallets / smart-contracts | `superpowers:security-review`                | Coder, Reviewer           |
| Начало каждого review                                                | `superpowers:requesting-code-review`         | Reviewer                  |
| Получение review feedback                                            | `superpowers:receiving-code-review`          | Coder                     |
| После написания кода (cleanup)                                       | `superpowers:simplify`                       | Coder                     |
| Новая страница / сложный UI component                                | `frontend-design:frontend-design`            | Coder                     |
| Need isolated workspace (parallel work)                              | `superpowers:using-git-worktrees`            | PM (для Coder dispatch)   |
| Implementation plan execution                                        | `superpowers:executing-plans`                | PM, Coder                 |
| Multi-task dispatch                                                  | `superpowers:dispatching-parallel-agents`    | PM                        |
| Branch ready to merge (готовится PR)                                 | `superpowers:finishing-a-development-branch` | Coder, PM                 |
| Memory consolidation / dedup                                         | `anthropic-skills:consolidate-memory`        | PM (для lessons rotation) |

**Self-enforcement**:

- Trigger → Skill — записан в agent doc и в common-rules.md. Agent **обязан** вызвать skill, не «помнить».
- Если skill отсутствует в окружении — `Skill` tool сам падает с ошибкой. Это **explicit failure**, лучше чем silent skip.
- Agent в финальном отчёте **показывает** какие skills вызывал. PM проверяет.

---

## 5. Lessons rotation policy

### 5.1. Текущая проблема (audit 4.5)

- На бумаге: > 30 строк → archive.
- В реальности: lessons недозаписываются, < 15 строк во всех файлах.

### 5.2. Новая policy

**Trigger-based вместо threshold-based.**

#### 5.2.1. После каждого merged PR — PM ОБЯЗАН append

`pm.md` секция «Lessons append» (вместо текущей line 363-374):

```
ПОСЛЕ КАЖДОГО MERGED PR (no exceptions):
1. Открыть completed task в pm-state.json
2. Извлечь 1-3 урока (не «выполнил задачу» — а «было неочевидно»)
3. Append в docs/agents/memory/<agent>/lessons.md
4. Format: <YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic) <урок>

Это step из workflow Mode 2.A (completed) — НЕ optional.
```

**Self-enforcement**: PM script проверяет что `lessons.md` за последнюю неделю имеет ≥ 1 lesson, иначе — warning при следующем PM start.

#### 5.2.2. Consolidation (lessons → rules)

Когда `lessons.md` достигает **20 строк** (вместо 30 — meaningful earlier):

1. Architect (или PM в Mode "memory consolidation") вызывает `anthropic-skills:consolidate-memory`.
2. Skill анализирует duplicates / упрощает / выделяет паттерны.
3. **P0 lessons (5+ повторений) → promote в Golden rules** соответствующего agent doc.
4. **P1 lessons** → consolidate в общие правила в `common-rules.md`.
5. **P2 lessons** → archive в `memory/<agent>/lessons.archive.md`.

Это «levelling-up» урока: персональный case → общее правило → enforced rule.

### 5.3. Archive structure

```
docs/agents/memory/<agent>/
├── lessons.md          (active, ≤ 20 lines)
├── lessons.archive.md  (historical, full record)
```

Agents читают только `lessons.md`, не `archive.md`. Archive для retrospective.

---

## 6. Cross-agent contracts diagram

Новый файл: `docs/agents/contracts.md`. Содержит **формализованный state-machine** взаимодействия агентов.

### 6.1. State diagram (Mermaid-style ASCII)

```
                ┌────────┐
                │  USER  │  Brief / feature request
                └────┬───┘
                     │ "новая фича"
                     ▼
                ┌────────┐
                │   BA   │  Анализ коллизий + brief + business docs
                └────┬───┘
                     │ pm-brief.md created
                     ▼
                ┌────────┐
                │   PM   │  Декомпозиция → task-*.md → dispatch
                └────┬───┘
                     │ Agent(isolation="worktree", run_in_background=True)
        ┌────────────┼──────────────────────┐
        ▼            ▼                       ▼
   ┌─────────┐  ┌─────────┐             ┌─────────┐
   │  CODER  │  │ DEVOPS  │             │AUTOTEST │ (post-coder)
   └────┬────┘  └────┬────┘             └────┬────┘
        │            │                       │
        │ PR open    │ PR open               │ (mode 1 / 2 / 3)
        ▼            ▼                       │
   ┌─────────────────────────────┐           │
   │     PM Mode 2 (events)      │◄──────────┘
   │  Decision tree → dispatch   │
   └────────────┬────────────────┘
                │
                │ (after Coder PR, decide skip-or-dispatch AutoTest per pm.md)
                ▼
        ┌─────────────┐
        │  REVIEWER   │  Read PR + write review (APPROVE / BLOCK)
        └──────┬──────┘
               │ Verdict: APPROVE → awaiting-pm-review label
               │ Verdict: BLOCK → do-not-merge label → Coder fix-task
               ▼
        ┌─────────────┐
        │   PM Mode 4 │  User Testing → tunnel → user feedback
        └──────┬──────┘
               │
       ┌───────┴──────────────┐
       ▼ "апрув"              ▼ "правки"
   merge-approved label   Mode 4.A: batch dispatch Coder
       │                       │
       │ CI auto-merge         └─────► back to Coder loop
       ▼
   ┌─────────┐
   │ MERGED  │  PM appends lesson → next task
   └─────────┘
```

### 6.2. Labels — обязательная таблица

Single source of truth для label semantics:

| Label                   | Кто ставит                 | Семантика                                                    | Кто снимает                           |
| ----------------------- | -------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| `ai-review-ready`       | Coder/DevOps после PR open | PR готов к Review (исторически — auto-trigger ai-review.yml) | Reviewer (после APPROVE) или ручной   |
| `awaiting-pm-review`    | Reviewer (внутри APPROVE)  | Reviewer APPROVE'нул, PM смотрит и идёт в User Testing       | PM при User Testing approve           |
| `do-not-merge`          | PM при Verdict: BLOCK      | Critical issue найден, merge заблокирован                    | PM при следующем APPROVE Reviewer     |
| `merge-approved`        | PM после User Testing apr  | User-approve получен, CI делает squash-merge                 | (никто; merge сам убирает)            |
| `ci-failed`             | CI / PM при e2e_failed     | E2E или CI step упал — нужен fix                             | PM после merge fix-task               |
| `e2e-broken` (на issue) | CI (notify_e2e job)        | E2E на main сломан — глобальный blocker                      | CI auto-close при зелёном E2E на main |

### 6.3. Sequence для типичных flows

#### 6.3.1. New feature (happy path)

```
USER → BA: "сделай Phase X"
BA → PM: pm-brief.md (commit)
PM → Coder: Agent(prompt="task-X.md")
  Coder → PR (wip-push N times)
  Coder → PR (final commit with ac_verified)
PM → Reviewer: Agent(prompt="PR #N")
  Reviewer → APPROVE (создаёт mcp__github__create_pull_request_review)
  Reviewer → label: awaiting-pm-review
PM → User: "PR #N готов к тестированию" + Serveo URL
USER → PM: "апрув"
PM → label: merge-approved (CI auto-merge)
CI → merged
PM → memory/coder/lessons.md (append 1-3 lessons)
PM → archive task to docs/specs/tasks/archive/
```

#### 6.3.2. Review BLOCK path

```
PM → Reviewer: Agent(prompt="PR #N")
  Reviewer → COMMENT с "Verdict: BLOCK" (first line)
PM → labels: -awaiting-pm-review, +do-not-merge
PM → review_rounds++ в pm-state.json
  IF review_rounds >= 3: STOP, эскалация
  ELSE:
    PM → Coder: Agent(prompt="task-fix-pr-N.md", target_branch=...)
      Coder → push fixes
    PM → Reviewer (повторно): Agent(prompt="PR #N")
      (loop until APPROVE OR limit)
```

#### 6.3.3. Compaction recovery

```
[SESSION ENDS / COMPACTION]
[NEW SESSION STARTS]

PM (any agent):
  1. Read docs/agents/<self>.md → Golden rules + Session-recovery
  2. Read pm-state.json (if exists)
  3. tail -5 .claude/coder-activity.log
  4. ls docs/specs/tasks/*.blocked.md
  5. ls docs/specs/tasks/*.progress.md (для крупных задач)
  6. Sync с remote: git fetch origin
  7. Resume on next_action (если есть)

Coder (after compaction):
  1. Read docs/agents/coder.md → Golden rules
  2. cat docs/specs/tasks/<my-task>.progress.md (если есть)
  3. tail -3 .claude/coder-activity.log | grep INTENT
  4. git status / git log --oneline -5 / pwd
  5. Resume on milestone N+1 если sentinel говорит N done
```

### 6.4. Task file → agent mapping

| Task pattern              | Agent     | Triggered by                           |
| ------------------------- | --------- | -------------------------------------- |
| `task-<slug>.md`          | Coder     | PM Mode 1 (new feature decomposition)  |
| `task-fix-pr-<N>.md`      | Coder     | PM Mode 2.D (after BLOCK) или Mode 4.A |
| `task-fix-e2e-<slug>.md`  | AutoTest  | PM Mode 2.C (e2e_failed = test bug)    |
| `task-fix-test-<slug>.md` | AutoTest  | PM при обнаружении gap в coverage      |
| `task-infra-<slug>.md`    | DevOps    | PM из BA brief или из incident         |
| `task-<X>.blocked.md`     | (agent X) | Agent X создал, PM читает              |
| `task-<X>.progress.md`    | Coder     | Coder для крупных задач (sentinel)     |

---

## 7. Session-recovery protocol — sub-section

В каждый agent doc добавляется sub-section в top section.

### 7.1. Coder

```
## Session-recovery (after compaction)

ОБЯЗАТЕЛЬНО прочитать ПЕРЕД любой работой:
1. `git status && git log --oneline -10` — узнать где остановился
2. `cat docs/specs/tasks/<my-task>.progress.md` (если есть) — milestone N/M
3. `tail -5 .claude/coder-activity.log | grep INTENT` — что планировал
4. Если pre-push hook требует `ac_verified:` — проверить можешь ли finish

Resume rule:
- Если milestone N completed (per sentinel) — продолжай с N+1
- Если intent был "starting test run" без push после — проверь не сломал ли локально
- Если есть uncommitted в worktree — НЕ override без `git stash`
```

### 7.2. PM

```
## Session-recovery (after compaction)

ОБЯЗАТЕЛЬНО прочитать ПЕРЕД любой работой:
1. `cat docs/specs/pm-state.json` — текущее состояние работы
2. `ls docs/specs/tasks/*.blocked.md` — есть ли blocked задачи
3. `gh pr list --state open` — open PRs от агентов
4. Проверить `next_action` в каждом active task — если есть и `scheduled_at` < now,
   выполнить немедленно (ScheduleWakeup не выжил session boundary)

Layer 2 wakeup (mcp__scheduled-tasks) — survives session.
Layer 1 wakeup (ScheduleWakeup) — НЕ survives.
См. common-rules.md#session-recovery для full matrix.
```

### 7.3. AutoTest / Reviewer / DevOps

Аналогично, но **проще** (они обычно одношаговые):

```
## Session-recovery (after compaction)

1. Read this doc top (Golden rules)
2. Re-read PR / task-file целиком (без trust в conversation history)
3. Если в middle-of-work — see git status / git log
```

---

## 8. Token budget per doc (target)

| Doc                          | Текущий     | Target (после refactor) | Что выкинуто                                                            |
| ---------------------------- | ----------- | ----------------------- | ----------------------------------------------------------------------- |
| `coder.md`                   | 34 KB / 580 | 12 KB / 180             | Workflow detail → coder-reference.md; team gotchas → project-state.md   |
| `pm.md`                      | 24 KB / 410 | 12 KB / 200             | Mode subroutines → pm-reference.md; pm-state schema → pm-reference.md   |
| `reviewer.md`                | 20 KB / 300 | 10 KB / 150             | Security check detail → reviewer-reference.md; AST patterns same        |
| `autotest.md`                | 16 KB / 289 | 10 KB / 150             | Workflow detail → autotest-reference.md; antipatterns → common-rules.md |
| `devops.md`                  | 12 KB / 230 | 8 KB / 150              | Pipeline architecture → devops-reference.md; secrets → common-rules.md  |
| `ba.md`                      | 16 KB / 260 | 10 KB / 150             | Workflow detail → ba-reference.md; business model → project-state.md    |
| `common-rules.md` (new)      | 0           | 12 KB / 250             | (содержит cross-cutting rules)                                          |
| `project-state.md` (new)     | 0           | 8 KB / 150              | (содержит facts: phases, migrations, versions, RBAC)                    |
| `contracts.md` (new)         | 0           | 6 KB / 150              | (state diagrams + labels + sequences)                                   |
| `<agent>-reference.md` (new) | 0           | по 6-10 KB              | (on-demand reference per agent, не читается upfront)                    |
| `pm-snippets.md`             | 20 KB / 411 | 12 KB / 250             | Coder recovery → common-rules.md; sniplets обновить                     |
| `CLAUDE-*.md`                | 56 KB total | 0                       | Полностью удалены (merge в X.md + project-state.md)                     |
| `CLAUDE-tools.md`            | 12 KB / 195 | 0                       | Полностью удалён (merge в common-rules.md)                              |
| `memory/<agent>/lessons.md`  | varies      | unchanged (но rotation) | ≤ 20 lines active                                                       |

### 8.1. Total comparison

| Метрика                          | Now    | Target   | Δ        |
| -------------------------------- | ------ | -------- | -------- |
| Total docs/agents/\*\* size      | 228 KB | ~ 130 KB | **-43%** |
| Coder dispatch read (compulsory) | 58 KB  | 22 KB    | **-62%** |
| PM dispatch read (compulsory)    | 48 KB  | 22 KB    | **-54%** |

### 8.2. Token-per-tool budget

В формате skill / agent — **читать только** обязательные `<X>.md` + `common-rules.md` + `project-state.md` + `memory/<X>/lessons.md` upfront. Reference / snippets / contracts — on-demand.

---

## 9. CHANGES.md + deprecation strategy

### 9.1. `docs/agents/CHANGES.md` (новый)

Append-only changelog для multi-agent docs:

```markdown
# docs/agents/ Changelog

## 2026-06-XX — Architecture v2 (this refactor)

### Added

- common-rules.md — single source for cross-agent rules
- project-state.md — facts inventory
- contracts.md — state-machine diagrams
- <agent>-reference.md (5 files) — on-demand detail

### Changed

- All <agent>.md: golden rules section added top of file
- Lessons format: trigger-based rotation (was threshold-based)
- ...

### Removed

- CLAUDE-coder.md, CLAUDE-pm.md, CLAUDE-reviewer.md, CLAUDE-autotest.md, CLAUDE-devops.md, CLAUDE-ba.md
- CLAUDE-tools.md (merge в common-rules.md)

### Migration notes

- All .github/workflows/{coder,autotest,devops,ai-review}.yml are archived — docs now describe local Agent() dispatch
- ...
```

### 9.2. Deprecation markers

Внутри файлов — explicit пометки:

```markdown
> ⚠️ DEPRECATED 2026-06-XX. Use common-rules.md#commit-format instead.
```

При первой read такой секции — agent видит метку и не доверяет deprecated content.

### 9.3. Стейл cleanup в этом refactor

Update:

- `CLAUDE-ba.md` Pipeline diagram → новый based on Agent()
- `pm.md` Mode 2.B — переформулировать как Reviewer = Agent() tool, не workflow
- `devops.md` секция 5 — `ai-review-ready` label роль изменилась, обновить
- `CLAUDE-devops.md` — pipeline jobs section → переписать или удалить (workflows archived)

---

## 10. Migration safety (staged)

### Phase 1 (этот PR — audit + design)

- Только два файла: `architect-audit.md` + `architecture-v2.md`
- **Существующая структура работает как есть** — никто не сломан
- User approves design

### Phase 2 (отдельный PR после approval)

- **Step 1**: создать новые файлы (`common-rules.md`, `project-state.md`, `contracts.md`, `<agent>-reference.md` × 5)
- **Step 2**: добавить **deprecation markers** в старые CLAUDE-X.md и dublicate секции (но не удалять)
- **Step 3**: обновить `<agent>.md` (golden rules + session recovery + сокращение workflow до high-level)
- **Step 4**: коммит с пометкой "agents v2 staged — old files retained as deprecated"

**В этот момент** старые файлы **существуют**, но содержат банеры. Любой агент которого dispatched по старому prompt — прочитает заглушку с pointer на новые файлы.

### Phase 3 (после self-test и подтверждения)

- Удалить deprecated CLAUDE-X.md files
- Обновить `pm-snippets.md` под новые paths
- Update README.md в `docs/agents/`

### Phase 4 (self-test)

- Dispatch тестового Coder на trivial task (typo fix в comment в `apps/web/`)
- Verify по чеклисту из AC5:
  - Прочитал новые docs (не старые)
  - Соблюдает golden rules (no `--no-verify`)
  - Не пытается обойти hooks
- Если fail — пересмотреть design

### Phase 5 (cleanup + handoff)

- Update CLAUDE.md (top-level pointer на новую структуру docs/agents/)
- Update task-spec template
- Final report

---

## 11. Acceptance criteria mapping (по task spec)

| AC                                  | Status in v2                                                       |
| ----------------------------------- | ------------------------------------------------------------------ |
| AC1: Audit                          | ✅ `architect-audit.md` — все 5 sub-criteria выполнены             |
| AC2: Design                         | ✅ `architecture-v2.md` (этот файл)                                |
| AC3: Implementation                 | ⏳ Phase 2+ после user approval                                    |
| AC4: Migration safety               | ✅ Staged migration (section 10) — backward compat maintained      |
| AC5: Self-test                      | ⏳ Phase 4                                                         |
| AC6: Documentation (README/CHANGES) | ⏳ Phase 3                                                         |
| AC7: pnpm typecheck/lint/test       | ✅ Не нужно — изменения только в docs (но проверим в Phase 2 PR)   |
| AC8: PR                             | ✅ Phase 1 PR (этот) = audit + design; Phase 2 PR = implementation |

---

## 12. Open questions для user approval

Перед Phase 2 нужны явные ответы (если default неприемлем):

1. **Удалять CLAUDE-X.md или оставить как redirect stub?**
   Default: удалить через 2 PR (deprecated → удалён). Альтернатива: оставить как 1-line stub `→ See <X>.md`.

2. **`common-rules.md` или `_common-rules.md` / `RULES.md`?**
   Default: `common-rules.md` (consistent с другими).

3. **Project-state.md — single file или split (phases.md / migrations.md / rbac.md)?**
   Default: single file. Single source of truth easier to maintain.

4. **Contracts.md visuals — ASCII или Mermaid (HTML render only on GitHub)?**
   Default: ASCII (works in editors). Mermaid optionally as second representation.

5. **Lessons priority promotion (P0 lesson → Golden rule) — manual via PM или skill-driven?**
   Default: skill-driven via `anthropic-skills:consolidate-memory` каждые 4 недели или при threshold.

6. **Archive старых лессонов — `archive.md` в той же папке или общая `docs/agents/archive/`?**
   Default: в той же папке (`memory/<agent>/lessons.archive.md`). Преемственно с current структурой.

7. **Self-test тестовая Coder задача — какая именно?**
   Suggestion: исправить typo в существующем русском комментарии в `apps/web/app/routes/crm/` или добавить пустую строку перед export. Trivial, но требует git workflow.

---

## 13. Что НЕ делается в этом рефакторе (explicit out of scope)

- Не редактирую apps/\*\* — это docs refactor
- Не меняю `.clauderules` — это уровень project rules, не agent docs
- Не упраздняю `superpowers:*` skills — они инструменты, не docs
- Не меняю `.github/workflows/` структуру (но описание в docs обновляю)
- Не трогаю `docs/business/` — это BA-зона
- Не реализую CI hook для enforcement (рекомендация only, может быть в DevOps task позже)

---

## 14. Если approve → next steps

После user "approve":

1. Architect (этот же субагент или новый dispatch) переходит в Phase 2 — implementation.
2. Создание новых файлов + старые с deprecation banners (один коммит).
3. Сокращение agent docs + golden rules (один коммит per agent).
4. Update CLAUDE.md root + pm-snippets.md (один коммит).
5. Self-test dispatch (Phase 4).
6. Cleanup deprecated files (один коммит).
7. PR с title `refactor(agents): мульти-агент docs v2 — golden rules, no duplication, lessons rotation`.

Если "not approve" → architect ждёт feedback / clarifying questions от user.
