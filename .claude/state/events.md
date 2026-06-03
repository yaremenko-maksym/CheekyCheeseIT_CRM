# pm-state.json — Event Types Catalog

> **Назначение:** документация всех возможных значений `type` в массивах `events[]` внутри `pm-state.json`. Источник истины для PM при логировании decisions.
>
> **Связанные файлы:**
>
> - `.claude/state/pm-state.json` — live state file (gitignored, не редактируется руками)
> - `.claude/agents/pm.md` — Mode 2 monitoring + Aggregate verdict logic + Critical-path trigger zones
> - `.claude/agents/pm-snippets.md` — секция «pm-state.json schema v2» + Event types
>
> **Phase 3b reviewer split impact:** добавлены `code_review_started`, `code_review_done`, `security_review_started`, `security_review_done`, `security_dispatched`, `review_timeout`. Deprecated (не пишутся новые): `review_approve`, `review_blocked`. Historical legacy в `completed[]` сохраняется как есть.

---

## Структура события

Каждое событие — JSON-объект в `events[]` массиве внутри `active[task]` или `completed[task]`:

```json
{
  "at": "<ISO 8601 UTC>",
  "type": "<event_type>"
  // ... type-specific fields
}
```

Общие поля:

- `at` — обязательное, ISO 8601 UTC timestamp (`2026-06-03T12:34:56Z`)
- `type` — обязательное, kebab-case-or-snake_case identifier (snake_case в живом коде, исторически)

---

## Lifecycle events (workflow milestones)

### `brief_approved`

PM прочитал и принял BA brief, готов к decomposition.

```json
{ "at": "...", "type": "brief_approved", "brief": ".claude/briefs/pm-brief.md" }
```

### `task_file_created`

PM создал новый task-file для Coder / AutoTest / DevOps.

```json
{ "at": "...", "type": "task_file_created", "file": ".claude/tasks/task-<slug>.md" }
```

### `agent_started`

PM запустил агента через `Agent(...)` tool.

```json
{
  "at": "...",
  "type": "agent_started",
  "agent": "coder",
  "task_file": ".claude/tasks/task-<slug>.md"
}
```

`agent` ∈ {`coder`, `autotest`, `devops`, `code-reviewer`, `security-reviewer`, `legal`}

### `agent_finished`

Background `Agent(...)` returned (или PM детектил completion).

```json
{ "at": "...", "type": "agent_finished", "agent": "coder", "result": "success" }
```

`result` ∈ {`success`, `blocked`, `no-op`}

### `pr_opened`

Coder / DevOps / AutoTest открыл новый PR.

```json
{ "at": "...", "type": "pr_opened", "pr": 42 }
```

---

## Review events (Phase 3b split — обновлено)

### `code_review_started`

PM dispatched `code-reviewer` (default reviewer для любого PR с product-code changes).

```json
{ "at": "...", "type": "code_review_started", "pr": 42 }
```

### `code_review_done` ⭐ NEW Phase 3c.2

`code-reviewer` завершил review. Verdict parsed из first line review body (либо APPROVE event либо COMMENT с `Verdict: BLOCK`).

```json
{
  "at": "...",
  "type": "code_review_done",
  "pr": 42,
  "verdict": "APPROVE", // или "BLOCK"
  "rounds": 1, // review_rounds++ для этой задачи
  "findings_count": 0 // опционально: число HIGH-confidence findings
}
```

**PM action:**

- `verdict: "APPROVE"` + (security-reviewer не dispatched) → label `awaiting-pm-review` → Mode 2.B.
- `verdict: "APPROVE"` + security-reviewer dispatched → ждать `security_review_done` (см. Aggregate verdict logic).
- `verdict: "BLOCK"` → Mode 2.D (BLOCK handler). Early-exit для aggregate verdict (не ждём security).

### `security_review_started`

PM dispatched `security-reviewer` (только когда PR трогает critical-path zones, см. `pm.md` §"Critical-path trigger zones").

```json
{
  "at": "...",
  "type": "security_review_started",
  "pr": 42,
  "triggered_paths": ["apps/api/src/finance/**", "packages/shared/src/schemas/finance.ts"]
}
```

### `security_review_done` ⭐ NEW Phase 3c.2

`security-reviewer` завершил review. Verdict parsed из first line review body.

```json
{
  "at": "...",
  "type": "security_review_done",
  "pr": 42,
  "verdict": "APPROVE", // или "BLOCK"
  "rounds": 1,
  "owasp_categories_hit": ["A01", "A03"], // опц.: список OWASP-категорий с findings
  "findings_count": 2 // опц.: число HIGH-confidence findings
}
```

**PM action:**

- `verdict: "APPROVE"` + code-reviewer уже APPROVE → aggregate APPROVE → Mode 2.B.
- `verdict: "APPROVE"` + code-reviewer ещё running → ждать `code_review_done`.
- `verdict: "BLOCK"` → Mode 2.D. Early-exit.

