# Phase 3e Deliverable — AutoTest + DevOps migration

**Дата:** 2026-06-03
**Phase:** 3e (AutoTest + DevOps agent migration)
**ADR references:** `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.1.4 (AutoTest) + § 2.1.6 (DevOps)
**Migration target:** ECC v2.0.0-rc.1
**Status:** ✅ committed в rolling PR #94

---

## 1. Inventory — что изменено

### 1.1 AutoTest (`docs/agents/autotest.md`)

| Файл                                     | Изменение                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/autotest.md`                | (a) Добавлен YAML frontmatter (name / description / tools / model: sonnet) — ECC agent format. (b) Расширена «Mandatory skill invocation» — добавлена row про ECC `skills/playwright-patterns` (after Phase 4) + note про D3 preservation. (c) Расширена «Reference (on-demand)» — секция ECC sub-agents / skills (после Phase 4). |
| `docs/agents/CLAUDE-autotest.md`         | Без изменений (10-строчный deprecated stub без manual reviewer mentions).                                                                                                                                                                                                                                                          |
| `docs/agents/memory/autotest/lessons.md` | Без изменений (нет нового lesson — Phase 3e не вводит новые E2E paterns, только frontmatter).                                                                                                                                                                                                                                      |

### 1.2 DevOps (`docs/agents/devops.md`)

| Файл                                   | Изменение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/devops.md`                | (a) Добавлен YAML frontmatter (name / description / tools / model: sonnet). (b) Расширена «Mandatory skill invocation» — добавлены rows про ECC `build-error-resolver` + `harness-optimizer`. (c) Добавлена новая секция §7 «ECC sub-agents — invocation matrix» с 4 subsections: §7.1 build-error-resolver triggers, §7.2 harness-optimizer triggers, §7.3 DevOps custom shell scope (what stays), §7.4 workflow integration examples. (d) Расширена «Reference (on-demand)» — секция ECC sub-agents catalog refs + Phase 3e ref. |
| `docs/agents/CLAUDE-devops.md`         | Без изменений (10-строчный deprecated stub).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/agents/memory/devops/lessons.md` | Без изменений (нет нового lesson — Phase 3e — workflow integration без новых patterns).                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 1.3 Cross-cutting

