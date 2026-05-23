# Dev-flow Root Cause Analysis — 2026-05-23

**Status:** Implemented (PR `infra/dev-flow-fixes` co-authored DevOps + AI Architect)
**Triggered by:** Session `2026-05-23-projects-senior-share-override` — 3 раунда правок, в каждом всплыли systemic-issues уровня pipeline'а, не feature'а.
**Authors:** DevOps agent (scripts), AI Architect (.md + RCA)

## TL;DR

7 проблем dev-flow → root causes сводятся к **3 классам**:
1. **Watchdog asymmetry** — Coder/Reviewer обрываются раньше, чем успевают завершить I/O (push, MCP post). Корень в harness timeouts, не в логике агентов.
2. **Cross-session state loss** — ScheduleWakeup, MCP results, незакоммиченные worktree files теряются на session boundary. Корень в session-scoped state без durable layer.
3. **Implicit zones-of-write** — Coder перезаписывает PM-scripts, AI-agents используют labels отсутствующие в repo, дисциплина «никогда не add .» не enforced. Корень в текстовых правилах без mechanism-level gates.

Каждый класс получил **частичный фикс в этом PR** (документация, обходные паттерны) + **sub-task для harness/infra-level фиксов** где требуется внешняя интеграция.

---

## Группа C — Coder/Reviewer стабильность

### C1 [P0]. Coder silently завершается без push

**Симптом:** В сессии 2026-05-23 round 1 Coder читал task → начал писать `apps/api/src/projects/projects.service.ts` → текст обрывается на «Let me check the schema...» → `git log` worktree пуст. PM ждёт notification, не получает (worktree alive но idle). 200k tokens / 12 мин — typical cutoff.

**Корневая причина:** Runtime watchdog (Claude harness) убивает stream без graceful shutdown. У Coder'а нет mechanism «flush in progress to disk» перед kill. Результат: работа в memory утеряна.

**Почему текстовые правила (coder.md section 7 "task chunking > 3 files") не работали:**
Threshold «> 3 файлов ИЛИ > 30 мин» был слишком мягкий. Coder не доходил до первого милстоуна на средних задачах (2-3 файла, exploratory чтение схемы съедает 5-10 мин).

**Applied fix (этот PR):**
- `coder.md` секция 7 ужесточена: `wip:` push после **каждых 2 файлов ИЛИ 5 минут** (раньше 3/30).
- `coder.md` секция 8 (новая): sentinel-pattern `<task>.progress.md` — Coder обновляет `last_update`/`last_commit`/`last_push` после каждого милстоуна. PM при таймауте читает sentinel, видит расхождение `last_update` vs `last_push` → забирает работу из worktree.
- `pm/lessons.md` записан P0-урок.

**Open question / follow-up:**
- Hook `.claude/hooks/coder-progress-marker.sh` (PostToolUse Edit/Write) для auto-update sentinel — иначе Coder может забыть руками. Sub-task: `task-coder-watchdog-progress-markers.md`.
- Harness-level fix: graceful SIGTERM перед hard kill чтобы Coder успел `git push`. NEEDS-USER.

### C2 [P1]. Reviewer stall на posting

**Симптом:** Reviewer-агент завершил анализ, начал `mcp__github__create_pull_request_review`, вызов завис на 10+ минут → watchdog crash → review не появился на PR. Тело review было в memory только — потеряно.

**Корневая причина:** MCP-вызов = network I/O без timeout-обёртки в agent prompt'е. Если GitHub API hangs (rate limit / network) — agent тоже hangs. Watchdog убивает обоих.

**Applied fix (этот PR):**
- `reviewer.md` Шаг 4.5: write-then-post pattern. Reviewer **сохраняет body в файл** (`/tmp/reviewer-output/pr-N-TS.md`) ДО MCP-вызова.
- Attempt #1: MCP. Attempt #2 (fallback): `gh api repos/.../pulls/N/reviews` через Bash. Attempt #3 (recovery): PM достаёт body из файла, постит сам.
- Body выживает session crash → manual recovery возможен.

