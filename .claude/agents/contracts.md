# contracts — Master-direct-dispatch contracts

Формализованный contract между агентами: кто кому когда отправляет state. Master
(USER-сессия) напрямую диспатчит агентов через `Agent` tool и исполняет роль
оркестратора — декомпозиция, запуск, мониторинг, агрегатный вердикт, label-гейтинг,
User Testing. Отдельного PM-агента нет (удалён 2026-10-05: субагент технически не мог
спавнить агентов, а «полный pipeline» с ролями BA и PM через task-файлы и User Testing не исполнялся ни разу).

**Кому читать:** Master (при cross-cutting dispatch), Coder/Reviewer/AutoTest/Designer/
Manual-QA (on-demand, когда нужно понять verdict-семантику или recovery).

Этот файл держит то, что не принадлежит одному агенту: labels lifecycle, dispatch-триггеры
для оставленных агентов, verdict-семантику, flaky-E2E SLA, слои восстановления Coder.

---

## 1. Labels lifecycle (single source of truth)

| Label                   | Кто ставит                                                              | Семантика                                                                                     | Кто снимает                                 |
| ----------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `ai-review-ready`       | Coder/DevOps после PR open                                              | PR готов к Review (исторически — auto-trigger archived `ai-review.yml`; сейчас informational) | Reviewer после APPROVE или manual           |
| `awaiting-pm-review`    | Reviewer (внутри APPROVE event)                                         | Reviewer APPROVE'нул, Master смотрит и идёт в User Testing                                    | Master при User Testing approve             |
| `do-not-merge`          | Master при `Verdict: BLOCK`                                             | Critical issue найден, merge заблокирован                                                     | Master при следующем APPROVE Reviewer       |
| `merge-approved`        | **ТОЛЬКО Master/owner** после явного «мерджим» владельца                | User-approve получен, CI делает squash-merge                                                  | (никто; auto-merge сам убирает после merge) |
| `ci-failed`             | CI / Master при `e2e_failed`                                           | E2E или CI step упал — нужен fix                                                              | Master после merge fix-task                 |
| `e2e-broken` (на issue) | CI (`notify_e2e` job)                                                   | E2E на main сломан — глобальный blocker, Coder не начинает новые задачи                       | CI auto-close при зелёном E2E на main       |
| `hook-bypass-warning`   | (зарезервирован для CI hook detection если `--no-verify` использовался) | Маркер что коммит обошёл pre-push hook                                                        | Master после расследования                  |