### `security_dispatched`

Alias для `security_review_started` — PM использует когда логирует "PR трогает critical zones → security dispatched" в Mode 2 (короткая форма).

```json
{
  "at": "...",
  "type": "security_dispatched",
  "pr": 42,
  "triggered_paths": [...]
}
```

Может писаться вместо `security_review_started` для лаконичности — оба интерпретируются одинаково при анализе.

### `review_timeout` ⭐ NEW Phase 3c.2

Один из dispatched reviewer'ов превысил 2× expected duration (см. `pm-snippets.md` "Типичные длительности агентов") без возврата verdict. Triggers Mode 2.F (timeout fallback).

```json
{
  "at": "...",
  "type": "review_timeout",
  "pr": 42,
  "agent": "security-reviewer", // или "code-reviewer"
  "dispatched_at": "2026-06-03T12:00:00Z",
  "timeout_at": "2026-06-03T12:30:00Z"
}
```

### `review_rejected`

Внешний non-AI reviewer (human через GitHub UI) сделал `REQUEST_CHANGES`. AI-агенты code-reviewer/security-reviewer **не** используют `REQUEST_CHANGES` (см. `contracts.md` §6 — owner==reviewer conflict).

```json
{ "at": "...", "type": "review_rejected", "pr": 42, "rounds": 1 }
```

---

## E2E events

### `e2e_started`

GHA `e2e.yml` workflow запущен.

```json
{ "at": "...", "type": "e2e_started", "run_id": "26298999300" }
```

### `e2e_passed`

E2E run закончился `success`.

```json
{ "at": "...", "type": "e2e_passed", "run_id": "26298999300" }
```

### `e2e_failed`

E2E run закончился `failure`. Triggers Mode 2.C.

```json
{
  "at": "...",
  "type": "e2e_failed",
  "run_id": "26298999300",
  "failure_type": "code" // "code" | "test" | "infra"
}
```

---

## Label / merge events

### `merge_approved_label`

PM поставил `merge-approved` label на PR после User Testing approve.

```json
{ "at": "...", "type": "merge_approved_label", "pr": 42 }
```

### `do_not_merge_label`

PM поставил `do-not-merge` label (обычно после `code_review_done` или `security_review_done` BLOCK).

```json
{
  "at": "...",
  "type": "do_not_merge_label",
  "pr": 42,
  "reason": "code-reviewer BLOCK: any HIGH finding"
}
```

### `user_approved`

USER в чате сказал «апрув» / «мерджим» — PM получил explicit consent для `merge-approved` label.

```json
{ "at": "...", "type": "user_approved", "pr": 42 }
```

### `merged`

CI auto-merged PR (squash) после `merge-approved` label + зелёные checks.

```json
{ "at": "...", "type": "merged", "pr": 42 }
```

---

## AutoTest events

### `autotest_skipped`

PM решил **не** диспатчить AutoTest. Skip без записи — запрещён.

```json
{ "at": "...", "type": "autotest_skipped", "reason": "coder-added-e2e-covering-ac" }
```

Возможные `reason`:

- `"coder-added-e2e-covering-ac"` — Coder уже покрыл AC в spec'ах
- `"no-product-code-changes"` — PR трогает только docs/business/\*\* или CI
- `"docs-only-pr"` — docs-only PR

---

## Worktree / hygiene events

### `worktree_isolation_warning`

`Agent(isolation="worktree")` вернулся, но в текущем worktree обнаружены uncommitted файлы — изоляция сломалась (см. `pm.md` Mode 2.E).

```json
{
  "at": "...",
  "type": "worktree_isolation_warning",
  "files": ["apps/api/src/finance/some.ts", "..."]
}
```

---

## Wakeup / scheduling events

### `wakeup_scheduled`

PM создал scheduled task через `mcp__scheduled-tasks__create_scheduled_task` (Layer 2 cross-session wait).

```json
{
  "at": "...",
  "type": "wakeup_scheduled",
  "scheduled_task_id": "poll-e2e-pr42-20260603T123456Z",
  "fireAt": "2026-06-03T12:50:00Z"
}
```

Также соответствует `next_action` в task-level state.

---

## Legal events (Mode 5)

### `legal_dispatched`

PM запустил Legal-агента через `Agent(...)`.

```json
{
  "at": "...",
  "type": "legal_dispatched",
  "mode": "pr-review", // "consult" | "pr-review" | "brief-check" | "strategic"
  "target": "pr:42" // task-file | "pr:<N>" | brief-file | consultation-file
}
```

### `legal_review_posted`

Mode B: Legal запостил review на PR (info-only, label `legal-noted`, не gate).

```json
{
  "at": "...",
  "type": "legal_review_posted",
  "pr": 42,
  "confidence": "HIGH" // "HIGH" | "MED" | "LOW"
}
```

### `legal_pre_feature_done`