**Why this is enough:** root cause в MCP hang, fix не в том чтобы MCP отвечал быстрее (мы не контролируем GitHub), а в том чтобы работа не терялась когда он hangs. Write-then-post — стандартный durable-write pattern.

### C3 [P2]. Worktree isolation leaks

**Симптомы:**
1. Coder screenshots появляются в чужих worktree (PR подметал `apps/e2e/debug-*.png` от прошлых AutoTest runs — round 4 PR #22).
2. Coder discardит PM-патчи к `scripts/pm/prep-user-testing.sh` («это не настоящий код, могу переписать») — real incident 2026-05-23.

**Корневая причина:** `git add .` / `git add -A` подметает что попало. `.gitignore` ловит свежие файлы, но **уже tracked** файлы — нет. И Coder не имеет mental model «PM-scripts — это not-mine zone».

**Applied fix (этот PR):**
- `coder.md` новая секция «Zone-of-write — что Coder НЕ ТРОГАЕТ»: явный список off-limits zones (`scripts/pm/**`, `scripts/devops/**`, `docs/agents/**`, `docs/business/**`, `.github/workflows/**`, `.claude/hooks/**`, чужие task-файлы).
- `reviewer.md` lesson (P1): если diff содержит изменения вне Coder zone — Verdict: BLOCK.
- `coder/lessons.md` P0-урок про zone-of-write.

**Open question:**
- Hook-level enforcement: hook `block-production-edits.sh` уже блокирует apps/packages в main repo, но в worktree снят. Можно сделать второй hook который check'ит target path vs «coder zone». Сложность: hook видит cwd, не знает зону. Workaround: Reviewer ловит на PR-stage.

---

## Группа D — Оркестрация

### D1 [P0]. ScheduleWakeup не выживает session boundary

**Симптом:** PM ставит `ScheduleWakeup(delay=7200)` ждать GHA E2E (long-running). Session завершилась через 30 мин (token cap / timeout). Wake-up в 2 часа не fire'ит — потерян. PR висит без действия пока user не пнёт.

**Корневая причина:** ScheduleWakeup state хранится session-scoped (in-process). Без external scheduler (Redis queue / cron / database row) wake-up не переживает crash/timeout source-session.

**Applied fix (этот PR):**
- `CLAUDE-pm.md` новая секция «⚠️ ScheduleWakeup limitations»:
  - Использовать ТОЛЬКО для wake-up'ов внутри текущей session (< 30 мин)
  - Для cross-session ожидания — сохранять `next_action` в `pm-state.json.active[task]` (durable)
  - Mode 3 (continuation) — catch-up logic читает `next_action`, если `scheduled_at` старше `max_age_min` → immediate execute
- `pm/lessons.md` записан P0-урок.

**Open question / follow-up:**
- Sub-task `task-harness-schedule-wakeup-persistence.md` (NEEDS-USER) — два варианта:
  a) Persistent ScheduleWakeup через external scheduler (verify `mcp__scheduled-tasks__*` достаточно)
  b) PM использует `mcp__scheduled-tasks__create_scheduled_task` для критичных long-wait'ов
- Это harness/integration level, не AI-agent.

### D2 [P1]. Label `ci-failed` отсутствует в repo

**Симптом:** `pm.md` Mode 2 step 1 имеет строку «PR label `ci-failed` → создать fix-задачу для Coder». PM пытается читать label, GitHub возвращает 404. PM не реагирует на CI failures автоматически.

**Корневая причина:** Labels управлялись вручную через `gh label create` ad-hoc. Не было declarative source-of-truth → label был задокументирован в `.md` но не существовал в repo.

**Applied fix (этот PR):**
- Создан `.github/labels.yml` — declarative source-of-truth для всех 17 labels (включая `ci-failed`).
- `ci-failed` создан в repo через `gh label create` immediate (см. commit body).
- `devops/lessons.md` P0-урок про CI gate.

