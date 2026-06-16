---
name: dev-flow-resilience
description: When Coder / Reviewer / PM работают над long-running операцией где может произойти watchdog cutoff, MCP hang, session boundary loss или zone-of-write violation. CRM-specific resilience layer (D1-D4 fixes из 2026-05-23 RCA) — НЕ покрывается ECC. Использовать перед началом long-running work, при подозрении на silent termination и при cross-session ожиданиях.
when_to_use: "Use when an agent runs a long-running operation, an MCP call hangs > 5s, a session boundary may drop state, a watchdog may cut the agent off mid-task, or a cross-session wait is needed. Examples: 'агент обрезался на лимите', 'MCP завис', 'нужно дождаться review через час', 'completed но не done', 'sentinel recovery', 'write-then-post'."
allowed-tools:
  - Read
  - Bash(git:*)
  - mcp__scheduled-tasks__*
---

# Dev-Flow Resilience (D1-D4 lift)

Custom resilience patterns для CRM AI pipeline. ECC покрывает workflow surface (skills/), но НЕ имеет watchdog asymmetry / cross-session state / zone-of-write enforcement primitives — это наш custom layer. Источник — `docs/architecture/2026-05-23-dev-flow-rca.md`.

3 root cause classes:

1. **Watchdog asymmetry** (C1, C2) — Coder/Reviewer обрываются раньше, чем успевают завершить I/O.
2. **Cross-session state loss** (D1) — ScheduleWakeup / MCP results / worktree state теряются на session boundary.
3. **Implicit zones-of-write** (C3, D2) — Coder перезаписывает PM-scripts, labels отсутствуют без mechanism-level gates.

## When to invoke

- Coder начинает task с > 2 файлами edit
- Reviewer / Legal перед `mcp__github__create_pull_request_review` (любой MCP I/O > 5 сек)
- PM перед `ScheduleWakeup(delay > 1800)` (cross-session ожидание > 30 мин)
- При silent termination diagnosis (Coder завершился без push)
- Перед добавлением нового label которое используется в .md правилах
- При worktree checkout failure (`git checkout BRANCH` падает с "checked out elsewhere")

## Patterns

### C1: Watchdog C1 — chunking + sentinel + intent markers

**Symptom:** Coder читает task → начинает писать → текст обрывается → `git log` worktree пуст. PM ждёт notification, не получает. 200k tokens / 12 мин — typical cutoff.

**Root cause:** Runtime watchdog (Claude harness) убивает stream без graceful shutdown. У Coder'а нет mechanism «flush in progress to disk» перед kill.

**Applied fix (3-layer):**

1. **Chunking (hard rule):** `wip:` push после **каждых 2 файлов ИЛИ 5 минут**. Раньше было 3/30 — слишком мягко, Coder обрывался ДО первого милстоуна.
2. **Sentinel file:** `.claude/tasks/<task>.progress.md` — Coder обновляет `last_update` / `last_commit` / `last_push` после каждого милстоуна. PM при таймауте читает sentinel, видит расхождение `last_update` vs `last_push` → забирает работу из worktree.
3. **Intent markers (opt-in):** Перед длинной операцией (test run > 30 сек, AC start, milestone, rebase, migration) — `bash scripts/coder/coder-intent.sh "<intent>"`. Даёт PM при recovery semantic контекст. Anti-pattern: писать intent на каждый Edit (auto-hook уже покрывает — это spam).

**Recovery:** PM Mode 3 (continuation):

```bash
# 1. Прочитать sentinel
cat .claude/tasks/<task>.progress.md
# 2. Сравнить last_update vs last_push (timestamps)
# 3. Если расхождение > 5 мин → достать незакоммиченную работу
cd <coder-worktree>
git status   # видим untracked / unstaged
# 4. PM либо commits manually либо dispatches Coder retry с context
```

### C2: Watchdog C2 — write-then-post pattern (MCP hang recovery)

**Symptom:** Reviewer-агент завершил анализ, начал `mcp__github__create_pull_request_review`, вызов завис на 10+ минут → watchdog crash → review не появился на PR.

**Root cause:** MCP-вызов = network I/O без timeout-обёртки в agent prompt'е. Если GitHub API hangs (rate limit / network) — agent тоже hangs.

**Applied fix:**