Mode C: Legal вернул pre-feature brief check с recommendations для AC.

```json
{
  "at": "...",
  "type": "legal_pre_feature_done",
  "brief": ".claude/briefs/pm-brief.md",
  "recommendations_count": 3
}
```

### `legal_escalated_to_human`

Mode A/B/D: Confidence: LOW в hard escalation zone → USER informed что нужна верификация human-юристом.

```json
{
  "at": "...",
  "type": "legal_escalated_to_human",
  "reason": "Confidence: LOW + hard zone (PII storage)"
}
```

---

## Coder watchdog / recovery events

### `coder_recovered`

PM выполнил recovery hung Coder (см. `pm-snippets.md` секция «Coder hung — recovery»).

```json
{
  "at": "...",
  "type": "coder_recovered",
  "branch": "feature/<slug>",
  "unpushed_commits": 3,
  "stashed": true
}
```

---

## Deprecated (historical only — не пишутся новые после Phase 3b)

Эти types сохраняются в исторических completed[] tasks, но **PM не пишет их в новых задачах** — заменены на split-ified versions.

### `review_approve` (deprecated)

Replaced by `code_review_done` + `verdict: "APPROVE"`.

```json
{ "at": "...", "type": "review_approve", "pr": 22 }
```

Если PM встречает этот type при чтении старого `completed[]` — интерпретирует как `code_review_done` (verdict APPROVE).

### `review_blocked` (deprecated)

Replaced by `code_review_done` ИЛИ `security_review_done` + `verdict: "BLOCK"`. PM на момент записи решал какой именно reviewer вернул BLOCK, поэтому исторический event теряет агентовую атрибуцию.

```json
{ "at": "...", "type": "review_blocked", "pr": 22, "verdict": "BLOCK", "rounds": 3 }
```

---

## Aggregate verdict (NOT an event — derived state)

PM объединяет `code_review_done` + (опц.) `security_review_done` в **derived aggregate verdict** при чтении `events[]`. См. `pm.md` Mode 2 "Aggregate verdict logic".

**НЕ** пишется как отдельный event — это вычисляемое состояние в памяти PM.

Правило агрегации:

| code-reviewer | security-reviewer | Aggregate                   |
| ------------- | ----------------- | --------------------------- |
| APPROVE       | (не dispatched)   | APPROVE                     |
| APPROVE       | APPROVE           | APPROVE                     |
| ANY           | BLOCK             | BLOCK (early-exit)          |
| BLOCK         | ANY               | BLOCK (early-exit)          |
| ANY           | timeout (>2×)     | timeout fallback (Mode 2.F) |

---

## Agent invocations counter (per-task)

В `active[task].agent_invocations` PM хранит счётчик dispatch'ей каждого агента. Phase 3b split — новые ключи:

```json
"agent_invocations": {
  "coder": 5,
  "code_reviewer": 4,         // ⭐ NEW Phase 3c.2 (бывший "reviewer")
  "security_reviewer": 2,     // ⭐ NEW Phase 3c.2 (только когда critical-path)
  "autotest": 1,
  "devops": 0,
  "legal": 1                  // ⭐ NEW (Phase 3a Legal port)
}
```

**Historical compatibility:** старые tasks в `completed[]` имеют ключ `"reviewer"` без split — PM интерпретирует как `code_reviewer` для metrics aggregation.

---

## Изменения и версионирование

| Phase / Date            | Change                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 3c.2 (2026-06-03) | Added `code_review_started`, `code_review_done`, `security_review_started`, `security_review_done`, `security_dispatched`, `review_timeout`. Deprecated `review_approve`, `review_blocked` (historical preserved). `agent_invocations` ключи переименованы: `reviewer` → `code_reviewer` + `security_reviewer`. Added `brief_approved`, `task_file_created` (existing в живом state, документированы). |
| Phase 3a (2026-06-03)   | Added Legal events: `legal_dispatched`, `legal_review_posted`, `legal_pre_feature_done`, `legal_escalated_to_human`.                                                                                                                                                                                                                                                                                   |
| Initial (2026-05-XX)    | Baseline event types — see git log `.claude/state/pm-state.json`.                                                                                                                                                                                                                                                                                                                                      |

---

## Reference

- `.claude/agents/pm.md` — Mode 2 monitoring (event-to-action mapping), Critical-path trigger zones, Aggregate verdict logic, Mode 2.F (timeout handler)
- `.claude/agents/pm-snippets.md` — pm-state.json schema v2 + agent dispatch snippets + типичные длительности
- `.claude/agents/code-reviewer.md` — code-reviewer system prompt (default reviewer)
- `.claude/agents/security-reviewer.md` — security-reviewer system prompt (critical-path)
- `.claude/agents/contracts.md` — Reviewer verdict semantics (§6) + labels lifecycle (§2)
- `docs/architecture/2026-06-03-phase3c-deliverable.md` — Phase 3c deliverable summary