**Open question / follow-up:**
- Sub-task `task-infra-labels-yml-sync.md` для DevOps: GHA workflow `crazy-max/ghaction-github-labeler@v5` синхронизирующий yml с repo при push в main. Чтобы дальше когда yml меняется — repo автоматически следует.

### D3 [P2]. AutoTest dispatch redundant

**Симптом:** Coder в PR добавил полный E2E coverage для AC. PM всё равно диспетчит AutoTest. AutoTest читает spec'ы, видит что покрытие есть → no-op. Потрачено ~10 мин агент-времени, токены.

**Корневая причина:** Pre-2026-05-23 правило «MUST dispatch AutoTest после Coder» было absolute. Не было mechanism «проверь покрытие до dispatch».

**Applied fix (этот PR):**
- `pm.md` Mode 2 — условный диспетч с decision table:
  - Coder не добавил spec'ы + PR трогает apps → MUST dispatch
  - Coder добавил spec'ы покрывающие AC → skip, event `autotest_skipped` reason="coder-added-e2e-covering-ac"
  - PR только docs/business → skip, reason="no-product-code-changes"
- `autotest.md` обновлён — skip это нормально.
- Observability сохраняется: skip без события всё равно запрещён.

**Why this is enough:** D3 — efficiency improvement, не safety. Coverage гарантия от Reviewer (он проверит AC в коде) + AutoTest fallback если coverage недостаточный.

### D4 [P2]. Memory lessons.md без приоритетного шаблона

**Симптом:** 27 уроков в `memory/*/lessons.md` равноправны. P0 правило «sequence intent ≠ approval» (real incident → потерянный merge) лежит рядом с P2 «delay:null для userEvent» (test-stability). Агент при чтении не отличает.

**Корневая причина:** Append-md формат изначально оптимизирован под write-side (легко добавить). Read-side имеет cost — агенты читают всё одинаково.

**Applied fix (этот PR):**
- `memory/README.md` обновлён: новый формат `<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic-tag) <урок>`.
- Rule-of-thumb селекторы для приоритета (mechanism/safety = P0, process = P1, optimization = P2).
- Все 27 существующих уроков retro-tagged + 7 новых уроков от dev-flow-rca добавлены.

**Why markdown a не YAML/JSON (архитектурный вопрос Q4):**
Тестировал mental model. Markdown:
- Plus: human-readable, easy grep (`grep '\[P0\]' lessons.md`), append-friendly (PM пишет одну строку).
- Minus: нет schema validation, нет structured queries.

YAML/JSON:
- Plus: queryable (jq, structured agents).
- Minus: harder write (PM должен формировать структуру), хуже git diff readability.

Решение: markdown + tag-prefix даёт **read-side** queryability через grep с минимальной write-side нагрузкой. Если в будущем потребуются queries сложнее `grep "[P0] #review-gate"` — переход на YAML.

---

## Архитектурные вопросы — ответы

### Q1: Single source of truth для PM-only scripts

**Проблема:** Coder перезаписывает scripts/pm/prep-user-testing.sh потому что нет mental model «это не моя зона».

**Решение (применено):**
- Zone-of-write секция в `coder.md` — explicit off-limits list.
- Reviewer ловит violations на PR-stage с Verdict: BLOCK.

**Что НЕ применили (рассмотрено):**
- File-level header marker (`# PM-MANAGED — Coder do not edit`) — fragile, Coder может проигнорировать.
- File ownership через CODEOWNERS — applies to PR review, не предотвращает edit. Полезно дополнительно.
- Filesystem permissions — overhead в dev-env, ломает worktrees.

**Open:** CODEOWNERS на `scripts/pm/`, `docs/agents/`, etc. — добавить в follow-up sub-task для DevOps.

### Q2: User Testing flow — hot-reload vs production rebuild?