1. Сохранить body в файл **ДО** MCP-вызова.
   ```
   /tmp/reviewer-output/pr-<N>-<TS>.md   — для code-reviewer
   /tmp/security-reviewer-output/pr-<N>-<TS>.md   — для security-reviewer
   /tmp/legal-output/pr-<N>-<TS>.md   — для legal Mode B
   ```
2. **Attempt #1:** MCP (`mcp__github__create_pull_request_review`).
3. **Attempt #2 (fallback):** `gh api repos/.../pulls/N/reviews -X POST -F body=@<file>` через Bash.
4. **Attempt #3 (recovery):** PM достаёт body из файла, постит сам.

**Why this is enough:** root cause в MCP hang, fix не в том чтобы MCP отвечал быстрее (мы не контролируем GitHub), а в том чтобы работа не терялась когда он hangs. Write-then-post — стандартный durable-write pattern.

### C3: Zone-of-write (worktree isolation)

**Symptom:** Coder перезаписывает PM-патчи к `scripts/pm/prep-user-testing.sh`. Coder screenshots появляются в чужих worktree (PR подметал `apps/e2e/debug-*.png` от прошлых AutoTest runs).

**Root cause:** `git add .` / `git add -A` подметает что попало. Coder не имеет mental model «PM-scripts — это not-mine zone».

**Applied fix (Coder-side):**

- В `coder.md` явный список **off-limits zones**:
  - `scripts/pm/**` — PM scripts
  - `scripts/devops/**` — DevOps scripts
  - `.claude/agents/**` — Architect zone (system prompts)
  - `docs/business/**` — BA zone
  - `.github/workflows/**` — DevOps zone
  - `.claude/hooks/**` — DevOps + Architect zone
  - Чужие task-файлы
- В Coder workflow §git: **никогда `git add .`**. Только явный список файлов из task-секции "Конкретные изменения".

**Applied fix (Reviewer-side, mechanism gate):**

- Если diff PR содержит изменения вне zone-of-write Coder'а → Verdict: BLOCK с указанием конкретного файла.
- См. skill `code-review-discipline` §3.

### D1: ScheduleWakeup boundary (cross-session state loss)

**Symptom:** PM ставит `ScheduleWakeup(delay=7200)` ждать GHA E2E. Session завершилась через 30 мин (token cap). Wake-up в 2 часа не fire'ит — потерян. PR висит без действия пока user не пнёт.

**Root cause:** ScheduleWakeup state хранится session-scoped (in-process). Без external scheduler wake-up не переживает crash/timeout source-session.

**Applied fix (2-layer):**

**Layer 1 (in-session, ≤ 30 мин):** `ScheduleWakeup` — для wake-up'ов внутри текущей session.

**Layer 2 (cross-session, > 30 мин или критичных):** `mcp__scheduled-tasks__create_scheduled_task` — external scheduler выживает session boundary.

- PM запускает `scripts/pm/pm-schedule.sh` для подготовки параметров (fireAt, taskId, materialized prompt).
- Потом вызывает MCP-tool.
- Каждый wake-up создаёт fresh PM-сессию с self-contained prompt из `scripts/pm/wakeup-prompts/<template>.md` — нет утечки контекста из source-сессии.

**НЕ смешивать оба слоя на один wait** — это создаёт дубли fire'ов.

**Recovery (Mode 3 catch-up):**

- При старте сессии — PM читает `pm-state.json.active[task].next_action`.
- Если `scheduled_at` старше `max_age_min` → immediate execute (missed wake-up).
- См. `.claude/agents/pm.md` Mode 3.

### D2: Missing label declarative drift

**Symptom:** `pm.md` Mode 2 ссылается на label `ci-failed`, но он не существует в repo. PM пытается читать label, GitHub возвращает 404. PM не реагирует на CI failures автоматически.

**Root cause:** Labels управлялись ad-hoc через `gh label create`. Не было declarative source-of-truth → label был задокументирован в `.md` но не существовал.

**Applied fix:**

- `.github/labels.yml` — declarative source-of-truth для всех labels.
- `.github/workflows/labels-sync.yml` — GHA workflow `crazy-max/ghaction-github-labeler@v5` синхронизирует yml с repo при push в main.

**Decision rule (для PM/DevOps):** Прежде чем ссылаться на label в .md/.sh — добавить его в `.github/labels.yml`. Тестовый CI пройдёт `labels-sync.yml` → label материализуется в repo.

### D3: Conditional AutoTest dispatch (process rigidity)

**Symptom:** Coder в PR добавил полный E2E coverage для AC. PM всё равно диспетчит AutoTest. AutoTest читает spec'ы, видит что покрытие есть → no-op. Потрачено ~10 мин агент-времени.