> **Инвариант (golden rule, НЕ принадлежал PM):** `merge-approved` ставит **только**
> Master/owner и **только** после явного «мерджим» владельца в чате. Ни один агент
> (включая ревьюеров) его не трогает. Инцидент 2026-06-21 (#270): reviewer-агент
> самовольно добавил label → PR смержился до завершения review. См.
> `.claude/rules/common/design-gate.md` + память `feedback_reviewer_self_merge_incident`.

### 1.1. Label state machine (Mermaid)

```mermaid
stateDiagram-v2
    [*] --> PR_OPENED: Coder push PR
    PR_OPENED --> ai_review_ready: Coder label
    ai_review_ready --> awaiting_pm_review: Reviewer APPROVE
    ai_review_ready --> do_not_merge: Reviewer COMMENT Verdict: BLOCK
    do_not_merge --> ai_review_ready: Master dispatch fix-task → Coder push → re-review
    awaiting_pm_review --> merge_approved: Master after User Testing + явное «мерджим»
    awaiting_pm_review --> awaiting_pm_review: User Testing — правки → fix-task
    merge_approved --> MERGED: CI auto-merge-on-label
    MERGED --> [*]: Master memory append → next task
    do_not_merge --> [*]: review_rounds >= 3 → эскалация USER
```

---

## 2. Task file → agent mapping

Task-файлы (`.claude/tasks/`) владеет Master. Он их создаёт при декомпозиции и передаёт
путь агенту в dispatch-промпте.

| Task pattern              | Agent              | Triggered by                                          |
| ------------------------- | ------------------ | ----------------------------------------------------- |
| `task-<slug>.md`          | Coder              | Master (декомпозиция новой фичи)                      |
| `task-design-<slug>.md`   | UI/UX Designer     | Master (UI-heavy фича — Mode A direction)             |
| `task-fix-pr-<N>.md`      | Coder              | Master после BLOCK или после правок User Testing      |
| `task-fix-e2e-<slug>.md`  | AutoTest или Coder | Master при `e2e_failed`                               |
| `task-fix-test-<slug>.md` | AutoTest           | Master при обнаружении gap в coverage                 |
| `task-infra-<slug>.md`    | DevOps             | Master из incident / инфра-потребности                |
| `task-<X>.blocked.md`     | (agent X)          | Agent X создал, Master читает                         |
| `task-<X>.progress.md`    | Coder              | Coder sentinel для крупных задач (>4 файлов)          |

---

## 2.1. Critical-path trigger zones (cost-of-error gate)

Если задача/PR касается любой из зон ниже — **полный трек + ОБЯЗАТЕЛЬНЫЙ `security-reviewer`**
параллельно с `code-reviewer`. Эта ось (cost-of-error) отрабатывает **первой** и бьёт всё, что
ниже: ни light-track, ни ось автономии её не ослабляют (решение в этих зонах не может быть A1 —
см. `autonomy-levels.md`).

- auth / сессии / JWT / OAuth
- finance / расчётная логика / сплит-математика / курсы
- RBAC / видимость по ролям / маскировка данных
- wallets / transactions / company-account (USDT)
- Drizzle-миграции / новые таблицы

Эта таблица — канонический источник (перенесён сюда 2026-10-05 из удалённого `pm.md`).
Ссылки «critical-path trigger zones» из `orchestration-routing.md`, `autonomy-levels.md`,
`model-routing.md` указывают сюда.

---

## 3. AutoTest dispatch decision

После того как Coder создал/обновил PR — Master проверяет diff на E2E coverage **ДО**
диспатча AutoTest:

```bash
# Сколько spec.ts файлов в diff PR
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<N>/files \
  --jq '[.[] | select(.filename | test("apps/e2e/tests/.*\\.spec\\.ts$"))] | length'
```

| Состояние                                                              | Действие                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| Coder НЕ добавил spec'ы И PR трогает `apps/web/**` или `apps/api/**`   | **MUST dispatch AutoTest**                      |
| Coder добавил spec'ы, но названия тестов НЕ покрывают AC из task-файла | **MUST dispatch AutoTest** в Режиме «дополнить» |
| Coder добавил spec'ы, названия тестов покрывают AC                     | **Skip AutoTest** (reason: coder-added-e2e)     |
| PR трогает только docs/business/\*\* или CI                            | **Skip AutoTest** (reason: no-product-code)     |

**Skip фиксируется решением** — в теле PR / task-файле отметить причину skip (как A1-решение
по `autonomy-levels.md`). Молчаливый skip запрещён.

---

## 3.1. Manual QA dispatch decision

Manual QA — интерактивный субагент, проходит фичу на ЖИВОМ стеке через Playwright MCP.
Дополняет AutoTest (тот пишет `.spec.ts` с mocked данными), Manual QA ловит то, что mocked
E2E пропускает: визуальные дефекты, broken/empty states, кириллицу в PDF/CSV, реальное RBAC
поведение, console-ошибки.

**Когда дispatch'ить:**

| Состояние                                                                                | Действие                                                          |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| PR трогает `apps/web/**` И добавляет новую визуальную фичу / экран / поток               | **MUST dispatch Manual QA** до merge                              |
| PR содержит download / export (PDF / CSV / file) для проверки кириллицы / layout         | **MUST dispatch Manual QA**                                       |
| PR трогает RBAC-gated роуты или меняет видимость по ролям                                | **MUST dispatch Manual QA**                                       |
| PR только backend / refactor / `apps/api/**` без UI surface                              | **Skip Manual QA** (reason: no-ui-surface)                        |
| PR только docs / CI / `.github/**` / migrations без UI                                   | **Skip Manual QA** (reason: no-ui-surface)                        |
| AutoTest добавил `.spec.ts` покрывающий golden path, НО фича визуально новая / сложная   | **MUST dispatch Manual QA дополнительно** (mocked E2E ≠ visual UT) |

**Параллельность:** Manual QA диспатчится **параллельно** с code-reviewer (`run_in_background=True`).
Reviewer делает статический анализ кода; Manual QA — динамический visual / functional проход.

**Финал:** Manual QA пишет отчёт Master (severity-табличка + скриншоты). Cosmetic UI bugs
Manual QA фиксит сам в `apps/web/**` и пушит. Backend / функциональные баги → Master решает:
`task-fix-pr-N.md` для Coder.

См. `manual-qa.md` для полного workflow + zone-of-write.

---

## 3.2. UI/UX Designer dispatch decision

Designer работает в режимах A/B/C/D/E (см. `ui-ux-designer.md`). Когда дispatch'ить:

### Mode A — Design Direction (pre-feature)

| Trigger                                                                                    | Действие                                      |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Задача описывает новый экран / поток / dashboard / UI-heavy фичу (не table CRUD)           | **MUST dispatch Designer Mode A** ДО Coder    |
| Backend-only / API-only / migration / CI                                                   | **Skip Designer Mode A** (reason: no-ui)      |
| Minor UI tweak (текст / цвет / inline edit без нового layout)                               | **Skip Designer Mode A** (reason: minor-tweak)|

Designer Mode A / E output → `docs/design/<slug>.md` spec → Master передаёт ссылку в task-файл Coder'у.

### Mode B / C — Visual Audit + fidelity + AI-slop check (post-impl, параллельно с code-reviewer)

| Trigger                                                                                  | Действие                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| PR трогает `apps/web/**` (новый экран / новые компоненты / styling changes)             | **MUST dispatch Designer Mode B** (включает Mode C) |
| PR только `apps/web/app/components/ui/<existing>.tsx` с minor classNames / token rename | **Optional** — Master решает по PR description      |
| PR только backend / refactor / migrations / CI                                          | **Skip Designer**                                   |

Designer Mode B verdict (`Design Review:` + `Fidelity:`):

- `PASS` → переход к `awaiting-pm-review`.
- `POLISH-REQUESTED` / `ISSUES` → по строгости = BLOCK перед merge (fix-task).
- `BLOCK` → `do-not-merge` label, `task-fix-pr-N.md` для Coder.

### Mode D — Polish pass

Trigger: code-reviewer / Manual QA / Designer Mode B пометили LOW-severity cosmetic issue →
Designer Mode D Edit'ит сам cosmetic в `apps/web/**` + re-verify скриншотом + push.

**Aggregate verdict logic:** Master объединяет вердикты (code-reviewer + security-reviewer
если триггернут + spec-reviewer + Manual QA + Designer Mode B + copy-reviewer на тексте) →
если ВСЕ PASS → `awaiting-pm-review`. Любой BLOCK → `do-not-merge`.

См. `ui-ux-designer.md` для полного workflow + zone-of-write.

---

## 3.3. Flaky E2E SLA

Политика zero-flaky: любой флак чинится немедленно, не маскируется и не «пересиживается»
через re-run.

**Сигналы флака:**

- CI показывает тесты со статусом `flaky` (прошли с retry) — flaky-report в summary;
- E2E job прошёл только после ручного re-run;
- агент/USER наблюдал нестабильность локально.

**SLA — в тот же день (до следующего `merge-approved`):**

1. Master фиксирует `flaky_detected` (spec / test / run_url) в task-файле / заметках.
2. Master dispatch `autotest` **Режим Fix-Flaky** (промпт: `<spec>:<test>` + ссылки на runs).
3. До диспатча флак НЕ «прощается»: re-run для разблокировки merge допустим, но ТОЛЬКО
   вместе с записью + dispatch — иначе это маскировка.

**Definition of fixed:** найден root cause (НЕ повышение таймаутов, НЕ retry-маскировка),
тест 10/10 зелёный локально в изоляции + полный шард 1×. Известный класс причин: dev/prod
build difference — CI гоняет production build, где dev-only элементы tree-shaken (см.
`memory/autotest/lessons.md`).

---

## 3.4. spec-reviewer dispatch decision

Вторая ось ревью: соответствие диффа **заданию**. Дополняет `code-reviewer` (корректность
кода) и `security-reviewer` (безопасность). Ни один из них не отвечает на вопрос «сделали ли
то, что просили, и только ли это» — до появления оси единственным носителем этого факта был
трейлер `ac_verified:`, который пишет о себе сам кодер.

| Состояние                                                                            | Действие                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| У PR есть исходное задание (`task-<slug>.md` или issue через `Closes #N`)            | **MUST dispatch spec-reviewer**                                     |
| Fix-PR по находкам ревью (`task-fix-pr-<N>.md`)                                      | **MUST dispatch** — заданием служит fix-task с идентификаторами     |
| Задания нет ни в одном виде (ad-hoc правка, hotfix по устному)                       | **Skip** (reason: no-source-spec)                                   |
| Docs-only diff без AC                                                                | **Skip** (reason: docs-only)                                        |

**Параллельность:** диспатчится в том же сообщении, что `code-reviewer` (+ `security-reviewer`
на critical-path, + `manual-qa` / `ui-ux-designer` на UI), все с `run_in_background=True`.

**Вердикт:** `Spec Review: PASS | ISSUES | BLOCK`, находки с префиксом `SPEC-`, контрольная
строка `Findings: … (N)`. `ISSUES` по строгости приравнивается к BLOCK перед merge.

См. `spec-reviewer.md` для полного workflow.

---

## 4. Reviewer verdict semantics

| Event API         | Body first line                 | Семантика                             | Master action                                                           |
| ----------------- | ------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `APPROVE`         | (любой)                         | OK, PR можно мерджить                 | label `awaiting-pm-review`, далее User Testing                         |
| `COMMENT`         | `Verdict: BLOCK`                | Critical issues, merge запрещён       | label `-awaiting-pm-review, +do-not-merge`, fix-task                   |
| `COMMENT`         | (другое)                        | Информационный комментарий            | Optional read, no state change                                        |
| `REQUEST_CHANGES` | (любой)                         | От внешнего reviewer (не AI)          | `review_rounds++`, fix-task                                           |
| `COMMENT`         | `Spec Review: BLOCK` / `ISSUES` | Дифф разошёлся с заданием             | label `-awaiting-pm-review, +do-not-merge`, fix-task с находками `SPEC-` |
| `COMMENT`         | `Spec Review: N/A`              | Задания не нашлось — вопрос к постановке | Master решает: завести задание или зафиксировать skip               |

**Почему AI-агенты не используют `REQUEST_CHANGES` / `APPROVE`:** GitHub API запрещает оба,
когда author == reviewer (один owner-аккаунт `yaremenko-maksym`) — `APPROVE` возвращает 422
`"Can not approve your own pull request"`. Используется `COMMENT` + `Verdict:` в первой строке
тела, Master парсит первую строку. Проверено на PR #536 (2026-08-17).

---

## 5. Coder watchdog — recovery layers

См. `coder.md` секция 8.

| Layer | Тип                                                     | Где данные                             | Purpose                                    |
| ----- | ------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| 8.1   | Auto-hook (PostToolUse Edit/Write)                      | `.claude/coder-activity.log`           | «Живой ли Coder» — last activity timestamp |
| 8.1.1 | Opt-in intent markers (`scripts/coder/coder-intent.sh`) | Тот же лог, type `INTENT`              | «Что Coder намеревался» — semantic context |
| 8.2   | Semantic milestones (`<task>.progress.md`)              | Файл в `.claude/tasks/` (committed) | «Какой milestone reached»                  |

**Master при detection hung:**

1. `awk -F'\t' '$2=="INTENT"' .claude/coder-activity.log | tail -5` — last intents
2. `awk -F'\t' '$2!="INTENT"' .claude/coder-activity.log | tail -10` — last edits
3. Из последней строки извлечь `<cwd>` → `git -C <cwd> log/status` для recovery
4. Если `<task>.progress.md` есть — читать `current_milestone` для resume point

---

## 6. Out-of-band escalation

| Ситуация                                       | Кто инициирует                                     | Куда                                   |
| ---------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| Coder обнаружил неописанную бизнес-логику      | Coder создаёт `.claude/tasks/<task>.blocked.md` | Master читает → решает / спрашивает USER |
| Reviewer найден `Verdict: BLOCK` 3 раза подряд | Master (circuit breaker `review_rounds >= 3`)      | USER напрямую                          |
| E2E sustained failure после 2 fix-attempt      | Master                                             | USER напрямую                          |
| Workflow file edit нужен                       | Coder/AutoTest → `.blocked.md`                     | Master → DevOps task                   |

---

## 7. Compaction recovery

```
[SESSION ENDS / COMPACTION]
[NEW SESSION STARTS]

Любой агент:
  1. Read .claude/agents/<self>.md → Golden rules + Recovery checklist
  2. Read .claude/RULES.md → cross-agent rules
  3. Read .claude/agents/project-state.md → текущие фазы
  4. Read .claude/agents/memory/<self>/lessons.md

Coder additional:
  5. cat .claude/tasks/<my-task>.progress.md (если есть)
  6. tail -3 .claude/coder-activity.log | grep INTENT
  7. git status / git log --oneline -5 / pwd
  8. Resume на milestone N+1 если sentinel говорит N done
```

---

## 8. Where to update this file

- Когда меняется label semantics → §1
- Когда добавляется новый task pattern → §2
- Когда меняется dispatch decision matrix → §3 / §3.1–§3.4
- Когда меняется Reviewer event semantics → §4
- Когда обновляется recovery protocol → §5 (детали — в `coder.md` секция 8)
