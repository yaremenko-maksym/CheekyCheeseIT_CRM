# Phase 3d Deliverable — Coder migration (3d.1 + 3d.2)

**Дата:** 2026-06-03
**Phase:** 3d (Coder agent migration)
**Sub-phases:** 3d.1 (frontmatter port — PR #93, merged d7d02ce) + 3d.2 (workflow integration с ECC sub-agents — текущий rolling PR)
**ADR reference:** `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.1.3
**Migration target:** ECC v2.0.0-rc.1
**Status:** 3d.1 ✅ merged · 3d.2 ✅ committed в rolling PR

---

## 1. Inventory — что изменено

### 3d.1 (PR #93, merged)

| Файл                          | Изменение                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `docs/agents/coder.md`        | Добавлен YAML frontmatter (name / description / tools / model) — ECC agent format, lines 1-6 |
| `docs/agents/CLAUDE-coder.md` | Без изменений (9-строчный deprecated stub без manual TDD/Reviewer mentions)                  |

### 3d.2 (текущий PR)

| Файл                                                  | Изменение                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/coder.md`                                | (a) Расширена «Mandatory skill invocation» таблица — добавлены ECC `tdd-guide` + `typescript-reviewer` rows + примечание про D1-D4 preservation. (b) Добавлена секция §1.5 «ECC tdd-guide invocation» (workflow Шаг 1.5 для новых фич). (c) Добавлена секция §2.5 «ECC typescript-reviewer self-review» (workflow Шаг 2.5 — ДО `git push`). (d) Расширена «Reference (on-demand)» — секция ECC sub-agents catalog references + stack-specific skills note (after Phase 4). |
| `docs/agents/memory/coder/lessons.md`                 | Append-only lesson `2026-06-03 [phase3d.2-ecc-migration]` про tdd-guide / typescript-reviewer delegation rules.                                                                                                                                                                                                                                                                                                                                                            |
| `docs/agents/pm-snippets.md`                          | В «Coder — новая фича» + «Coder — фикс в существующую ветку» добавлены notes о self-delegation Coder'ом ECC sub-agents (PM не передаёт дополнительные prompts).                                                                                                                                                                                                                                                                                                            |
| `docs/agents/CLAUDE-coder.md`                         | Без изменений (нет упоминаний manual TDD/Reviewer для обновления).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docs/architecture/2026-06-03-phase3d-deliverable.md` | Новый файл — этот документ.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 2. Decomposition diagram — Coder shell + ECC sub-agents

```
                  PM (Mode 1: Dispatch)
                          │
                          ▼
              ┌───────────────────────┐
              │ Agent(coder, isolation│
              │   ="worktree", ...)   │
              └───────────┬───────────┘
                          │
                          ▼
        ┌──────────────────────────────────────┐
        │ Coder shell (docs/agents/coder.md)   │
        │ ─ project-specific orchestrator       │
        │ ─ D1-D4 resilience layer (preserved): │
        │   • intent marker (scripts/coder/)    │
        │   • chunking (wip-push every 2 files) │
        │   • AC verification (ac_verified:)    │
        │   • pre-push hook (hooks-ecc/)        │
        │ ─ zone-of-write enforcement           │
        │ ─ workflow §0-11 + ECC §1.5 + §2.5   │
        └──────┬─────────────────┬──────────────┘
               │                 │
               ▼                 ▼
   ┌───────────────────┐  ┌──────────────────────────┐
   │ ECC tdd-guide     │  │ ECC typescript-reviewer  │
   │ (§1.5 — new fch)  │  │ (§2.5 — self-review)     │
   │                   │  │                          │
   │ Trigger: new      │  │ Trigger: milestone trog. │
   │   feature only    │  │   .ts / .tsx файлы       │
   │ When: BEFORE §2   │  │ When: BEFORE git push    │
   │   Разработка      │  │                          │
   │ Output: TDD plan  │  │ Output: TS/Lint findings │
   │   RED→GREEN→IMPR  │  │   для self-fix           │
   │   80% coverage    │  │                          │
   └───────────────────┘  └──────────────────────────┘

   Notes:
   ─ ECC sub-agents = качество/нарративность кода.
   ─ D1-D4 resilience = устойчивость workflow → НЕ дублируется в ECC.
   ─ Knowledge primitives (nestjs-patterns / react-patterns / react-testing skills) — Phase 4 (lessons → skills).
```

---

## 3. Invocation matrix — кто-когда-зачем вызывает ECC sub-agents

| Diff в milestone                                          | Тип задачи  | sub-agent                             | Когда инвоукать                                         | Зачем                                                                    |
| --------------------------------------------------------- | ----------- | ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| Новая фича — production                                   | New feature | `tdd-guide`                           | Шаг 1.5 (после ветки, ДО §2 Разработка)                 | TDD план: RED→GREEN→IMPROVE + 80% coverage scaffolding                   |
| Bugfix в существующую ветку                               | Bug fix     | (не диспатч tdd-guide)                | — Использовать `superpowers:systematic-debugging` skill | TDD план неприменим — bug-isolated repro нужен                           |
| Milestone с `.ts` / `.tsx`                                | Любая       | `typescript-reviewer`                 | Шаг 2.5 (ПОСЛЕ Разработка, ДО `git push`)               | Self-review: strict types / ESLint / Zod usage — снижает review-итераций |
| Milestone без `.ts` / `.tsx` (только docs / config / yml) | Любая       | (skip typescript-reviewer)            | —                                                       | Нет TS кода — review nothing                                             |
| Coder UI задача                                           | New feature | `tdd-guide` + `frontend-design` skill | §1.5 + при frontend разработке                          | TDD план + design quality primitives                                     |

**ВАЖНО (не путать):**

- ECC `typescript-reviewer` — _self-review_ Coder'а, **до `git push`**, узко по TS/TSX.
- `docs/agents/code-reviewer.md` (Phase 3b) — _PM-диспатч после Coder push_, на PR, узко по correctness/architecture.
- `docs/agents/security-reviewer.md` (Phase 3b) — _PM параллельный диспатч с code-reviewer_, узко по OWASP/secrets/USDT.

Три разных reviewer'а, три разных момента pipeline.

---

## 4. Preservation — что не переехало в ECC

| Что preserved                                        | Где живёт                                                                               | Почему                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **D1-D4 resilience layer**                           | `docs/agents/coder.md` §3 (wip-push), §4 (watchdog), §7 (AC-in-diff), §8 (final commit) | Project-specific contract — ECC не покрывает        |
| **Intent markers**                                   | `scripts/coder/coder-intent.sh` + §4 Coder workflow                                     | Layer 8.1.1 — semantic context для PM recovery      |
| **Sentinel progress files**                          | `docs/specs/tasks/<task>.progress.md` + §4 Coder workflow                               | Recovery через PM (см. `contracts.md` §7)           |
| **ac_verified pre-push gate**                        | `hooks-ecc/coder-push-gate.sh` + §8 Coder workflow                                      | Layer C3 enforcement (см. ADR D3 fix)               |
| **Zone-of-write enforcement**                        | `docs/agents/RULES.md` §5 + Coder Golden rule §6                                        | Multi-agent specific (нет в ECC)                    |
| **Bizlogic blocker mechanism** (`<task>.blocked.md`) | `docs/agents/coder.md` §Блокер                                                          | Custom escalation pattern для PM                    |
| **`coder.md` workflow §0-§11**                       | `docs/agents/coder.md`                                                                  | Orchestration layer Coder'а — ECC только augment'ит |

ECC sub-agents (`tdd-guide` / `typescript-reviewer`) — _augmentation_, не _replacement_. Coder остаётся узкоспециализированным orchestrator'ом для проекта.

---

## 5. Risk assessment + mitigation

| Risk                                                                  | Severity | Mitigation                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tdd-guide` invocation может slow down Coder (extra round-trip)       | MED      | Trigger gated на «новая фича only» — bugfix пропускает (см. invocation matrix §3). Для small fixes — `superpowers:systematic-debugging` skill, не sub-agent.                                                |
| `typescript-reviewer` self-review дублирует `code-reviewer` post-push | LOW      | Разные scope: typescript-reviewer = TS-only (narrow), code-reviewer = architecture/zone-of-write/ESLint comprehensive. typescript-reviewer уменьшает _количество_ итераций code-reviewer, не дублирует.     |
| Coder может забыть инвоукать ECC sub-agents (workflow drift)          | MED      | (a) Mandatory skill table перечисляет их явно. (b) Coder в финальном отчёте обязан указать вызванные skills/sub-agents (см. coder.md §Mandatory skill invocation footer). PM проверяет в Mode 2 verify.     |
| `tdd-guide` 80% coverage может конфликтовать с E2E-only тестами       | LOW      | Coverage rule из ECC AGENTS.upstream.md § Testing Requirements. Если Coder делает только E2E (apps/e2e/\*\*) — coverage критерий не применим, Coder фиксирует это в финальном отчёте как «scope: E2E only». |
| Confusion `typescript-reviewer` ↔ `code-reviewer`                     | LOW      | Explicit «ВАЖНО:» note в coder.md §2.5 + lesson в memory/coder/lessons.md (2026-06-03) + invocation matrix этого deliverable.                                                                               |

---

## 6. Что осталось для последующих фаз (rolling PR)

### Phase 3e — AutoTest + DevOps adapt

- **AutoTest:** `docs/agents/autotest.md` — port frontmatter (как coder.md 3d.1) + integration с ECC `e2e-runner` (если присутствует в catalog) + Playwright patterns skills note.
- **DevOps:** `docs/agents/devops.md` — port frontmatter + integration с ECC `build-error-resolver` + `harness-optimizer` sub-agents.
- ADR refs: § 2.1.4 (AutoTest) + § 2.1.6 (DevOps).

### Phase 4 — lessons → ECC skills

- Convert накопленные lessons (`docs/agents/memory/*/lessons.md`) в `.claude/skills/*` knowledge primitives.
- Stack-specific skills: `nestjs-patterns`, `react-patterns`, `react-testing` — для Coder.
- UA-specific skills для Legal (если lessons накопятся).
- Coder reference в `coder.md` §Reference уже упоминает «available after Phase 4».

### Phase 5 — GHA integration

- Additive job в `.github/workflows/ci.yml` для ECC `code-reviewer` (необязательный, для опыта).
- Extract `rules/` патчи из ECC catalog.
- ADR ref: § 2.3 GHA Workflows.

### Phase 6 — cleanup

- Удалить deprecated `.claude/hooks/*.sh` (после Phase 2.5 live-swap уже неактивны).
- BA legacy docs decision (`docs/agents/ba.md` стая или move).
- Удалить `hooks-ecc-draft.json` (если есть, артефакт Phase 2).
- ADR refs: § 2.1.2 (BA) + § 2.2 Hooks cleanup.

### Финальный verify

- Orchestrator-driven: запустить полный multi-agent цикл (PM → Coder → code/security-reviewer → AutoTest → DevOps) на тестовом task'е, убедиться что все ECC integrations работают.

---

## 7. Phase 3 progress overview

| Sub-phase | Agent / scope                    | Status | PR                   |
| --------- | -------------------------------- | ------ | -------------------- |
| 3a        | Legal + Architect frontmatter    | ✅     | #87                  |
| 3b        | Reviewer split → code + security | ✅     | #90                  |
| 3c.1      | PM frontmatter                   | ✅     | #91                  |
| 3c.2      | PM dispatch logic (Modes 1-5)    | ✅     | #92                  |
| **3d.1**  | **Coder frontmatter**            | ✅     | #93 (merged d7d02ce) |
| **3d.2**  | **Coder workflow integration**   | ✅     | Текущий rolling PR   |
| 3e        | AutoTest + DevOps adapt          | TBD    | Rolling PR (next)    |

После 3e Phase 3 (agent migration) полностью closed. Далее — Phase 4-6.

---

## 8. Verification — что должно работать после merge

1. PM dispatches Coder обычным snippet'ом из `pm-snippets.md` — Coder читает coder.md и в §1.5 / §2.5 знает про ECC sub-agents.
2. Coder для новой фичи: invokes `tdd-guide` через `Agent(subagent_type="tdd-guide", ...)` — план TDD steps в task progress.
3. Coder для milestone с TS/TSX: invokes `typescript-reviewer` через `Agent(subagent_type="typescript-reviewer", ...)` — self-review findings, фиксы в том же milestone, потом push.
4. Coder в финальном отчёте перечисляет какие skills + ECC sub-agents вызывал (см. coder.md §Mandatory skill invocation footer).
5. D1-D4 не сломаны: intent markers / chunking / AC verification / pre-push hook — работают как до 3d.2.

---

## 9. Ссылки

- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.1.3 (lines 111-122)
- ECC catalog: `docs/architecture/ecc-reference/AGENTS.upstream.md` (`tdd-guide` line 21, `typescript-reviewer` line 48)
- Phase 3b deliverable: `docs/architecture/2026-06-03-phase3b-deliverable.md` (Reviewer split precedent)
- Phase 3c deliverable: `docs/architecture/2026-06-03-phase3c-deliverable.md` (PM Modes 1-5)
- Coder agent: `docs/agents/coder.md` (305 → ~340 lines после 3d.2)
- Coder lessons: `docs/agents/memory/coder/lessons.md` (lesson 2026-06-03 phase3d.2)
- PM snippets: `docs/agents/pm-snippets.md` (Coder dispatch секции 11-65 после 3d.2)
