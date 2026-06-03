# contracts — Cross-Agent State Machine

Формализованный contract между агентами: кто кому когда отправляет state. Labels lifecycle, PR review flow, dispatch decisions.

**Кому читать:** PM (всегда), Coder/Reviewer/AutoTest (on-demand при cross-cutting situations).

---

## 1. High-level flow (Mermaid)

```mermaid
flowchart TD
    USER([USER]) -->|brief / фича| BA[BA]
    BA -->|.claude/briefs/pm-brief.md| PM[PM]
    PM -->|task-*.md + Agent isolation=worktree| CODER[Coder]
    PM -->|task-infra-*.md| DEVOPS[DevOps]
    CODER -->|PR open + wip-push N times + final ac_verified| PR{{PR}}
    DEVOPS -->|PR open| PR
    PR -->|PM Mode 2 — events| DECISION{Dispatch decision}
    DECISION -->|cover gaps| AUTOTEST[AutoTest]
    DECISION -->|always| REVIEWER[Reviewer]
    AUTOTEST -->|push specs| PR
    REVIEWER -->|APPROVE → awaiting-pm-review| PM
    REVIEWER -->|COMMENT + Verdict: BLOCK → do-not-merge| PM
    PM -->|User Testing — Mode 4| USER
    USER -->|апрув| PM
    USER -->|правки| PM
    PM -->|merge-approved label| CI[CI auto-merge-on-label]
    PM -->|batch fix — Mode 4.A| CODER
    CI -->|squash merge| MERGED([MERGED])
    MERGED -->|memory append| PM
```

---

## 2. Labels lifecycle (single source of truth)

| Label                   | Кто ставит                                                              | Семантика                                                                                     | Кто снимает                                 |
| ----------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `ai-review-ready`       | Coder/DevOps после PR open                                              | PR готов к Review (исторически — auto-trigger archived `ai-review.yml`; сейчас informational) | Reviewer после APPROVE или manual           |
| `awaiting-pm-review`    | Reviewer (внутри APPROVE event)                                         | Reviewer APPROVE'нул, PM смотрит и идёт в User Testing                                        | PM при User Testing approve (Mode 2.B / 4)  |
| `do-not-merge`          | PM при `Verdict: BLOCK`                                                 | Critical issue найден, merge заблокирован                                                     | PM при следующем APPROVE Reviewer           |
| `merge-approved`        | PM после User Testing approve                                           | User-approve получен, CI делает squash-merge                                                  | (никто; auto-merge сам убирает после merge) |
| `ci-failed`             | CI / PM при `e2e_failed`                                                | E2E или CI step упал — нужен fix                                                              | PM после merge fix-task                     |
| `e2e-broken` (на issue) | CI (`notify_e2e` job)                                                   | E2E на main сломан — глобальный blocker, Coder не начинает новые задачи                       | CI auto-close при зелёном E2E на main       |
| `hook-bypass-warning`   | (зарезервирован для CI hook detection если `--no-verify` использовался) | Маркер что коммит обошёл pre-push hook                                                        | PM после расследования                      |

### 2.1. Label state machine (Mermaid)

```mermaid
stateDiagram-v2
    [*] --> PR_OPENED: Coder push PR
    PR_OPENED --> ai_review_ready: Coder label
    ai_review_ready --> awaiting_pm_review: Reviewer APPROVE
    ai_review_ready --> do_not_merge: Reviewer COMMENT Verdict: BLOCK
    do_not_merge --> ai_review_ready: PM dispatch fix-task → Coder push → re-review
    awaiting_pm_review --> merge_approved: PM after User Testing
    awaiting_pm_review --> awaiting_pm_review: User Testing — правки → Mode 4.A
    merge_approved --> MERGED: CI auto-merge-on-label
    MERGED --> [*]: PM memory append → next task
    do_not_merge --> [*]: review_rounds >= 3 → эскалация USER
```

---

## 3. Sequence diagrams

### 3.1. New feature (happy path)