| Файл                                                  | Изменение                                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/README.md`                               | Обновлены строки таблицы «Agent system prompts» для AutoTest и DevOps — добавлена нота `(model: sonnet)` для consistency с Phase 3 ECC port. |
| `docs/architecture/2026-06-03-phase3e-deliverable.md` | Новый файл — этот документ.                                                                                                                  |

---

## 2. Decision rationale — Adapt для обоих агентов

| Agent    | ADR ref | Decision  | Justification                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AutoTest | § 2.1.4 | **Adapt** | Custom shell preserved (D3 dispatch decision unique для проекта). ECC `skills/playwright-patterns` — _knowledge primitive_ для anti-patterns, доступен после Phase 4. ECC `agents/e2e-runner` (если будет в catalog) — _не_ дублирует D3, AutoTest's job.                                                                                                                                              |
| DevOps   | § 2.1.6 | **Adapt** | Decomposition: GHA workflows / Docker / env / scripts/devops — DevOps custom shell (ECC scope не покрывает). Build errors → ECC `build-error-resolver` (pnpm/TS/Vite/Turbo). Harness config tuning → ECC `harness-optimizer` (.claude/settings.json, hooks-ecc/\*). Cite ECC `AGENTS.upstream.md` § Performance "Build troubleshooting" + § Agent Orchestration "Harness config reliability and cost". |

**Не Replace.** Никакой агент не заменяется на ECC — оба augmented делегацией в narrow sub-agents.

---

## 3. DevOps ECC invocation matrix

(Полный matrix — в `docs/agents/devops.md` §7. Здесь сжатое overview.)

```
                          DevOps custom shell
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌─────────────────┐    ┌──────────────────────┐    ┌────────────────────┐
│ GHA / Docker /  │    │ ECC build-error-     │    │ ECC harness-       │
│ env / scripts/  │    │ resolver (sub-agent) │    │ optimizer (sub-ag) │
│ devops          │    │                      │    │                    │
│                 │    │ Trigger: build fail  │    │ Trigger: hooks/    │
│ Owner: DevOps   │    │  (pnpm/TS/Vite/Turbo)│    │  settings.json/    │
│ Scope: workflow │    │                      │    │  agent config tune │
│  files, Docker, │    │ Output: diagnose +   │    │                    │
│  branch protect,│    │  incremental fix     │    │ Output: matcher /  │
│  secrets, GHA   │    │  suggestions         │    │  config tradeoffs  │
│  concurrency    │    │                      │    │                    │
│                 │    │ NOT trogает GHA      │    │ NOT trogает prod   │
│                 │    │  workflows           │    │  code (apps/**)    │
└─────────────────┘    └──────────────────────┘    └────────────────────┘
```

### 3.1 Build issue routing decision tree

```
Build падает в CI или локально
        │
        ▼
┌───────────────────────────────────┐
│ Это build-related?                │
│ (pnpm/TS/Vite/Turbo)              │
└──────────┬────────────────────────┘
           │ Yes
           ▼
┌───────────────────────────────────┐
│ Invoke ECC build-error-resolver   │
│ с логом + failing command         │
└──────────┬────────────────────────┘
           │
           ▼
┌───────────────────────────────────┐
│ Fix в DevOps zone (workflows,     │
│ scripts/devops)?                  │
└────┬──────────────┬───────────────┘
     │ Yes          │ No (prod code)
     ▼              ▼
  Делаю сам    Escalate в PM → Coder dispatch
```

### 3.2 Harness tune routing

```
Hook noisy / slow ИЛИ settings.json review
        │
        ▼
┌───────────────────────────────────┐
│ Invoke ECC harness-optimizer       │
│ с target file + цель               │
└──────────┬────────────────────────┘
           │
           ▼
┌───────────────────────────────────┐
│ Apply в .claude/settings.json /    │
│ hooks-ecc/*  (DevOps zone)         │
└──────────┬────────────────────────┘
           │
           ▼
       Smoke verify
       (latency / reliability check)
```

---

## 4. AutoTest D3 dispatch preservation

**D3 (per ADR § 2.1.4):** «Если Reviewer suggests test fix — решает кто handle (AutoTest vs Coder)» — _AutoTest's job_, не ECC.

| Что preserved                                                        | Где живёт                                                                                                        | Почему                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **D3 dispatch decision**                                             | `docs/agents/autotest.md` (intro), `docs/agents/contracts.md` §5, `docs/architecture/2026-05-23-dev-flow-rca.md` | Project-specific routing — ECC `e2e-runner` covers general E2E discipline, но не наш D3 contract. |
| **3 modes** (new spec / fix flaky / coverage audit)                  | `docs/agents/autotest.md` (Mode 1 + Mode 2 + Mode 3 sections)                                                    | Workflow scoping для PM dispatch — custom.                                                        |
| **AC-first rule** (тест из AC task-файла, не из кода)                | `docs/agents/autotest.md` (Mode 1 Шаг 1) + Golden rule §6                                                        | Project contract — ECC `tdd-guide` RED→GREEN не идентичен (TDD vs regression coverage).           |
| **Anti-patterns** (route.continue / getByText scoping / data-testid) | `docs/agents/autotest.md` секция «Anti-patterns» + `memory/autotest/lessons.md`                                  | До Phase 4 — здесь. После Phase 4 — переедут в `skills/playwright-patterns/`.                     |
| **Worktree hygiene** (debug artifacts → /tmp)                        | `docs/agents/autotest.md` Golden rule §4 + lessons.md (2026-05-20)                                               | Multi-agent specific (нет в ECC).                                                                 |
| **`pnpm --filter @crm/e2e test` локально** перед push                | `docs/agents/autotest.md` (frontmatter description) + RULES.md                                                   | Project mandatory rule, не покрыто ECC.                                                           |

ECC sub-agents для AutoTest — _только_ knowledge primitives (Phase 4 skills/playwright-patterns). Agent shell — custom.

---

## 5. Risk assessment + mitigation

| Risk                                                                         | Severity | Mitigation                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DevOps инвоукает `build-error-resolver` для CI логов, требующих GHA edits    | MED      | §7.1 explicit note: «build-error-resolver НЕ trogает `.github/workflows/*.yml`». Если build issue требует workflow edits — DevOps делает сам. Diagnose vs Fix scope separation.                                                                                     |
| `harness-optimizer` редактирует production code (apps/api, apps/web)         | LOW      | §7.2 explicit note: «harness-optimizer НЕ редактирует production code. Только Claude Code config + hooks». Architect's zone-of-write enforced через `block-production-edits.sh` hook (Phase 2.5 active).                                                            |
| AutoTest забывает что D3 — это AutoTest's job                                | LOW      | Frontmatter `description` явно перечисляет D3 + secondary mention в Mandatory skill invocation footer. Также в Phase 3e deliverable §4. `contracts.md` §5 — single source.                                                                                          |
| Phase 4 (skills/playwright-patterns) задерживается → AutoTest без primitives | LOW      | Anti-patterns остаются в `autotest.md` секции «Anti-patterns» + `memory/autotest/lessons.md`. Reference в frontmatter говорит «available after Phase 4» — explicit time-gate, не блокирует AutoTest до Phase 4.                                                     |
| ECC sub-agent unavailability (catalog не загружен в profile)                 | MED      | DevOps fallback: если `Agent(subagent_type="build-error-resolver", ...)` ошибка `unknown subagent` — DevOps классифицирует sам (§6.4 Мониторинг CI) и применяет fix без ECC. Не блокирует workflow. Same для harness-optimizer (fallback на manual matcher review). |
| Двойная читаемость invocation matrix (devops.md §7 + этот deliverable §3)    | LOW      | devops.md §7 — _agent-facing_ (живой контракт). Phase 3e deliverable §3 — _migration record_ (исторический snapshot). Двойственность OK по pattern прошлых deliverable'ов (Phase 3d.2 имел тот же setup для Coder).                                                 |

---

## 6. Phase 3 progress overview (после 3e)

| Sub-phase | Agent / scope                    | Status | PR                   |
| --------- | -------------------------------- | ------ | -------------------- |
| 3a        | Legal + Architect frontmatter    | ✅     | #87                  |
| 3b        | Reviewer split → code + security | ✅     | #90                  |
| 3c.1      | PM frontmatter                   | ✅     | #91                  |
| 3c.2      | PM dispatch logic (Modes 1-5)    | ✅     | #92                  |
| 3d.1      | Coder frontmatter                | ✅     | #93 (merged d7d02ce) |
| 3d.2      | Coder workflow integration       | ✅     | #94 (rolling)        |
| **3e**    | **AutoTest + DevOps adapt**      | ✅     | **#94 (rolling)**    |

После 3e Phase 3 (agent migration) **полностью closed**. Далее — Phase 4 (lessons → skills), Phase 5 (GHA integration), Phase 6 (cleanup).

---

## 7. Что осталось для последующих фаз

### Phase 4 — lessons → ECC skills

- Convert `docs/agents/memory/autotest/lessons.md` anti-patterns → `.claude/skills/playwright-patterns/` knowledge primitives.
- Convert `docs/agents/memory/devops/lessons.md` cross-platform shims → `.claude/skills/devops-cross-platform/` (если accumulates).
- Stack-specific skills для Coder: `nestjs-patterns`, `react-patterns`, `react-testing`.
- UA-specific skills для Legal (если lessons накопятся).
- AutoTest frontmatter reference (`skills/playwright-patterns available after Phase 4`) — становится active после Phase 4.

### Phase 5 — GHA integration

- Additive job в `.github/workflows/ci.yml` для ECC `code-reviewer` (необязательный, для опыта).
- ECC `build-error-resolver` доступен как Agent через CI claude-code-action (если опыт show-value).
- Extract `rules/` патчи из ECC catalog в `.cursorrules` / `.clauderules`.
- ADR ref: § 2.3 GHA Workflows.

### Phase 6 — cleanup

- Удалить deprecated `.claude/hooks/*.sh` (после Phase 2.5 live-swap уже неактивны).
- BA legacy docs decision (`docs/agents/ba.md` стая или move).
- Удалить `hooks-ecc-draft.json` (если есть, артефакт Phase 2).
- ADR refs: § 2.1.2 (BA) + § 2.2 Hooks cleanup.

### Финальный verify (после Phase 6)

- Orchestrator-driven: запустить полный multi-agent цикл (PM → Coder → code/security-reviewer → AutoTest → DevOps) на тестовом task'е, убедиться что все ECC integrations работают.

---

## 8. Verification — что должно работать после merge

1. PM dispatches AutoTest обычным snippet'ом из `pm-snippets.md` — AutoTest читает autotest.md и frontmatter `description` упоминает D3 + 3 modes + mandatory `pnpm --filter @crm/e2e test`.
2. PM dispatches DevOps для build issue — DevOps читает devops.md §7.1, инвоукает `Agent(subagent_type="build-error-resolver", ...)` с логом и failing command. ECC даёт fix suggestions, DevOps применяет в workflow (если DevOps zone) или escalate в PM (если prod code).
3. DevOps для harness review — invoke `Agent(subagent_type="harness-optimizer", ...)` с target file и целью (latency / cost). Применяет в `.claude/settings.json` или `hooks-ecc/*`.
4. AutoTest D3 не сломан: при Reviewer test-fix suggestion — AutoTest решает по `contracts.md` §5 (AutoTest vs Coder), не передаётся в ECC `e2e-runner`.
5. AutoTest anti-patterns остаются доступны в `autotest.md` секции «Anti-patterns» + `memory/autotest/lessons.md` — до Phase 4 skills migration.

---

## 9. Ссылки

- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.1.4 (lines 124-132, AutoTest) + § 2.1.6 (lines 146-156, DevOps)
- ECC catalog: `docs/architecture/ecc-reference/AGENTS.upstream.md` (`build-error-resolver` line 24, `e2e-runner` line 25, `harness-optimizer` line 43)
- Phase 3b deliverable: `docs/architecture/2026-06-03-phase3b-deliverable.md` (Reviewer split precedent)
- Phase 3c deliverable: `docs/architecture/2026-06-03-phase3c-deliverable.md` (PM Modes 1-5)
- Phase 3d deliverable: `docs/architecture/2026-06-03-phase3d-deliverable.md` (Coder decomposition + invocation matrix)
- AutoTest agent: `docs/agents/autotest.md` (~340 lines после 3e)
- DevOps agent: `docs/agents/devops.md` (~395 lines после 3e — +§7 invocation matrix)
- AutoTest lessons: `docs/agents/memory/autotest/lessons.md`
- DevOps lessons: `docs/agents/memory/devops/lessons.md`
