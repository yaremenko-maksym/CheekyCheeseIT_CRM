# ECC Migration — Practical User Guide

**Audience:** Maksym (founder, основатель CheekyCheeseIT). Тех-владение есть, экспертизы по multi-agent системам нет — этот документ заполняет gap.

**Назначение:** не теория, а **что у тебя СЕЙЧАС**, **что появится после миграции**, **как этим пользоваться** (по сценариям) и **куда обращаться при затыке**.

**Связанные документы:**

- [`2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) — Master ADR (10 sections), решения и обоснования.
- [`2026-05-31-architect-discovery-report.md`](2026-05-31-architect-discovery-report.md) — discovery report, на основе которого ADR построен.
- [`2026-05-31-legal-agent-design.md`](2026-05-31-legal-agent-design.md) — design Legal-агента (отдельная подсистема).

**Honest disclaimer:** ECC patterns предполагаются working на основе Discovery Report + ADR analysis. Часть capabilities (e.g. continuous-learning observer, exact security profile skill list, ECC `developer` profile install behaviour в нашем monorepo) **подтверждается в Phase 1 spike** — до того их описание здесь основано на ECC docs, не на personal experience.

---

## Оглавление

1. [Что у тебя есть СЕЙЧАС](#section-1)
2. [Что появится по фазам миграции](#section-2)
3. [Practical workflows после миграции](#section-3)
4. [Slash commands](#section-4)
5. [Skills — что invokable](#section-5)
6. [Hooks — что автоматически срабатывает](#section-6)
7. [Memory & lessons — как накапливаются знания](#section-7)
8. [Direct dispatch агентов (advanced)](#section-8)
9. [Decision tree — куда обращаться по запросу](#section-9)
10. [FAQ + gotchas](#section-10)
11. [Quick start — первые 5 минут после Phase 6](#section-11)

---

## Section 1 — Что у тебя есть СЕЙЧАС {#section-1}

**Pre-migration baseline (2026-06-03).** Это снимок _до_ ECC migration starts.

### 1.1 Active agents (7)

| Agent        | Role                                                         | Type                | Где живёт                                                    |
| ------------ | ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------ |
| **BA**       | Бизнес-консультант — пишет `docs/specs/pm-brief.md`          | Human role (не LLM) | `docs/agents/ba.md` (документация для роли)                  |
| **PM**       | Оркестратор: brief → tasks → dispatch → User Testing → merge | LLM (orchestrator)  | `docs/agents/pm.md` + `pm-snippets.md` + `CLAUDE-pm.md` stub |
| **Coder**    | Fullstack dev: feature, fix, test                            | LLM (worker)        | `docs/agents/coder.md`                                       |
| **AutoTest** | E2E test developer (Playwright specs)                        | LLM (worker)        | `docs/agents/autotest.md`                                    |
| **Reviewer** | Code review на PR (Verdict: BLOCK pattern)                   | LLM (gatekeeper)    | `docs/agents/reviewer.md`                                    |
| **DevOps**   | CI/CD, GHA workflows, инфра                                  | LLM (worker)        | `docs/agents/devops.md`                                      |
| **Legal**    | UA jurisdictional advisor (4 modes)                          | LLM (advisor)       | `docs/agents/legal.md` + `docs/legal/` knowledge base        |

### 1.2 Как они сейчас работают

**Стандартный цикл:**

```
USER (ты) → BA пишет pm-brief.md → PM читает brief
                                         ↓
PM декомпозирует на task-файлы (docs/specs/tasks/task-*.md)
                                         ↓
PM dispatches агентов через Agent(isolation="worktree", run_in_background=True)
                                         ↓
Coder/DevOps работают в isolated worktree, открывают PR с wip-push checkpoints + final ac_verified commit
                                         ↓
PM dispatches Reviewer на каждый PR (gate) + AutoTest условно (если нет E2E coverage в diff)
                                         ↓
Reviewer APPROVE → label awaiting-pm-review → PM запускает User Testing
                                         ↓
PM поднимает env через scripts/pm/prep-user-testing.sh → Serveo tunnel → отправляет URL пользователю
                                         ↓
USER тестирует с компа / телефона → отвечает «апрув» / «правки»
                                         ↓
АПРУВ:    PM ставит label merge-approved → GHA auto-merge-on-label.yml → squash-merge
ПРАВКИ:   PM группирует в pending_fixes → батч Coder → возврат к Reviewer
```

**Legal (особняком):** не в основном pipeline. Triggers:

- User просит «спроси юриста про X» → PM Mode 5
- PM Mode 1 Step 1.5 (brief-check) — auto если в brief есть finance/data/contract triggers
- PM Mode 2 (auto PR review) — auto если PR diff trogает critical zones (`apps/api/src/{finance,auth,documents,users}/**`)

### 1.3 Pain points текущей системы

- **Custom hooks (5 shell scripts)** — `.claude/hooks/{safety,block-production-edits,coder-pre-push,coder-progress-marker,eslint-feedback}.sh`. Каждый matcher — broad (`Bash` / `Edit|Write`), нет JSON-format predicates. Hooks firing на каждой команде, не на специфическом паттерне — overhead + сложно поддерживать.
- **Monolithic agent prompts** — `coder.md` ~34 KB, `pm.md` 502 строки. Каждый агент содержит все правила inline. При update правила нужно прорезать N файлов.
- **Нет skills layer** — knowledge о NestJS / TanStack / Playwright / TypeScript patterns живёт inline в agent prompts или в `lessons.md` (free-form text). Нет structured durable workflow patterns.
- **Нет slash commands** — invocation только через `Agent(...)` raw tool call. Нельзя сказать «/plan фича X», нужно writeFile + dispatch.
- **Нет специализированных reviewer-ов** — единый Reviewer covers code + security + architecture concerns. Финансы / auth ревьюится тем же prompt'ом что и UI.
- **Нет automated TDD-cycle agent** — TDD enforce'ится через text rule в `coder.md`, не через dedicated `tdd-guide` agent с RED→GREEN→IMPROVE workflow.
- **Memory без rotation** — `lessons.md` росли неограниченно. v2 refactor (PR #78, merged 2026-06-02) ввёл 20-строчный threshold + skill `anthropic-skills:consolidate-memory` для rotation, но **promote в skill-format ещё не сделан**.

### 1.4 Что недоступно сейчас (но появится после migration)

| Capability                                                             | Сейчас                 | После ECC migration                        |
| ---------------------------------------------------------------------- | ---------------------- | ------------------------------------------ |
| Slash commands (`/plan`, `/tdd`, `/code-review`)                       | НЕТ                    | Phase 5+                                   |
| Language-specific reviewers (TypeScript, security)                     | НЕТ                    | Phase 3 (split Reviewer)                   |
| Automated TDD-cycle agent                                              | НЕТ (text-only rule)   | Phase 3 (`tdd-guide`)                      |
| Stack-specific skills (NestJS / React / Drizzle / Playwright patterns) | inline в agent prompts | Phase 4+                                   |
| Cross-harness portability (Codex, Cursor, Gemini, OpenCode, Zed)       | НЕТ                    | Phase 5 (placeholders) / Phase 7+ (active) |
| Architect, planner, build-error-resolver, harness-optimizer agents     | НЕТ                    | Phase 3                                    |
| JSON-matcher hooks (specific predicates)                               | НЕТ (broad shell)      | Phase 2                                    |
| Continuous-learning observer (pattern discovery from tool-use)         | НЕТ                    | Phase 2 (TBD spike)                        |

См. [ADR Section 2 — Per-Component Mapping](2026-05-31-ecc-migration-design.md#section-2--per-component-mapping) для полного breakdown decisions per artifact.

---

## Section 2 — Что появится по фазам миграции {#section-2}

Per [ADR Section 6 — Phase Plan (0 → 6)](2026-05-31-ecc-migration-design.md#section-6--phase-plan-0--6). Каждая фаза — отдельный PR (или multi-PR для Phase 3), требует твоего approval перед стартом.

**Total timing:** 6-9 weeks, 43-69 hours Architect dispatch.

### 2.1 Phase timeline + что становится доступным

| Phase                                            | Когда (target) | Effort | Risk | Что становится доступным после merge                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | -------------- | ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** — Discovery + ADR                          | Done           | 8-12h  | NONE | ✅ Уже сделано — ADR + Discovery Report + 10 Open Questions answered                                                                                                                                                                                                                                                                                                                                                                    |
| **1** — ECC Skeleton install                     | Week 1         | 4-8h   | LOW  | ECC reference directories (`agents/`, `skills/`, `hooks/`, `rules/`, `manifests/`, `mcp-configs/`) появляются. Coexistence с текущей системой — старые workflows ничего не меняют. Adapted `AGENTS.md`, `SOUL.md`, `WORKING-CONTEXT.md`, `RULES.md` для нашего проекта (с Russian language note + Legal listing + zone-of-write rules)                                                                                                  |
| **2** — Hooks migration                          | Week 2         | 4-6h   | MED  | Hooks переписаны в JSON-matcher format с **specific predicates** (не broad `Bash`). Dangerous-command blocking, auto-format on edits, dev server tmux enforcement, pre-push verification gate — всё **prog matchered**. D1-D4 resilience preserved через smoke tests                                                                                                                                                                    |
| **3** — Agents migration                         | Weeks 3-5      | 16-24h | HIGH | TypeScript reviewer + Security reviewer (split из единого Reviewer), Code reviewer, TDD-guide, Planner, Architect, Build-error-resolver, E2E-runner (если приходит в `developer` profile) — все ECC core agents available. PM/Coder/AutoTest/DevOps/Legal portированы в ECC YAML frontmatter format (Russian preserved, всё Mode 1-5 logic preserved)                                                                                   |
| **4** — Lessons → Skills                         | Weeks 5-6      | 4-8h   | LOW  | Lessons (atomic uроки в `memory/<agent>/lessons.md`) **promoted в durable skills** (`skills/<topic>/SKILL.md`). Skills follow ECC structure: `name` / `description` / `origin` frontmatter + `When to Activate` / `Workflow` / `Tested examples` sections. UA-legal skill stubs created. Recruiting-domain skill (business invariants) — single source of truth                                                                         |
| **5** — Rules + GHA + cross-harness placeholders | Week 6-7       | 4-6h   | MED  | Top 5-8 cross-cutting rules extracted в ECC `rules/` directory (Russian language, zone-of-write, confidence policy, conventional commits, AC verification, no `--no-verify`, hard escalation zones). GHA `ci.yml` gets additive `ecc-code-review` job. Cross-harness placeholder directories (`.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.zed/`) created с README. `agent.yaml` manifests exported для cross-harness portability |
| **6** — Cleanup + retro                          | Weeks 7-9      | 3-5h   | LOW  | Legacy `docs/agents/_legacy/` perm-archived. Old `.claude/hooks/*.sh` deleted (after 2+ week stability). Archived GHA workflows deleted. `CLAUDE.md` + `CONTRIBUTING.md` updated. Final `RULES.md` merged. Migration retrospective document published. **Stable end-state**                                                                                                                                                             |

### 2.2 Что user может делать после каждой phase

**После Phase 1 (Skeleton):**

- Прочитать новые ECC reference docs (`AGENTS.md`, `SOUL.md`) — понять, как ECC сообщество думает о multi-agent architecture.
- Старые workflows работают **без изменения** (coexistence). PM/Coder/Reviewer dispatch — без regression.
- Можно начать пробовать invokeable ECC skills/agents вручную (через `Agent(...)`), но они ещё не integrated в PM dispatch.

**После Phase 2 (Hooks):**

- Hooks fire'ятся точнее — меньше overhead, меньше false-positives.
- D1-D4 resilience (intent markers, pre-push verification, AC-verified gate) preserved.
- Old `.claude/hooks/*.sh` остаются в репо ещё 1 неделю (rollback safety).
- **What you do:** ничего нового — hooks работают незаметно. Если что-то блочат — error message подскажет какой hook + почему.

**После Phase 3 (Agents):**

- Dispatch `code-reviewer` напрямую для quick check без full Reviewer pipeline.
- Dispatch `security-reviewer` для финансов/auth/USDT paths.
- Dispatch `tdd-guide` чтобы написать failing test ДО fix.
- Dispatch `planner` для декомпозиции спорной задачи.
- Dispatch `architect` для design decision (trade-offs).
- Dispatch `build-error-resolver` когда `pnpm build` падает с непонятной ошибкой.
- PM начинает internally делегировать ECC sub-agents (planner для plan drafting, architect для design choices).
- Russian language preserved во всех ported agents — overide в YAML frontmatter.

**После Phase 4 (Skills):**

- Invoke skill напрямую: `Skill("nestjs-patterns")` подгружает durable knowledge о NestJS conventions без чтения всего `docs/agents/coder.md`.
- UA-legal skill stubs (5 штук — ФОП режимы, CFC, NDA, IP, GDPR/personal data) ready to fill content по mere acumulated Legal experience.
- `skills/recruiting-domain-rules/SKILL.md` — single source business invariants (1 JUNIOR / project, ACCOUNTANT auto-in-team, max 10 teams, JUNIOR derived from project_members).

**После Phase 5 (Rules + GHA):**

- Slash commands доступны: `/plan`, `/tdd`, `/code-review`, `/e2e`, etc. (см. Section 4).
- GHA `ci.yml` запускает `ecc-code-reviewer` на каждый PR (initially informational, не блокирует merge).
- Cross-harness directories (`.codex/`, `.cursor/`, etc.) — placeholders для будущего multi-harness setup.

**После Phase 6 (Cleanup):**

- Single coherent architecture — нет legacy дубликатов.
- `CLAUDE.md` обновлён — ссылки на новую структуру.
- Migration retrospective доступна для future references.
- **Стабильный end-state** — можно начинать quarterly ECC sync cycle (см. ADR Section 7).

---

## Section 3 — Practical workflows после миграции {#section-3}

Per [ADR Section 6](2026-05-31-ecc-migration-design.md#section-6--phase-plan-0--6) + integration с current `docs/agents/pm.md` Mode 1-5.

После Phase 6 (фаза cleanup завершена) — типичные сценарии работы.

### 3.1 Workflow A — Новая фича (полный cycle)

**Триггер:** «Хочу добавить функционал X» (UI + backend + tests + docs).

**Steps:**

1. **BA** (ты) пишешь `docs/specs/pm-brief.md` с описанием фичи + business context + acceptance scenarios.
2. **PM Mode 1** (Step 1) — читает brief.
3. **PM Mode 1 Step 1.5** — heuristic check на legal touchpoints. Если есть (finance / data / contract / crypto / 3rd-party / hiring) — диспетчит **Legal Mode C (brief-check)** _до_ декомпозиции, добавляет recommendations в AC.
4. **PM Mode 1 Step 2 (Декомпозиция)** — invokes `superpowers:writing-plans`. Для сложного scope — delegates `planner` (ECC agent) для plan drafting. Для design trade-offs — delegates `architect` (ECC agent).
5. **PM Mode 1 Step 3-5** — создаёт task-файлы (`task-<slug>.md` per agent), пишет `pm-state.json`, dispatches агентов параллельно.
6. **TDD path (Coder):** _Перед_ implementation — `tdd-guide` (ECC) пишет failing test (RED). Coder реализует minimum для GREEN. После — `simplify` (superpowers skill) для IMPROVE.
7. **Coder + TypeScript reviewer parallel:** Coder работает в worktree, TypeScript reviewer (ECC) проверяет код _во время_ написания на каждый Edit — faster feedback.
8. **PM Mode 2** — после Coder создал PR с `ac_verified: 1,2,3` + `vision: ✓ /crm/<route>`:
   - **MUST dispatch Reviewer** (code-reviewer, ECC) — gate.
   - **MUST dispatch security-reviewer** (ECC) — если PR трогает `apps/api/src/{finance,auth,documents,users}/**` или USDT paths.
   - **MUST dispatch Legal Mode B** (parallel) — если diff matches legal critical zones.
   - **MUST dispatch AutoTest** (или skip with reason `coder-added-e2e-covering-ac` — записать event).
   - **MUST dispatch e2e-runner** (ECC, если есть) для critical flow validation.
9. **Reviewer APPROVE** → label `awaiting-pm-review` → **PM Mode 4** (User Testing).
10. **PM Mode 4** — `scripts/pm/prep-user-testing.sh <pr_branch>` (production build + Serveo tunnel + Dev Login). PM отправляет тебе `🔗 https://<hash>.serveousercontent.com`.
11. **USER (ты)** тестируешь → «апрув» или «правки».
12. **АПРУВ:** PM ставит `merge-approved` label → CI auto-squash-merge.
13. **PM** — append 1-3 lessons в `memory/<agent>/lessons.md` per merged PR. При threshold 20 строк или batch merged PRs → invoke `anthropic-skills:consolidate-memory` для skills promotion.

### 3.2 Workflow B — Bug fix (быстрый цикл)

**Триггер:** «Что-то не работает / regression / edge-case bug».

**Steps:**

1. **Direct dispatch `tdd-guide`** (ECC) — пишет failing test reproducing bug. Это **обязательно** (per `superpowers:test-driven-development` + ECC pattern).
2. **Dispatch Coder** с `target_branch=<bugfix-branch>` для fix.
3. **Dispatch Reviewer** (code-reviewer) — gate.
4. **Skip AutoTest** если `tdd-guide` уже добавил spec покрывающий bug → write event `autotest_skipped` с reason `coder-added-e2e-covering-ac`.
5. **Skip User Testing** для тривиальных bugs (1-line typo) — direct merge-approved label после Reviewer APPROVE. Для non-trivial bugs — full Mode 4 cycle.
6. **PM** — append lesson в `memory/coder/lessons.md`: «<дата> [P1] [task-fix-<slug>] (#bug) <конкретный урок про root cause / prevention>».

### 3.3 Workflow C — Legal consultation (наш custom flow)

**Триггер (Mode A):** USER в чате «спроси юриста про X» где X — конкретная фича / PR / task. Или PM сам видит legal-вопрос.

**Триггер (Mode D):** USER «спроси юриста — можно ли X» где X — strategic вопрос вне конкретной feature (нанять JUNIOR по ФОП 2, открыть филиал, перейти на новый налоговый режим).

**Steps (Mode A):**

1. **PM Mode 5 — Mode A handler:**
   - Создаёт `docs/specs/tasks/task-legal-<slug>.md` по шаблону `templates/task-legal.md.tpl` — заполняет `## Контекст` + `## Вопрос`.
   - Dispatches Legal через snippet «Legal — Mode A» из `pm-snippets.md`.
2. **Legal agent** — читает knowledge base (`docs/legal/*`), при необходимости WebSearch'ит recent UA legal updates (ПКУ, ЗУ 2074-IX, НБУ memorandum), append'ит `## Ответ юриста` в task-файл по структуре из `legal.md` (TL;DR + Confidence + полный анализ + citations + escalation triggers).
3. **PM** — читает результат, показывает USER:
   - TL;DR
   - Confidence (HIGH/MED/LOW)
   - 1-2 ключевые recommendation
   - Если Confidence: LOW + action-критичная decision → explicit warning: «нужна верификация у human-юриста ДО action».
4. **PM** — записывает event `legal_dispatched` с `mode: consult`, `target: task-file` в `pm-state.json`.
5. После archive task — task-файл уходит в `docs/specs/tasks/archive/`.

**Steps (Mode D):**

1. **PM Mode 5 — Mode D handler:**
   - Создаёт `docs/specs/legal-consultations/YYYY-MM-DD-<slug>.md` с `## Вопрос` + `## Контекст`.
   - Dispatches Legal через snippet «Legal — Mode D» из `pm-snippets.md`.
2. **Legal agent** — анализирует strategic вопрос (deeper context, often WebSearch для recent rulings/precedents), append'ит `## Ответ юриста`.
3. **PM** — показывает USER TL;DR + Confidence + 1-2 ключевые recommendation + **полный путь к файлу для деталей**.
4. **Permanent reference** — файл остаётся в `docs/specs/legal-consultations/`, не удаляется (это лог стратегических решений).

### 3.4 Workflow D — Architecture decision

**Триггер:** «Какой подход взять для Y» (где-то требуется trade-offs analysis). Примеры: «Стейт через context или Redux», «WebSocket или polling», «Migration strategy для X».

**Steps:**

1. **PM dispatches `architect`** (ECC) — задача: trade-offs analysis (3-5 options + pros/cons + recommendation).
2. **Architect** — research через `context7` MCP (NestJS / TanStack / Drizzle docs), `ast-grep` для существующих patterns в codebase, выдаёт ADR draft в `docs/architecture/2026-XX-XX-<slug>.md` с:
   - Executive summary (TL;DR)
   - Options considered
   - Trade-offs matrix
   - Recommendation + justification
   - Open questions для USER
3. **USER (ты)** — decision: «do option B» или «revise [aspect]».
4. **PM** — implementation phase: разбивает на task-файлы → dispatches Coder / DevOps согласно plan.

**Пример (real):** `docs/architecture/2026-05-31-ecc-migration-design.md` (этот ADR) — был написан Architect в этом workflow.

### 3.5 Workflow E — Refactoring / cleanup

**Триггер:** «Этот код shaped плохо, нужно почистить» (dead code, duplication, naming, structure).

**Steps:**

1. **PM dispatches `refactor-cleaner`** (ECC, если приходит в `developer` profile) или **Coder + skill `superpowers:simplify`** — для cleanup без feature change.
2. **PM dispatches TypeScript reviewer** (ECC) — для validation что types preserved + no regression.
3. **PM dispatches code-reviewer** (ECC) — для общего code quality check.
4. **Quick PR** — typically skip Reviewer round 2 + AutoTest (no behavior change). Direct `merge-approved` после User Testing визуальной верификации (если UI involved) или после lint+typecheck+test green (если backend-only).

**Особый случай:** «рефакторинг страниц» — в нашем lexicon это **UI/UX visual change**, НЕ code-level DRY cleanup. См. memory item `feedback_refactor_pages` — сначала screenshot через Playwright, потом обсуждение визуальных правок.

### 3.6 Workflow F — Documentation update

**Триггер:** «Docs устарели после feature X» или «Codemap нужен refresh».

**Steps:**

1. **PM dispatches `doc-updater`** (ECC, если есть) — refreshes:
   - `CLAUDE.md` (root) — если фазы / business rules / RBAC изменились.
   - `docs/agents/project-state.md` — phases / migrations / shared schemas inventory / tech gotchas.
   - `README.md` в затронутых модулях.
2. **Direct PR** — typically skip Reviewer (docs-only change, no executable code). PM проверяет diff визуально и ставит `merge-approved` напрямую.

**Альтернатива (если `doc-updater` не приходит в profile):** PM сам обновляет `docs/business/` (zone-of-write allows) или dispatches Coder с task-файлом «обнови `docs/business/modules/<X>.md` per spec [...]».

---

## Section 4 — Slash commands {#section-4}

После Phase 5+ user может invoke common workflows одной строкой вместо writing task-файла. Slash commands — это shortcut для `Skill` invocation или predefined `Agent` dispatch.

**Confidence:** medium — точный список commands в `developer` profile подтверждается Phase 1 spike. Ниже — based on ECC docs reference + сценарии типичные для нашего проекта.

### 4.1 Core slash commands (ожидаемые из ECC `developer` profile)

| Command                           | Что делает                                                                                                                                             | Когда использовать                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `/plan <feature>`                 | Invokes `planner` (ECC) для декомпозиции на atomic tasks с dependencies + estimated effort. Output — task draft, который PM конвертирует в task-файлы. | Сложная фича (4+ files, multiple agents). Альтернатива тратить PM cycles на decomposition.                       |
| `/tdd <bug-or-feature>`           | Invokes `tdd-guide` (ECC) — пишет failing test FIRST, потом dispatch Coder для GREEN implementation.                                                   | **Любой** bug fix + любой feature с non-trivial behavior. Default workflow для bugs.                             |
| `/code-review [<PR>]`             | Invokes `code-reviewer` (ECC) manually на текущий diff (если без PR) или на specific PR.                                                               | Quick check без full Reviewer pipeline. Polling работы Coder без gate'а.                                         |
| `/security-review [<PR>]`         | Invokes `security-reviewer` (ECC) — OWASP Top 10 scan, npm audit, secret leak check, auth/finance critical paths.                                      | Перед merge финансовых / auth / wallet changes. Не дожидаясь PM Mode 2 auto-dispatch.                            |
| `/e2e [<spec-file>]`              | Runs Playwright e2e tests локально через `pnpm --filter @crm/e2e test`. Optional filter — конкретный spec.                                             | Перед push (memory item `feedback_e2e_before_push` — обязательно), после UI batch fix.                           |
| `/refactor-clean [<file-or-dir>]` | Invokes `refactor-cleaner` (ECC) — dead code, duplication, unused imports.                                                                             | После завершения фичи перед merge. Cleanup phase.                                                                |
| `/orchestrate <complex-task>`     | Invokes `loop-operator` (ECC) для multi-agent coordination в autonomous loop с stop conditions.                                                        | Long-running task где user хочет fire-and-forget (PM dispatches multiple agents sequentially based on outcomes). |
| `/learn`                          | Invoke `superpowers:using-superpowers` + capture session lessons. Append в `memory/<role>/lessons.md`.                                                 | После merged PR — explicit lesson capture (вместо PM auto-append).                                               |
| `/skill-create <topic>`           | Invoke `superpowers:writing-skills` или ECC `skill-creator` — bootstrap new skill в `skills/<topic>/SKILL.md`.                                         | Когда recurring lesson (5+ повторений в lessons.md) promotable в durable skill.                                  |

### 4.2 Project-specific slash commands (custom, per ADR Section 4.7)

Эти commands создаются как part of Phase 5 (4 custom skills) или Phase 6:

| Command                                               | Что делает                                                                                                                                        | Где определён                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `/legal-consult <topic>`                              | Invokes Legal Mode A — создаёт task-legal-\* + dispatches Legal agent                                                                             | Custom skill `legal-mode-orchestration` (Phase 5)                 |
| `/legal-strategic <topic>`                            | Invokes Legal Mode D — создаёт consultation file в `docs/specs/legal-consultations/`                                                              | Same skill                                                        |
| `/user-testing <pr_branch>`                           | Запускает `scripts/pm/prep-user-testing.sh <pr_branch>` через `run_in_background=True`. После старта — печатает Serveo URL для USER.              | Custom skill `user-testing-tunnel` (Phase 5, per ADR Section 4.7) |
| `/pm-state`                                           | Печатает summary текущего `pm-state.json` (active tasks, blocked, pending_fixes, blocking_issue)                                                  | Custom skill `pm-mode-orchestration` (Phase 5)                    |
| `/coder-recover`                                      | Read `.claude/coder-activity.log` last 5 INTENT + 10 edits → diagnose if hung → recovery flow per `pm-snippets.md` секция «Coder hung — recovery» | Custom skill `dev-flow-resilience` (Phase 5)                      |
| `/cross-session-wakeup <delay-min> <prompt-template>` | Generate parameters через `scripts/pm/pm-schedule.sh` + call `mcp__scheduled-tasks__create_scheduled_task`                                        | Custom skill `cross-session-orchestration` (Phase 5)              |

**Note:** точный синтаксис slash commands определяется ECC harness conventions — Phase 1 spike подтвердит.

### 4.3 Built-in slash commands (Claude Code CLI)

Эти **уже доступны** (без migration) — built into harness:

| Command   | Что делает                            |
| --------- | ------------------------------------- |
| `/help`   | Список доступных команд               |
| `/clear`  | Очистить chat history (новая session) |
| `/config` | Settings UI                           |
| `/agents` | List active agents в session          |

---

## Section 5 — Skills {#section-5}

Skills — **durable workflow patterns** в format `skills/<topic>/SKILL.md`. Они invokable напрямую через `Skill` tool, или auto-loaded когда agent matches trigger description.

**ECC philosophy** (per ADR Section 4.3): skills — primary knowledge unit, lessons.md — secondary (append-log для new observations, периодически consolidated в skills через `anthropic-skills:consolidate-memory`).

### 5.1 Stack-relevant skills (ожидаемые из ECC `developer` profile, Phase 1 spike confirms)

Эти skills _уже существуют_ в ECC reference catalog и подгружаются как часть `developer` install profile (Phase 1).

| Skill                        | Что внутри                                                                                                 | Когда invoke                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `skills/nestjs-patterns`     | NestJS 11 conventions: модули, DTO через Zod, RolesGuard, JwtGuard, exception filters, Drizzle integration | Перед написанием нового NestJS module / controller / service |
| `skills/react-patterns`      | React 18 hooks, context, suspense, error boundaries, performance patterns                                  | Перед написанием нового React component                      |
| `skills/react-testing`       | RTL + Vitest patterns, userEvent quirks (delay:null per `feedback_test_fixing`), act() warnings            | Перед написанием unit-теста на React component               |
| `skills/typescript-strict`   | `exactOptionalPropertyTypes`, type narrowing, satisfies, branded types                                     | При TypeScript ошибках или strict mode debugging             |
| `skills/playwright-patterns` | Page Object pattern, fixtures, retry strategy, screenshot diff testing                                     | Перед написанием E2E spec                                    |

### 5.2 Cross-cutting ECC skills (Phase 1 install)

| Skill                                        | Что внутри                                              | Когда invoke                                          |
| -------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `superpowers:using-superpowers`              | Boot-strap для всех superpower skills                   | Сессия начинается (always)                            |
| `superpowers:brainstorming`                  | Структурированный brainstorm перед creative work        | Любая creative задача                                 |
| `superpowers:writing-plans`                  | Plan template + decomposition                           | Multi-step task перед implementation                  |
| `superpowers:test-driven-development`        | RED→GREEN→IMPROVE workflow                              | **Любая** feature/fix перед implementation            |
| `superpowers:systematic-debugging`           | Hypothesis-driven debugging                             | Bug / test failure / unexpected behavior              |
| `superpowers:verification-before-completion` | Pre-completion verification checklist                   | Перед PR / completion claim                           |
| `superpowers:security-review`                | OWASP Top 10 + dependency check                         | PR трогает auth / finance / wallets / smart-contracts |
| `superpowers:requesting-code-review`         | Reviewer dispatch protocol                              | Начало каждого Reviewer cycle                         |
| `superpowers:receiving-code-review`          | How to respond to review feedback (push back vs accept) | Получение review feedback                             |
| `superpowers:simplify`                       | Cleanup code post-implementation                        | После написания кода                                  |
| `superpowers:using-git-worktrees`            | Worktree workflow для parallel work                     | PM dispatches Coder isolated                          |
| `superpowers:executing-plans`                | Multi-step plan execution                               | PM Mode 1 Step 4 (dispatch)                           |
| `superpowers:dispatching-parallel-agents`    | Parallel `Agent()` patterns                             | PM multi-task dispatch                                |
| `superpowers:finishing-a-development-branch` | Pre-PR checklist                                        | Coder перед opening PR                                |
| `frontend-design:frontend-design`            | Distinctive UI design (non-generic)                     | Новая страница / сложный UI                           |
| `anthropic-skills:consolidate-memory`        | Lessons rotation + skill promotion                      | После merged PR при threshold 20 строк                |

### 5.3 Project-specific skills (Phase 4-5 created)

Эти **создаются нами** в Phase 4 (lessons → skills) + Phase 5 (custom for our patterns):

| Skill                                | Что внутри                                                                                                                                                                                             | Phase                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `skills/recruiting-domain-rules`     | Business invariants: max 1 active JUNIOR / project, ACCOUNTANT auto-in-team, max 10 teams, JUNIOR derived from `project_members`, SENIOR can't be deleted (only team), team_members не содержит JUNIOR | Phase 4                                               |
| `skills/ua-tax-fop`                  | UA ФОП 2-3 групи tax rules, edge cases (subject change, recharacterization risk, USDT income treatment)                                                                                                | Phase 4 (stub) — fill при first relevant consultation |
| `skills/ua-cfc-rules`                | CFC ст. 39² ПКУ, controlled foreign company обязательства                                                                                                                                              | Phase 4 (stub)                                        |
| `skills/ua-nda-ip`                   | NDA / IP clauses для UA контрактов, non-circumvention enforceability                                                                                                                                   | Phase 4 (stub)                                        |
| `skills/ua-gdpr-personal-data`       | ЗУ 2297-VI + GDPR territorial scope для CRM passport/wallet/email storage                                                                                                                              | Phase 4 (stub)                                        |
| `skills/ua-crypto-banking`           | НБУ memorandum (USDT caps), ЗУ 2074-IX virtual assets, bank/crypto interaction limits                                                                                                                  | Phase 4 (stub)                                        |
| `skills/cross-session-orchestration` | `mcp__scheduled-tasks` + `pm-schedule.sh` workflow, Layer 1 vs Layer 2 decision matrix                                                                                                                 | Phase 5                                               |
| `skills/user-testing-tunnel`         | Serveo SSH tunnel + production build + Dev Login flow, troubleshooting (build/DB/tunnel/port-clash)                                                                                                    | Phase 5                                               |
| `skills/dev-flow-resilience`         | D1-D4 fixes summary, intent markers, pre-push gate, AC verification, watchdog recovery                                                                                                                 | Phase 5                                               |
| `skills/pm-mode-orchestration`       | PM Mode 1-5 state-machine, transitions, when to enter each mode                                                                                                                                        | Phase 5                                               |

### 5.4 Как invoke skill

```python
Skill("nestjs-patterns")
# или с argument:
Skill("anthropic-skills:consolidate-memory", "after-merge-batch")
```

Skill output — markdown с workflow / examples / triggers. Agent читает + применяет. Skills durable — не зависят от session memory.

---

## Section 6 — Hooks {#section-6}

Hooks — **автоматически срабатывающие** перехватчики на tool invocations. После Phase 2 (migration to ECC JSON-matcher format) они становятся:

- **Specific** — fire'ятся только когда matcher matches (vs broad `Bash` / `Edit|Write`).
- **Composable** — multiple hooks могут react на тот же event без conflicting.
- **Centralized** — registered в `.claude/settings.json` (ECC format).

### 6.1 Hooks после Phase 2

| Hook                                                                     | Trigger (matcher)                                                                                                  | Что блокирует / делает                                                                                                 | Как override (если можно)                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `safety` (port of `safety.sh`)                                           | `tool == "Bash" && command matches "<dangerous-pattern>"`                                                          | Blocks `rm -rf /`, `git push --force origin main`, etc. dangerous commands                                             | Cannot override без USER consent через explicit flag                                                                  |
| `block-production-edits` (zone-of-write)                                 | `tool in ["Edit","Write","MultiEdit","NotebookEdit"] && file_path matches "apps/\*\*                               | packages/\*\*" && agent != "coder"`                                                                                    | Blocks PM/Architect/Legal/etc. от editing production code. Только Coder allowed.                                      | `.claude/.allow-direct-edits` — **только для USER в его сессии**, не для agents |
| `coder-pre-push` (AC verification)                                       | `tool == "Bash" && command matches "git push"` + last commit branch matches `feature/* / fix/* / infra/* / test/*` | Blocks push если последний commit не содержит `ac_verified: N` marker                                                  | Доделать AC → честный commit с `ac_verified: 1,2,3`. **NEVER** `--no-verify` (per RULES.md §2.1 zero-tolerance)       |
| `eslint-feedback` (reduced scope per MCP-first)                          | `tool in ["Edit","Write"] && file_path matches "*.ts*"`                                                            | Triggers `mcp__eslint__lint-files` на changed file, surfaces remaining issues. Не блокирует — informational.           | Edit hook config в `.claude/settings.json`                                                                            |
| `russian-language-enforcement` (new — Phase 5 rule)                      | Per-agent system prompt directive                                                                                  | Не technical hook — это rule в agent prompts. Agent must respond in Russian (chat output, comments, task-files).       | N/A — это convention, не enforceable hook                                                                             |
| `continuous-learning` (ECC observer, Phase 2 spike confirms)             | `*` PreToolUse — pattern observer                                                                                  | Captures tool-use patterns для skill discovery. Informational, never blocks.                                           | Disable в settings.json если noise too high                                                                           |
| `dev-server-tmux-enforcement` (TBD if exists in ECC `developer` profile) | `tool == "Bash" && command matches "pnpm dev                                                                       | nest start --watch"`                                                                                                   | Routes dev server start через tmux session — prevents stale processes (memory item `feedback_post_feature_checklist`) | Phase 1 spike confirms availability                                             |
| `pre-push-verification-gate` (composite)                                 | `tool == "Bash" && command matches "git push"`                                                                     | Runs `pnpm test:unit && pnpm typecheck` локально перед push. Blocks если any failure (per `feedback_e2e_before_push`). | Доделать failing tests / fix types. Не override.                                                                      |

### 6.2 Hooks что были (deleted после Phase 6)

| Old (pre-migration)                       | Replaced by                                                                                      | Phase                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `.claude/hooks/safety.sh`                 | ECC JSON-matcher `safety` hook                                                                   | Phase 2 (coexistence 1 week) → Phase 6 delete |
| `.claude/hooks/block-production-edits.sh` | ECC JSON-matcher `block-production-edits`                                                        | Phase 2 → Phase 6 delete                      |
| `.claude/hooks/coder-pre-push.sh`         | ECC JSON-matcher `coder-pre-push`                                                                | Phase 2 → Phase 6 delete                      |
| `.claude/hooks/coder-progress-marker.sh`  | **REMOVED** if ECC `continuous-learning` covers (Phase 1 spike confirms) OR ECC PostToolUse port | Phase 2 (decision deferred to Phase 1 spike)  |
| `.claude/hooks/eslint-feedback.sh`        | ECC JSON-matcher `eslint-feedback` (reduced scope, MCP-first)                                    | Phase 2 → Phase 6 delete                      |

### 6.3 Когда hook блокирует — what to do

1. **Read error message** — ECC hooks выводят specific reason (e.g. «`ac_verified` marker missing in last commit»).
2. **Не bypass'ить через `--no-verify`** — это zero-tolerance (RULES.md §2.1). Реальные инциденты 2026-06-02: 3× за сессию.
3. **Fix root cause:**
   - AC marker missing → доделать AC → честный commit с `ac_verified: 1,2,3`.
   - Production edit blocked → создать task-файл для Coder (PM не редактирует код напрямую, per `pm.md` Зоны записи).
   - Dangerous command blocked → переписать команду без force-flags.
4. **Если hook misfire'ит** (false positive) — задача для DevOps: исправить matcher в `.claude/settings.json` + tests trigger conditions.

---

## Section 7 — Memory & lessons {#section-7}

Per `docs/agents/memory/README.md` (v2, 2026-06-02). Здесь — practical guide.

### 7.1 Где живут уроки

```
docs/agents/memory/
├── README.md          (конвенция)
├── coder/
│   ├── lessons.md          (active, ≤ 20 строк)
│   └── lessons.archive.md  (historical, full record)
├── autotest/
│   ├── lessons.md
│   └── lessons.archive.md
├── reviewer/
│   ├── lessons.md
│   └── lessons.archive.md
├── devops/
│   ├── lessons.md
│   └── lessons.archive.md
├── legal/
│   ├── lessons.md
│   └── lessons.archive.md
└── pm/
    ├── lessons.md
    └── lessons.archive.md
```

После Phase 4 (lessons → skills) — **дополнительно** появляются:

```
skills/
├── nestjs-patterns/SKILL.md      (ECC reference, Phase 1)
├── recruiting-domain-rules/SKILL.md  (Phase 4)
├── ua-tax-fop/SKILL.md           (Phase 4 stub)
├── cross-session-orchestration/SKILL.md  (Phase 5)
└── ...
```

### 7.2 Когда добавлять lesson

**После каждого merged PR (no exceptions)** — это PM workflow Mode 2 (completed):

```
<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic) <конкретный урок одной фразой>
```

**Хороший пример:**

```
2026-06-02 [P0] [task-pr74-pdf-refresh] (#visual-verify) PDF/SVG verified только через playwright screenshot — UTF-16 grep недостаточно для bodyflate-stream
```

**Плохой пример (не писать):**

```
2026-06-02 [P2] [task-X] Сделал задачу. Использовал TanStack Query.
```

### 7.3 Priority guide (rule of thumb)

- **P0** — критическое (data loss / security gap / repeat regression / отказ системы). Агент ОБЯЗАН прочитать при старте сессии.
- **P1** — важное (rework / увеличение раундов review / замедление пайплайна). Должен учитывать.
- **P2** — nice-to-know. Помогает оптимизировать, не блокирует.

Урок про **mechanism** (gate, label, hook) → P0
Урок про **safety/security/data** → P0
Урок про **regression-prevention** → P0 или P1
Урок про **process/communication** → P1
Урок про **optimization/style** → P2

### 7.4 Rotation flow (когда `lessons.md` достигает 20 строк)

PM invokes `anthropic-skills:consolidate-memory`:

1. **Skill анализирует** duplicates / упрощает / выделяет паттерны.
2. **P0 lessons (5+ повторений)** → promote в Golden rules соответствующего agent doc (`<agent>.md`).
3. **P1 lessons** → consolidate в `RULES.md` (если cross-agent) или `<agent>.md` (если agent-specific).
4. **P2 lessons** → archive в `lessons.archive.md`.

После Phase 4 — добавляется ещё один level:

5. **Topic cluster (≥3 lessons на одну тему)** → promote в `skills/<topic>/SKILL.md` (durable knowledge primitive).

### 7.5 Quarterly skill review process

Per ADR Section 7 (ECC version sync) + Phase 6 retrospective recommendation:

- **Каждый квартал** (или после major ECC release) — full review:
  - `skills/` directory — какие skills актуальны, какие stale.
  - `lessons.md` — какие выросли в topic cluster (promote к skill).
  - ECC upstream sync — merge новые patterns из `evergreen-claude-coding` upstream.
  - Update `RULES.md` per consolidated patterns.

### 7.6 Когда extract recurring lesson → permanent skill

**Триггер для promote (lesson → skill):**

- 5+ повторений того же patterns в lessons.md за последние 6 месяцев.
- Lesson — про **workflow/pattern** (не про one-off incident).
- Applicable for **multiple agents** или **multiple modules**.

**Steps:**

1. Identify cluster (через `anthropic-skills:consolidate-memory` или manual).
2. Invoke `superpowers:writing-skills` или ECC `skill-creator` для bootstrap.
3. Write `skills/<topic>/SKILL.md` per ECC format:
   - Frontmatter: `name` / `description` / `origin`
   - `## When to Activate` (trigger conditions)
   - `## Workflow` (step-by-step)
   - `## Tested examples` (real cases с outcomes)
4. PR — review focuses on accuracy + reusability.
5. После merge — lessons (которые promoted) move в `lessons.archive.md` с ссылкой на новый skill.

---

## Section 8 — Direct dispatch агентов (advanced) {#section-8}

Для tech-fluent user который хочет direct control без PM overhead. После Phase 3 — все ECC agents invokable через `Agent` tool напрямую.

### 8.1 Базовый pattern

```python
Agent(
  subagent_type="planner",  # или другой ECC agent
  description="Plan: <feature>",
  prompt="""Plan implementation of <feature>.
Context: <our project specifics>.
Output: atomic tasks with dependencies + effort estimate."""
)
```

**Параметры:**

- `subagent_type` — имя agent'a из ECC `AGENTS.md` catalog (per ADR Section 2 + ECC reference).
- `description` — human-readable, для отображения в session UI.
- `prompt` — task для agent'a (с context).
- `isolation="worktree"` — для write-agents (Coder, DevOps, AutoTest, Architect) — gives isolated worktree.
- `run_in_background=True` — для long-running agents (Coder 15-40 мин), background notification when complete.

### 8.2 Per-scenario agent reference (post Phase 6)

| Scenario                             | Agent                                   | Когда invoke напрямую (без PM)                                                                            |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Decompose complex task into plan     | `planner` (ECC)                         | Когда задача ясна на high-level, но decomposition не очевидна. Output — plan draft.                       |
| Architecture design with trade-offs  | `architect` (ECC)                       | Open design question с multiple valid options. Output — ADR-style document.                               |
| Write failing test first (RED phase) | `tdd-guide` (ECC)                       | Любой bug fix. Любая non-trivial feature. **Default** для bugs.                                           |
| Code review one PR                   | `code-reviewer` (ECC)                   | Quick check без full Reviewer gate.                                                                       |
| Security scan на финансы/auth        | `security-reviewer` (ECC)               | Перед merge финансовых/auth изменений.                                                                    |
| Diagnose build failure               | `build-error-resolver` (ECC)            | `pnpm build` падает с unclear error.                                                                      |
| Tune harness config                  | `harness-optimizer` (ECC)               | Settings.json optimization, hook tuning.                                                                  |
| TypeScript-specific review           | `typescript-reviewer` (ECC)             | Strict mode issues, type narrowing problems.                                                              |
| Run E2E (or fix flaky)               | `e2e-runner` (ECC, if in profile)       | Spec changes, flaky test debugging.                                                                       |
| Refactor cleanup                     | `refactor-cleaner` (ECC, if in profile) | Post-feature dead code / duplication cleanup.                                                             |
| Docs refresh                         | `doc-updater` (ECC, if in profile)      | После feature merge — refresh codemaps + READMEs.                                                         |
| Auto-loop coordination               | `loop-operator` (ECC)                   | Long-running multi-agent task с stop conditions.                                                          |
| Skill creation                       | `skill-creator` (ECC)                   | Promote lesson cluster в durable skill.                                                                   |
| Legal consultation                   | `Legal` (custom, our)                   | UA jurisdictional question. PM Mode 5 normally, но direct dispatch tоже valid.                            |
| Full Coder cycle                     | `Coder` (custom, our)                   | Только через PM (worktree isolation + task-файл pattern). Direct dispatch — only for hot-fix emergencies. |

### 8.3 Anti-patterns (когда NOT direct dispatch)

- **Не bypass'ить PM для standard feature flow** — PM tracks state (`pm-state.json`), dispatches Reviewer parallel, manages User Testing. Bypass = потеря state + missing review gate.
- **Не invoke Coder напрямую для production code** — worktree isolation требует PM-managed dispatch. Direct = риск broken state в текущем worktree.
- **Не invoke multiple write-agents одновременно без `isolation="worktree"`** — conflict в working directory.

### 8.4 Когда полезно direct dispatch

- **Тebе нужен быстрый ответ** (planner / architect) без full task-file overhead.
- **Diagnostic check** перед PM full cycle (security-reviewer на draft PR).
- **Skill / pattern lookup** (skill-creator, harness-optimizer).
- **Emergency hot-fix** (Coder с минимальным task description).

---

## Section 9 — Decision tree {#section-9}

Quick reference: какой запрос → какой agent / sequence.

### 9.1 Главная таблица

| Запрос USER                                            | Agent (или sequence)                                                                                                                                                                                 | PM Mode                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| «Хочу новую feature X»                                 | BA (ты) пишешь brief → PM Mode 1 → planner → tdd-guide → Coder + typescript-reviewer parallel → code-reviewer + (опц.) security-reviewer + Legal Mode B (если critical zone) + AutoTest + e2e-runner | Mode 1 → 2 → 4                           |
| «Что-то не работает / regression»                      | tdd-guide (RED) → Coder (GREEN + IMPROVE) → code-reviewer                                                                                                                                            | Mode 2.A (если blocked) или quick Mode 2 |
| «Legal / налоговый вопрос про текущую фичу»            | PM Mode 5 Mode A → Legal                                                                                                                                                                             | Mode 5 (A)                               |
| «Strategic legal вопрос (нанять, открыть, перейти на)» | PM Mode 5 Mode D → Legal                                                                                                                                                                             | Mode 5 (D)                               |
| «Какой подход взять для Y»                             | architect → trade-offs ADR → USER decides → implementation phase                                                                                                                                     | Mode 1 (после decision)                  |
| «Code quality concern»                                 | code-reviewer (+ опц. security-reviewer если critical zone)                                                                                                                                          | Mode 2.D (если BLOCK)                    |
| «Build error непонятный»                               | build-error-resolver                                                                                                                                                                                 | (внутри Mode 1 dispatch)                 |
| «Refactor запрос»                                      | refactor-cleaner + typescript-reviewer + code-reviewer                                                                                                                                               | Mode 1 quick cycle                       |
| «E2E test broken (flaky)»                              | e2e-runner → AutoTest (fix spec) → re-run                                                                                                                                                            | Mode 2.C                                 |
| «Docs outdated»                                        | doc-updater (если есть) ИЛИ PM updates `docs/business/` напрямую ИЛИ Coder task                                                                                                                      | Mode 1                                   |
| «Migration plan / architecture change»                 | architect → ADR → USER decides → multi-phase plan                                                                                                                                                    | Mode 1                                   |
| «Harness/settings tuning»                              | harness-optimizer                                                                                                                                                                                    | (через PM или direct)                    |
| «Lesson promote в skill»                               | skill-creator или `superpowers:writing-skills`                                                                                                                                                       | Phase 4 ongoing                          |
| «PR висит / Coder hung»                                | PM Mode 2.E (state sync) → `coder-recover` flow → restart                                                                                                                                            | Mode 2.E                                 |
| «User Testing tunnel упал»                             | PM checks `/tmp/pm-{api,web}.log` + Serveo log → classify (build/DB/tunnel/port-clash) → fix-task для Coder/DevOps → re-try                                                                          | Mode 4 (Шаг 0 recovery)                  |

### 9.2 Critical zones decision matrix

| PR diff matches                                                 | MUST dispatch                                                                        | Optional dispatch                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| `apps/api/src/finance/**` или `apps/api/src/payments/**`        | code-reviewer + security-reviewer + Legal Mode B                                     | AutoTest (если no e2e в diff)             |
| `apps/api/src/auth/**`                                          | code-reviewer + security-reviewer + Legal Mode B (для passport/wallet/personal data) | —                                         |
| `apps/api/src/documents/**` (S3 / passport storage)             | code-reviewer + security-reviewer + Legal Mode B                                     | —                                         |
| `packages/shared/src/schemas/{auth,finance,users,documents}.ts` | code-reviewer + Legal Mode B                                                         | typescript-reviewer                       |
| Smart contracts / USDT paths                                    | code-reviewer + security-reviewer + Legal Mode B                                     | architect (если design change)            |
| `.github/workflows/**`                                          | code-reviewer + DevOps review                                                        | security-reviewer (если secrets handling) |
| `apps/api/drizzle/migrations/**`                                | code-reviewer + DevOps (smoke test fresh DB)                                         | architect (если breaking change)          |
| `apps/web/**` (UI only, no API)                                 | code-reviewer + AutoTest                                                             | —                                         |
| `docs/**` only                                                  | (skip review)                                                                        | doc-updater                               |
| `CLAUDE.md` / `RULES.md`                                        | architect                                                                            | —                                         |

Per `docs/agents/pm.md` Mode 2 — auto-dispatch decisions encoded в event table.

### 9.3 Confidence escalation flow

Per ADR Section 4 + Legal escalation zones:

```
Confidence: HIGH    → Standard flow, no extra escalation
Confidence: MED     → PM notes в response, user может ignore
Confidence: LOW     → PM **обязан** уведомить USER: «Verify с human-юристом / specialist ДО action»
Confidence: LOW + hard zone → PM записывает `legal_escalated_to_human` event, НЕ dispatch'ит auto-actions, ждёт USER decision
```

**Hard zones** (per `docs/legal/cross-cutting/escalation-zones.md`):

- UA Tax compliance + recharacterization risk (ФОП → labor)
- CFC obligations (controlled foreign company)
- Crypto/banking caps (НБУ memorandum)
- Personal data (GDPR territorial + UA ЗУ 2297-VI)
- Contract enforceability (NDA, IP, non-circumvention)

---

## Section 10 — FAQ + gotchas {#section-10}

### 10.1 «Я хочу bypass agent» — когда и как

**Когда правильно bypass:**

- Hot-fix prod (1-2 line typo, обнаружен via user error)
- Documentation typo
- Скрипт config tweak (settings.json, не code)

**Как:**

- Создать `.claude/.allow-direct-edits` (escape hatch — **только в твоей USER session, не для agents**, per `pm.md` Зоны записи + RULES.md §5).
- Direct Edit/Write через native tools.
- Commit + push через standard git flow.

**Когда WRONG bypass:**

- «Quick fix 30 секунд» feature work — это **anti-pattern** (per `pm.md` Зоны записи). 10 минут overhead на task-файл — признак правильной discipline.
- Обход AC verification через `--no-verify` — **NEVER** (RULES.md §2.1 zero-tolerance). Real incidents 2026-06-02: 3× за сессию.
- Обход zone-of-write через manual edit когда agent должен это делать.

### 10.2 «Agent ошибся / сделал плохо» — recovery patterns

| Symptom                                                | Recovery                                                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Coder написал хуйню (broken code, не работает)         | PM Mode 2.D (Reviewer Verdict: BLOCK) → fix-task для Coder. Если `review_rounds >= 3` — STOP, эскалация USER                                    |
| Reviewer false-positive (approval хорошего PR с issue) | USER в чате «Reviewer пропустил X» → PM создаёт fix-task → Coder fix → re-review                                                                |
| AutoTest no-op (0 spec'ов добавлено)                   | PM создаёт новый task с **картой селекторов** → перезапускает AutoTest. Per `pm.md` Mode 2 (autotest no-op handler)                             |
| Legal Confidence: LOW в hard zone                      | PM **уже** записал `legal_escalated_to_human`, **не** dispatch'ит auto-actions, ждёт USER. USER решает: verify с human-юристом или принять risk |
| PM запутался (state desync)                            | USER «прочитай pm-state.json и опиши текущее состояние» → PM Mode 3 (resume) → manual reconciliation                                            |
| Hung Coder (>10 мин silence)                           | PM Mode 2.E → `coder-recover` flow → restart с last milestone                                                                                   |

### 10.3 «Слишком много dispatch overhead» — когда NOT to use agents

- **Trivial typo** в comment / log message → direct edit (USER, escape hatch).
- **Config tweak** в settings.json / `.gitignore` → direct edit.
- **Quick question** «как работает X» — не нужен dispatch, USER читает code через MCP `ast-grep` / `context7`.
- **Pure docs read** (понять architecture) → USER читает напрямую.

**Когда оверхед dispatch _оправдан_:**

- Любое изменение в `apps/**` / `packages/**` — production code.
- Любой write на больше чем 1 file.
- Любой change с testable behavior.
- Любой decision с trade-offs.

### 10.4 «Conflict между agents» — кто wins (priority order)

| Conflict                                                                | Winner                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Coder vs Reviewer (Coder push, Reviewer BLOCK)                          | Reviewer wins, fix-task для Coder                                                                                     |
| Coder vs AutoTest (оба пишут в `apps/e2e/`)                             | AutoTest — zone-of-write owner for `apps/e2e/tests/*.spec.ts`. Coder должен передать через `.blocked.md` или fix-task |
| AutoTest vs Reviewer (test wrong vs code wrong)                         | PM Mode 2.C classification: код → Coder fix, тест → AutoTest fix                                                      |
| Architect vs Coder (design recommendation contradicts existing pattern) | USER decides. Architect output — recommendation, не mandate.                                                          |
| Legal vs Coder (Legal flagged risk, Coder reluctant)                    | USER decides — Legal info-only (label `legal-noted`), не gate. USER можно либо принять risk либо отменить feature     |
| Reviewer vs Security-reviewer (code OK, security issue)                 | Security wins — `Verdict: BLOCK`, fix-task                                                                            |

### 10.5 «Запросить мнение human professional» — escalation patterns

| Domain                      | Когда                                                                                         | Кому                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Legal (jurisdictional)      | Confidence: LOW в hard zone (UA tax / CFC / crypto / personal data / contract enforceability) | UA-licensed lawyer (юрист по UA праву)                               |
| Security audit (production) | Перед production launch (Phase 8+)                                                            | External security audit firm                                         |
| Financial compliance        | Доход > FOP threshold, ТОВ transition decision                                                | UA tax consultant (CPA / податковий радник)                          |
| Smart-contract audit        | Phase 8 USDT contract deployment                                                              | Solidity audit firm (Trail of Bits / Consensys Diligence equivalent) |
| GDPR compliance             | EU user data processing                                                                       | Privacy lawyer + DPO consultation                                    |

### 10.6 «Pause migration mid-phase» — как

- **Stop dispatch Architect** — не запускать new Phase до approval.
- **Coexistence preserved** — все интермediate phases оставляют old structure intact (Phase 2: hooks coexist 1 week; Phase 3: agents в `_legacy/`; Phase 6 only deletes).
- **Rollback per-phase** — каждая phase PR имеет explicit Rollback Strategy в ADR Section 6.
- **State sync** — `pm-state.json` capture'ит migration progress, можно resume.

### 10.7 «Откатить assistance change» — rollback granularity

| Granularity     | Как                                                                                 |
| --------------- | ----------------------------------------------------------------------------------- |
| Single PR       | `git revert <commit>` на main, PR closed                                            |
| Single Phase    | All phase PRs revert in reverse order                                               |
| Multiple Phases | Sequential revert per Phase ADR Rollback Strategy                                   |
| Full migration  | Per Phase 6 ADR Rollback Strategy — legacy files restored from `migration-archive/` |

### 10.8 «Контролировать token usage» — best practices

- **PM пишет `pm-state.json` минимально** — events only, no verbose context dumps.
- **Agent prompts**: используй reference (e.g. «Прочитай docs/agents/coder.md») а не inline (full prompt каждый раз).
- **Background dispatch** — не chat blocking, не дублирует context до notify.
- **Skill invocations** — durable knowledge, не дублирует на каждый agent dispatch.
- **MCP first** — token-efficient vs reading whole files (e.g. `mcp__postgres__query` vs reading `schema.ts`).
- **lessons.md ≤ 20 строк** — rotation предотвращает unbounded context growth.

### 10.9 «Что если ECC не приходит с expected agent / skill»

**Phase 1 spike** подтверждает фактический content `developer` install profile. Если agent/skill missing:

- **Сценарий A** — agent существует в ECC но не в `developer` profile → install с `--with-extras <agent-name>` (per ECC `REPO-ASSESSMENT.md`).
- **Сценарий B** — agent не существует в ECC catalog → keep custom (если уже было custom) или skip (если был optional).
- **Сценарий C** — skill missing → создать custom в Phase 5 (per ADR Section 4.7 — 4 custom skills already planned).

### 10.10 «Cross-harness portability — когда realistic»

ADR Section 6 Phase 5 создаёт **placeholders** (`.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.zed/`). Реальная portability:

- **Phase 7+** (post-migration, не в текущем 6-9 week plan).
- Требует ECC patterns adoption в каждом harness — Codex / Cursor / Gemini не одинаково support'ят `agent.yaml` manifests.
- Realistic timeline — 2027+ при значимом ECC community adoption.
- Today's value — **future-proofing infrastructure**, не immediate capability.

---

## Section 11 — Quick start «первые 5 минут после Phase 6» {#section-11}

После того как Phase 6 merge'нут и migration complete — топ 5 вещей сделать сразу:

### Step 1 — Verify ECC install

```bash
# Check pin is honored
cat ecc-pin.txt
# Expected: ECC tag SHA (e.g. v2.0.0-rc.1 commit SHA)

# Check reference dirs present
ls -d agents/ skills/ hooks/ rules/ manifests/ mcp-configs/ 2>/dev/null || \
  ls -d .claude/ecc/agents/ .claude/ecc/skills/ 2>/dev/null
# (depending on Q6 outcome — root vs .claude/ecc/)

# Check no regression in existing tests
pnpm test
pnpm typecheck
```

**Если что-то missing** — Phase 1 install не завершился полностью. Read `docs/architecture/2026-XX-XX-ecc-migration-retrospective.md` (Phase 6 deliverable) для details.

### Step 2 — List available agents

```python
# В Claude Code session:
Skill("anthropic-skills:using-superpowers")
# (bootstrap)

# List ECC agents:
Bash("ls agents/ 2>/dev/null || ls .claude/ecc/agents/ 2>/dev/null")
```

Или через `/agents` slash command (if registered).

**Expected output** — список ~10-15 agent files:

- `planner.md`, `architect.md`, `code-reviewer.md`, `security-reviewer.md`, `tdd-guide.md`, `typescript-reviewer.md`, `build-error-resolver.md`, `harness-optimizer.md`, `loop-operator.md`, plus our custom: `pm.md`, `coder.md`, `autotest.md`, `devops.md`, `legal.md`, `ba.md`.

### Step 3 — Try a slash command на small change

Найди small PR (1-2 file change, no critical zone):

```
/code-review
```

Если работает — agent dispatches, читает diff, выдаёт review. Если нет — Phase 5 slash command registration incomplete.

**Альтернатива** (если slash command не зарегистрирован):

```python
Agent(
  subagent_type="code-reviewer",
  description="Manual code-reviewer test",
  prompt="Review the diff in current branch vs main. Report issues by severity."
)
```

### Step 4 — Trigger TDD workflow

Создай тривиальный bug fix scenario:

```
/tdd "fix typo в /api/users response"
```

Или manually:

```python
Agent(
  subagent_type="tdd-guide",
  description="TDD: typo fix",
  prompt="""Write a failing test that catches typo 'usrname' instead of 'username' in /api/users response.
Repo: yaremenko-maksym/CheekyCheeseIT_CRM
Branch: main"""
)
```

Verify: agent создал failing test → spec runnable → RED phase visible. Это validate'ит TDD-guide working.

### Step 5 — Browse skills catalog

```bash
ls -la skills/ 2>/dev/null || ls -la .claude/ecc/skills/ 2>/dev/null
```

**Expected** — ~10-15 skill directories, each с `SKILL.md`. Read interesting ones:

- `skills/nestjs-patterns/SKILL.md` — NestJS conventions.
- `skills/recruiting-domain-rules/SKILL.md` — наши business invariants.
- `skills/ua-tax-fop/SKILL.md` — placeholder для UA tax knowledge.

**Try invoke:**

```python
Skill("nestjs-patterns")
```

Output — markdown content. Use в next dispatch как context.

### Step 6 (bonus) — Verify cross-harness placeholders

```bash
ls -d .codex/ .cursor/ .gemini/ .opencode/ .zed/ 2>/dev/null
cat .codex/README.md 2>/dev/null
```

Expected — placeholder dirs с README explaining «not active yet, Phase 7+».

### Step 7 (bonus) — Try Legal consultation flow

В chat:

```
USER: спроси юриста — можно ли S3 хранить passport scans без шифрования для UA users
```

PM Mode 5 Mode A:

1. Создаёт `docs/specs/tasks/task-legal-passport-s3-encryption.md`
2. Dispatches Legal через snippet «Legal — Mode A»
3. Legal анализирует (ЗУ 2297-VI personal data + GDPR territorial + AWS encryption defaults)
4. Возвращает TL;DR + Confidence + recommendation
5. PM показывает summary с warning если Confidence: LOW

Validates: Legal Mode A pipeline working post-migration.

---

## Appendix A — Cross-references

| Topic                                                        | Source                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Full migration timeline + per-phase AC                       | [ADR Section 6](2026-05-31-ecc-migration-design.md#section-6--phase-plan-0--6)                       |
| Per-component mapping (Adopt / Adapt / Keep custom / Remove) | [ADR Section 2](2026-05-31-ecc-migration-design.md#section-2--per-component-mapping)                 |
| Identified gaps + local adaptations                          | [ADR Section 4](2026-05-31-ecc-migration-design.md#section-4--identified-gaps--local-adaptations)    |
| Risk matrix                                                  | [ADR Section 5](2026-05-31-ecc-migration-design.md#section-5--risk-matrix)                           |
| ECC version sync policy                                      | [ADR Section 7](2026-05-31-ecc-migration-design.md#section-7--ecc-version-pin--upstream-sync-policy) |
| Open Questions resolution                                    | [ADR Section 9](2026-05-31-ecc-migration-design.md#section-9--open-questions-for-user)               |
| Legal agent design                                           | [`2026-05-31-legal-agent-design.md`](2026-05-31-legal-agent-design.md)                               |
| Architect discovery report                                   | [`2026-05-31-architect-discovery-report.md`](2026-05-31-architect-discovery-report.md)               |
| Dev-flow RCA (D1-D4 fixes)                                   | [`2026-05-23-dev-flow-rca.md`](2026-05-23-dev-flow-rca.md)                                           |
| Current PM agent (Mode 1-5)                                  | [`../agents/pm.md`](../agents/pm.md)                                                                 |
| PM dispatch snippets (on-demand)                             | [`../agents/pm-snippets.md`](../agents/pm-snippets.md)                                               |
| Cross-agent rules                                            | [`../agents/RULES.md`](../agents/RULES.md)                                                           |
| Cross-agent contracts (state-machine)                        | [`../agents/contracts.md`](../agents/contracts.md)                                                   |
| Project state (phases / RBAC / migrations)                   | [`../agents/project-state.md`](../agents/project-state.md)                                           |
| Memory convention (lessons / rotation)                       | [`../agents/memory/README.md`](../agents/memory/README.md)                                           |
| Legal escalation zones                                       | [`../legal/cross-cutting/escalation-zones.md`](../legal/cross-cutting/escalation-zones.md)           |
| Legal citation rules                                         | [`../legal/cross-cutting/citation-rules.md`](../legal/cross-cutting/citation-rules.md)               |

---

## Appendix B — Glossary

| Term                            | Meaning                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **ECC**                         | Evergreen Claude Coding — open-source multi-agent reference architecture (`v2.0.0-rc.1` pinned per ADR Section 7)              |
| **Adopt**                       | Use ECC artifact as-is (no project customization)                                                                              |
| **Adapt**                       | ECC base + local override (e.g. agent prompt + Russian language note)                                                          |
| **Keep custom**                 | No ECC equivalent worth adopting (e.g. PM business logic, Legal UA jurisdictional knowledge)                                   |
| **Phase 0-6**                   | Migration phases per ADR Section 6 (Discovery → Skeleton → Hooks → Agents → Skills → Rules+GHA → Cleanup)                      |
| **Agent shell**                 | Custom agent prompt that delegates sub-tasks to ECC agents (e.g. Coder shell delegates to `tdd-guide` + `typescript-reviewer`) |
| **Zone-of-write**               | Per-agent allowed/forbidden file paths, enforced via `block-production-edits` hook                                             |
| **Confidence policy**           | HIGH/MED/LOW labels on agent outputs (per ECC `code-reviewer` pattern) — PM uses LOW для USER escalation                       |
| **Mode 1-5**                    | PM workflow modes (1=new feature, 2=event handling, 3=resume, 4=User Testing, 5=Legal)                                         |
| **Legal Mode A-D**              | Legal agent modes (A=consult, B=PR review, C=brief check, D=strategic)                                                         |
| **Slash command**               | Shortcut invocation (e.g. `/plan`, `/tdd`) for common workflows — Phase 5+                                                     |
| **Skill**                       | Durable workflow pattern in `skills/<topic>/SKILL.md` — invokable via `Skill` tool                                             |
| **JSON-matcher hook**           | ECC hook format с specific predicates (vs old broad shell matcher) — Phase 2                                                   |
| **`developer` install profile** | ECC install profile recommended in ADR Section 3 (vs `minimal` / `full`)                                                       |
| **Cross-harness**               | Multiple coding harnesses (Claude Code, Codex, Cursor, Gemini, OpenCode, Zed) sharing same agent definitions — Phase 7+        |
| **AC verified marker**          | `ac_verified: 1,2,3` in commit message — pre-push hook enforces per RULES.md §2.2                                              |
| **Worktree isolation**          | `isolation="worktree"` parameter on `Agent()` dispatch — gives isolated git worktree, prevents conflicts                       |
| **`pm-state.json` schema v2**   | PM state file format с events log + agent_invocations + metrics aggregates (см. `pm-snippets.md` секция)                       |

---

**Документ закончен.** Если что-то непонятно — спрашивай у PM в chat, PM обращается к ADR / agent docs per topic. Этот guide — entry point, не replacement detailed docs.