```
USER → BA: "сделай Phase X"
BA → PM: .claude/briefs/pm-brief.md (commit + push)
PM → Coder: Agent(prompt="task-X.md", isolation="worktree", run_in_background=True)
  Coder → PR: wip-push milestone 1/N
  Coder → PR: wip-push milestone 2/N
  ...
  Coder → PR: final commit с `ac_verified: 1,2,3` + `vision: ✓ /crm/X`
PM → Reviewer: Agent(prompt="PR #N")
  Reviewer → mcp__github__create_pull_request_review (APPROVE)
  Reviewer → label: awaiting-pm-review
PM (Mode 4) → bash scripts/pm/prep-user-testing.sh <branch> (run_in_background=True)
PM → USER: "PR #N готов к тестированию: https://<hash>.serveousercontent.com"
USER → PM: "апрув"
PM → label: merge-approved (CI auto-merge-on-label)
CI → squash-merge
PM → memory/coder/lessons.md (append 1-3 lessons)
PM → archive task to .claude/tasks/archive/
PM → mcp__scheduled-tasks для следующего checkpoint если нужно
```

### 3.2. Review BLOCK path

```
PM → Reviewer: Agent(prompt="PR #N")
  Reviewer → mcp__github__create_pull_request_review (COMMENT)
            body starts with "Verdict: BLOCK"
PM → labels: -awaiting-pm-review, +do-not-merge
PM → review_rounds++ в pm-state.json
  IF review_rounds >= 3:
    STOP, эскалация USER ("PR #N не проходит review 3 раунда — нужен ручной разбор")
  ELSE:
    PM → создать task-fix-pr-N.md
    PM → Coder: Agent(prompt="task-fix-pr-N.md", target_branch=<pr-branch>)
      Coder → push fixes
    PM → Reviewer (повторно): Agent(prompt="PR #N")
      (loop until APPROVE OR review_rounds >= 3)
```

### 3.3. E2E fail path

```
CI → e2e.yml → fail
CI / PM → label: ci-failed
PM (Mode 2.C) → gh run view <run_id> --log-failed | tail -100
PM → классификация:
  - Баг в коде → Agent(Coder, task-fix-e2e-<slug>.md, target_branch=<pr-branch>)
  - Баг в тесте → Agent(AutoTest, task-fix-e2e-<slug>.md, target_branch=<pr-branch>)
  - Infra issue → Agent(DevOps, task-fix-e2e-<slug>.md)
после фикса → Reviewer → ... → как в 3.1 или 3.2
```

### 3.4. Compaction recovery

```
[SESSION ENDS / COMPACTION]
[NEW SESSION STARTS]

Любой агент:
  1. Read .claude/agents/<self>.md → Golden rules + Recovery checklist
  2. Read .claude/RULES.md → cross-agent rules
  3. Read .claude/agents/project-state.md → текущие фазы
  4. Read .claude/agents/memory/<self>/lessons.md

PM additional:
  5. Read .claude/state/pm-state.json (если есть)
  6. tail -5 .claude/coder-activity.log
  7. ls .claude/tasks/*.blocked.md
  8. ls .claude/tasks/*.progress.md (для крупных задач)
  9. Sync с remote: git fetch origin
 10. Resume on next_action (если есть и scheduled_at < now)

Coder additional:
  5. cat .claude/tasks/<my-task>.progress.md (если есть)
  6. tail -3 .claude/coder-activity.log | grep INTENT
  7. git status / git log --oneline -5 / pwd
  8. Resume on milestone N+1 если sentinel говорит N done
```

---

## 4. Task file → agent mapping

| Task pattern              | Agent              | Triggered by                                                |
| ------------------------- | ------------------ | ----------------------------------------------------------- |
| `task-<slug>.md`          | Coder              | PM Mode 1 (new feature decomposition)                       |
| `task-fix-pr-<N>.md`      | Coder              | PM Mode 2.D (after BLOCK) или Mode 4.A (User Testing fixes) |
| `task-fix-e2e-<slug>.md`  | AutoTest или Coder | PM Mode 2.C (e2e_failed)                                    |
| `task-fix-test-<slug>.md` | AutoTest           | PM при обнаружении gap в coverage                           |
| `task-infra-<slug>.md`    | DevOps             | PM из BA brief или из incident                              |
| `task-<X>.blocked.md`     | (agent X)          | Agent X создал, PM читает                                   |
| `task-<X>.progress.md`    | Coder              | Coder sentinel для крупных задач (>4 файлов)                |

---

## 5. AutoTest dispatch decision (PM Mode 2)

После того как Coder создал/обновил PR — PM проверяет diff на E2E coverage **ДО** диспетча AutoTest:

```bash
# Сколько spec.ts файлов в diff PR
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<N>/files \
  --jq '[.[] | select(.filename | test("apps/e2e/tests/.*\\.spec\\.ts$"))] | length'
```

| Состояние                                                              | Действие                                        | Event в pm-state.json                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Coder НЕ добавил spec'ы И PR трогает `apps/web/**` или `apps/api/**`   | **MUST dispatch AutoTest**                      | `agent_started` (autotest)                                   |
| Coder добавил spec'ы, но названия тестов НЕ покрывают AC из task-файла | **MUST dispatch AutoTest** в Режиме «дополнить» | `agent_started` (autotest, mode=cover-gaps)                  |
| Coder добавил spec'ы, названия тестов покрывают AC                     | **Skip AutoTest**                               | `autotest_skipped` с `reason: "coder-added-e2e-covering-ac"` |
| PR трогает только docs/business/\*\* или CI                            | **Skip AutoTest**                               | `autotest_skipped` с `reason: "no-product-code-changes"`     |

**Skip без записи запрещён.** Skip-решение всегда фиксируется в `events[]`.

---

## 6. Reviewer verdict semantics

| Event API         | Body first line  | Семантика                       | PM action                                            |
| ----------------- | ---------------- | ------------------------------- | ---------------------------------------------------- |
| `APPROVE`         | (любой)          | OK, PR можно мерджить           | label `awaiting-pm-review`, далее Mode 4             |
| `COMMENT`         | `Verdict: BLOCK` | Critical issues, merge запрещён | label `-awaiting-pm-review, +do-not-merge`, fix-task |
| `COMMENT`         | (другое)         | Информационный комментарий      | Optional read, no state change                       |
| `REQUEST_CHANGES` | (любой)          | От внешнего reviewer (не AI)    | `review_rounds++`, fix-task                          |

**Почему AI-агенты не используют `REQUEST_CHANGES`:** GitHub API запрещает `REQUEST_CHANGES` когда author == reviewer (один owner-аккаунт `yaremenko-maksym`). Используется `COMMENT` + `Verdict: BLOCK` в первой строке тела.

---

## 7. Coder watchdog — recovery layers

См. `coder.md` секция 8.

| Layer | Тип                                                     | Где данные                             | Purpose                                    |
| ----- | ------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| 8.1   | Auto-hook (PostToolUse Edit/Write)                      | `.claude/coder-activity.log`           | «Живой ли Coder» — last activity timestamp |
| 8.1.1 | Opt-in intent markers (`scripts/coder/coder-intent.sh`) | Тот же лог, type `INTENT`              | «Что Coder намеревался» — semantic context |
| 8.2   | Semantic milestones (`<task>.progress.md`)              | Файл в `.claude/tasks/` (committed) | «Какой milestone reached»                  |

**PM при detection hung** (см. `pm-snippets.md` секция «Coder hung — recovery»):

1. `awk -F'\t' '$2=="INTENT"' .claude/coder-activity.log | tail -5` — last intents
2. `awk -F'\t' '$2!="INTENT"' .claude/coder-activity.log | tail -10` — last edits
3. Из последней строки извлечь `<cwd>` → `git -C <cwd> log/status` для recovery
4. Если `<task>.progress.md` есть — читать `current_milestone` для resume point

---

## 8. Out-of-band escalation

| Ситуация                                       | Кто инициирует                                     | Куда                                                              |
| ---------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Coder обнаружил неописанную бизнес-логику      | Coder создаёт `.claude/tasks/<task>.blocked.md` | PM читает на next wakeup → задаёт USER                            |
| Reviewer найден `Verdict: BLOCK` 3 раза подряд | PM (circuit breaker `review_rounds >= 3`)          | USER напрямую                                                     |
| E2E sustained failure после 2 fix-attempt      | PM                                                 | USER напрямую                                                     |
| Workflow file edit нужен                       | Coder/AutoTest → `.blocked.md`                     | PM → DevOps task                                                  |
| Security issue в чужом code (high confidence)  | Любой агент                                        | `mcp__ccd_session__spawn_task` (если применимо) или `.blocked.md` |

---

## 9. Where to update this file

- Когда меняется label semantics → §2 + §2.1
- Когда добавляется новый task pattern → §4
- Когда меняется dispatch decision matrix → §5
- Когда меняется Reviewer event semantics → §6
- Когда обновляется recovery protocol → §7 (но детали — в `coder.md` секция 8)