**Текущее (после PR #37 + DevOps в этом PR):** production rebuild (vite preview). Tunnel через Serveo.

**Trade-offs:**
- Production build = +30-40 сек на каждый цикл, но runtime через tunnel стабильный (minified bundle, no HMR socket).
- Dev hot-reload = instant code changes, но через tunnel грузятся сотни unbundled модулей + HMR socket flakes на мобильнике.

**Решение: оставляем production build.** Причины:
1. User Testing цикл — раз в N часов (после batch правок), не каждые 30 сек. 30-40 сек overhead — терпимо.
2. Tunnel reliability critical — User Testing на phone обязателен, если страница не грузится через tunnel → весь шаг fail.
3. Dev mode подходит для локальной разработки самого dev'а, не для shareable User Testing URL.

**Compromise:** `SKIP_TUNNEL=1` env позволяет dev'у запустить локально без tunnel (быстрее) если phone testing не нужен в этот заход.

### Q3: Coder built-in retry self-check

**Решение (применено):** Sentinel-pattern `<task>.progress.md` (см. C1) — Coder декларирует прогресс в durable файл, PM использует для recovery.

**Что НЕ применили:**
- Built-in retry внутри Coder session — невозможно, обрыв = death of session.
- Watchdog в самой Coder-логике (timer + flush) — добавляет complexity без гарантии (watchdog тоже подвержен kill).

**Why sentinel достаточно:** Recovery моделируется на PM-side (не Coder-side). PM это external observer — он выживает Coder crash. Coder заявляет прогресс → PM использует если Coder die.

### Q4: PM memory — structured (YAML/JSON) vs append-md?

**Решение (применено):** markdown + tag prefix (см. D4). Это даёт 80% queryability YAML за 20% complexity.

**Triggers для миграции на YAML/JSON в будущем:**
- > 100 уроков в одном файле (сейчас 5 файлов × 4-9 уроков)
- Need для cross-agent queries (e.g., "все P0 уроки про #worktree across all agents")
- Need для structured fields (e.g., resolution_pr_link, related_task_ids)

---

## Сводная таблица

| Problem | Priority | Root cause class | Applied fix | Sub-task (follow-up) |
|---|---|---|---|---|
| C1 silent termination | P0 | Watchdog asymmetry | coder.md ужесточил chunking + sentinel; pm.md recovery | task-coder-watchdog-progress-markers.md |
| C2 Reviewer post stall | P1 | Watchdog asymmetry | reviewer.md write-then-post + gh fallback | — (self-contained) |
| C3 worktree leaks | P2 | Implicit zones | coder.md zone-of-write + reviewer check | (CODEOWNERS опционально) |
| D1 ScheduleWakeup loss | P0 | Cross-session state loss | CLAUDE-pm.md limits + workaround pattern | task-harness-schedule-wakeup-persistence.md |
| D2 ci-failed label missing | P1 | Declarative drift | .github/labels.yml + label created | task-infra-labels-yml-sync.md |
| D3 AutoTest redundant | P2 | Process rigidity | pm.md conditional dispatch | — (self-contained) |
| D4 lessons priority | P2 | Read-side cost | memory/README.md priority schema + retro-tag | — (self-contained) |

## Verification

- Все 7 проблем имеют либо applied fix, либо sub-task с обоснованием почему out-of-scope.
- `pnpm typecheck` / `pnpm lint` зелёные — изменения только в .md/.yml (DevOps подтвердил для .sh).
- 3 sub-tasks созданы (см. `docs/specs/tasks/task-{infra-labels-yml-sync,harness-schedule-wakeup-persistence,coder-watchdog-progress-markers}.md`).

## Lessons distilled

- **Текстовое правило в .md без mechanism = aspiration.** Coder ignored task-файл с «git diff верификация перед каждым commit» — потребовался hook `coder-pre-push.sh`. То же про zone-of-write: Reviewer mechanism на PR stage обязателен.
- **Session boundary — first-class concern.** Любой state нужный после boundary — durable (file/db/external scheduler). In-memory state = lost.
- **Watchdog без graceful shutdown ломает invariants.** Решение для AI-agents — durable progress markers (sentinel files) перед каждой milestone, не полагаться на in-memory state survival.