**Root cause:** Pre-2026-05-23 правило «MUST dispatch AutoTest после Coder» было absolute.

**Applied fix:** Decision table в `pm.md` Mode 2:

| Состояние                                 | Действие      | Reason код                    |
| ----------------------------------------- | ------------- | ----------------------------- |
| Coder не добавил spec'ы + PR трогает apps | MUST dispatch | —                             |
| Coder добавил spec'ы покрывающие AC       | skip          | `coder-added-e2e-covering-ac` |
| PR только docs/business                   | skip          | `no-product-code-changes`     |

**Observability:** skip без event `autotest_skipped` в pm-state.json **запрещён** — без записи = пробел в покрытии.

### D4: Lessons priority (read-side cost)

**Symptom:** 27 уроков в `memory/*/lessons.md` равноправны. Агент при чтении не отличает P0 invariant от P2 optimization.

**Root cause:** Append-md формат оптимизирован под write-side (легко добавить). Read-side cost — агенты читают всё одинаково.

**Applied fix:** Формат `<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic-tag) <урок>`.

**Priority selectors:**

- **P0** — mechanism / safety invariant. Real incident → потеря работы / merge / data. Нарушение = немедленный fix.
- **P1** — process / coverage gap. Может пропустить regression / coverage hole.
- **P2** — optimization. Эффективность / token usage / DX.

**Read pattern:**

```bash
grep '\[P0\]' .claude/agents/memory/coder/lessons.md
```

## Anti-patterns

| ❌ Don't                                                    | ✅ Do                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------- |
| Long Coder work без wip-push (> 5 мин / > 2 файлов)         | wip: push после каждого порога                                                 |
| MCP call без предварительного `Write` файла body            | Write → MCP → gh fallback → PM recovery (chain)                                |
| `ScheduleWakeup(delay > 1800)` для cross-session waits      | `mcp__scheduled-tasks__create_scheduled_task` + self-contained prompt template |
| `git add .` / `git add -A` в Coder workflow                 | Явный список файлов из task spec                                               |
| Ссылка на label в .md без добавления в `.github/labels.yml` | Сначала labels.yml + sync workflow, потом ссылка                               |
| AutoTest skip без записи event в pm-state.json              | Skip + event `autotest_skipped` с reason кодом                                 |
| Append lesson без priority tag                              | `[P0                                                                           | P1                                                                             | P2] [<task-id>] (#tag) <урок>` обязателен |
| Intent marker на каждый Edit                                | Только перед операцией > 30 сек / milestone / risky moment                     |
| `pkill -f vite` для cleanup                                 | `lsof -ti :PORT                                                                | xargs -r kill -TERM` (по порту, не по pattern имени) — для macOS совместимости |
| `git checkout BRANCH` без pre-flight worktree check         | `git worktree list --porcelain` → если есть worktree → `cd` в него             |
| GNU `timeout`/`mktemp` без macOS shim                       | `_timeout` с perl fallback / `/tmp/<prefix>-$$-$RANDOM.<ext>`                  |

## References

- Source RCA: `docs/architecture/2026-05-23-dev-flow-rca.md` (полный D1-D4 + verification + sub-tasks)
- Lifted lessons (2026-06-03):
  - `.claude/agents/memory/coder/lessons.md` — chunking, intent markers, zone-of-write, sentinel
  - `.claude/agents/memory/reviewer/lessons.md` — write-then-post
  - `.claude/agents/memory/pm/lessons.md` — ScheduleWakeup, silent completion, Mode 3 catch-up
  - `.claude/agents/memory/devops/lessons.md` — labels, macOS shims, pkill safety, worktree checkout
- Project scripts:
  - `scripts/coder/coder-intent.sh` (intent marker)
  - `scripts/pm/pm-schedule.sh` (Layer 2 scheduling)
  - `scripts/pm/wakeup-prompts/*.md` (templates for fresh sessions)
- Agent docs:
  - `.claude/agents/coder.md` §7 (chunking), §8 (sentinel), §"Zone-of-write"
  - `.claude/agents/pm.md` Mode 3 (continuation / catch-up)
  - `.claude/agents/code-reviewer.md` §"Write-then-post"
- Related skills:
  - `code-review-discipline` (write-then-post applied to Reviewer)
  - `pm-dispatching` (PM uses Layer 2 scheduling)
